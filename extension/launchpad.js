// MyDock - Launchpad. Our own full-screen launcher (not GNOME's app grid): blurred wallpaper,
// a search field on top, 7 x 5 pages of big icons with page dots, paging by scroll, swipe,
// arrow keys or the dots, zoom in on open and out on close. Panel and dock stay above it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const COLS = 7;
const ROWS = 5;
const PER_PAGE = COLS * ROWS;
const OPEN_MS = 260;
const PAGE_MS = 320;
const SWIPE_PX = 60;        // horizontal drag that flips a page
const SEARCH_H = 72;        // band for the search field under the panel
const DOTS_H = 40;          // band for the page dots
const SEARCH_W = 420;
const ZOOM = 1.1;           // content scale at the start of open / end of close

const center = () => new Graphene.Point({x: 0.5, y: 0.5});

export class Launchpad {
    constructor(ext) {
        this._ext = ext;
        this._actor = null;
        this._visible = [];
        Shell.AppSystem.get_default().connectObject('installed-changed', () => (this._appCache = null), this);
        Main.wm.addKeybinding('launchpad-hotkey', ext.settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this.toggle());
    }

    // Sorted visible apps, cached until the installed set changes (no re-scan on every open).
    _appList() {
        if (!this._appCache) {
            const appSys = Shell.AppSystem.get_default();
            this._appCache = appSys.get_installed()
                .filter(info => info.should_show())
                .map(info => appSys.lookup_app(info.get_id()))
                .filter(Boolean)
                .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        }
        return this._appCache;
    }

    get active() {
        return !!this._actor;
    }

    toggle() {
        if (this._actor)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._actor)
            return;
        Main.overview.hide();
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        this._mon = mon;

        this._actor = new St.Widget({
            style_class: 'mydock-launchpad',
            reactive: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
            opacity: 0,
        });

        // blurred, dimmed wallpaper (does not zoom)
        const bg = new St.Widget({width: mon.width, height: mon.height});
        this._bgManager = new Background.BackgroundManager({container: bg, monitorIndex: mon.index, vignette: false});
        bg.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 60, brightness: 0.6}));
        this._actor.add_child(bg);

        this._content = new St.Widget({width: mon.width, height: mon.height, pivot_point: center()});
        this._actor.add_child(this._content);

        const panelH = Main.panel?.visible ? Main.panel.height : 0;
        const bar = this._ext.dock?._bars?.[0];
        const dockH = bar && !bar.hidden ? bar.geom.H + bar.geom.E : 0;

        this._search = new St.Entry({
            style_class: 'mydock-launchpad-search',
            hint_text: 'Search',
            can_focus: true,
            width: SEARCH_W,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'mydock-launchpad-search-icon'}),
        });
        this._content.add_child(this._search);
        this._search.clutter_text.connect('text-changed', () => this._filter());
        this._search.clutter_text.connect('activate', () => this._visible[0]?.launch());
        this._search.clutter_text.connect('key-press-event', (_a, ev) => this._onKey(ev));
        const [, sh] = this._search.get_preferred_height(SEARCH_W);
        this._search.set_position(Math.round((mon.width - SEARCH_W) / 2), Math.round(panelH + (SEARCH_H - sh) / 2));

        // pages sit side by side in a strip that slides inside a clipped viewport
        const top = panelH + SEARCH_H;
        this._grid = {
            x: Math.round(mon.width * 0.06),
            y: top,
            width: Math.round(mon.width * 0.88),
            height: Math.max(ROWS * 60, mon.height - top - DOTS_H - dockH - 8),
        };
        const g = this._grid;
        this._viewport = new St.Widget({clip_to_allocation: true, reactive: true, x: g.x, y: g.y, width: g.width, height: g.height});
        this._strip = new St.Widget({reactive: true});
        this._viewport.add_child(this._strip);
        this._content.add_child(this._viewport);

        this._dots = new St.BoxLayout({style_class: 'mydock-launchpad-dots'});
        this._content.add_child(this._dots);
        this._dotsY = g.y + g.height + Math.round((DOTS_H - 8) / 2);

        // icon fills ~60% of the shorter cell side, the label goes under it
        this._iconSize = Math.max(48, Math.min(128, Math.round(Math.min(g.width / COLS, g.height / ROWS) * 0.6)));

        this._apps = this._appList();
        this._tiles = new Map(this._apps.map(app => [app, this._buildTile(app)]));
        this._page = 0;
        this._filter();

        this._actor.connect('button-press-event', (_a, ev) => this._onPress(ev));
        this._actor.connect('button-release-event', (_a, ev) => this._onRelease(ev));
        this._actor.connect('scroll-event', (_a, ev) => this._onScroll(ev));
        this._actor.connect('key-press-event', (_a, ev) => this._onKey(ev));

        // above the windows, below the panel and the dock
        Main.uiGroup.insert_child_above(this._actor, global.window_group);
        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            // another modal owns the keyboard: back out instead of opening half working
            Main.popModal(this._grab);
            this._grab = null;
            this._destroyActor();
            return;
        }
        this._search.grab_key_focus();

        this._content.set_scale(ZOOM, ZOOM);
        this._actor.ease({opacity: 255, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._content.ease({scale_x: 1, scale_y: 1, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    close() {
        if (!this._actor || this._closing)
            return;
        this._closing = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._content.ease({scale_x: ZOOM, scale_y: ZOOM, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_IN_CUBIC});
        this._actor.ease({
            opacity: 0,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this._destroyActor(),
        });
    }

    _destroyActor() {
        this._bgManager?.destroy();
        this._bgManager = null;
        this._actor?.destroy();
        this._actor = this._content = this._search = this._viewport = this._strip = this._dots = null;
        this._tiles = null;
        this._apps = [];
        this._visible = [];
        this._closing = false;
    }

    _buildTile(app) {
        const tile = new St.Button({style_class: 'mydock-launchpad-tile', can_focus: true, reactive: true});
        const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const gicon = this._ext.iconOverride?.(app.get_id());
        const icon = gicon
            ? new St.Icon({gicon, icon_size: this._iconSize})
            : app.create_icon_texture(this._iconSize);
        const iconBin = new St.Bin({child: icon, style_class: 'mydock-launchpad-icon', pivot_point: center()});
        box.add_child(iconBin);
        const label = new St.Label({text: app.get_name(), style_class: 'mydock-launchpad-label', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        tile.set_child(box);
        tile.launch = () => {
            app.activate();
            this.close();
        };
        tile.connect('clicked', () => {
            if (!this._swiped)
                tile.launch();
        });
        tile.connect('notify::pressed', () => iconBin.ease({
            scale_x: tile.pressed ? 0.9 : 1,
            scale_y: tile.pressed ? 0.9 : 1,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }));
        return tile;
    }

    // Lay the matching apps out into pages of COLS x ROWS.
    _filter() {
        const q = this._search.get_text().trim().toLowerCase();
        const match = app => app.get_name().toLowerCase().includes(q) ||
            (app.get_app_info()?.get_keywords?.() ?? []).some(k => k.toLowerCase().includes(q));
        this._visible = (q ? this._apps.filter(match) : this._apps).map(a => this._tiles.get(a));

        for (const t of this._strip.get_children())
            this._strip.remove_child(t);
        const {width: W, height: H} = this._grid;
        const cw = W / COLS, ch = H / ROWS;
        this._visible.forEach((tile, i) => {
            const page = Math.floor(i / PER_PAGE);
            const k = i % PER_PAGE;
            tile.set_position(Math.round(page * W + (k % COLS) * cw), Math.round(Math.floor(k / COLS) * ch));
            tile.set_size(Math.floor(cw), Math.floor(ch));
            this._strip.add_child(tile);
        });
        this._pages = Math.max(1, Math.ceil(this._visible.length / PER_PAGE));
        this._strip.set_size(this._pages * W, H);
        this._buildDots();
        this._goto(q ? 0 : this._page, false);
    }

    _buildDots() {
        this._dots.destroy_all_children();
        for (let i = 0; this._pages > 1 && i < this._pages; i++) {
            const dot = new St.Button({style_class: 'mydock-launchpad-dot', can_focus: false});
            dot.connect('clicked', () => this._goto(i, true));
            this._dots.add_child(dot);
        }
        const [, w] = this._dots.get_preferred_width(-1);
        this._dots.set_position(Math.round((this._mon.width - w) / 2), this._dotsY);
    }

    _goto(page, animate) {
        this._page = Math.max(0, Math.min(this._pages - 1, page));
        this._dots.get_children().forEach((d, i) => {
            if (i === this._page)
                d.add_style_pseudo_class('checked');
            else
                d.remove_style_pseudo_class('checked');
        });
        const x = -this._page * this._grid.width;
        this._strip.remove_transition('translation-x');
        if (animate)
            this._strip.ease({translation_x: x, duration: PAGE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this._strip.translation_x = x;
    }

    _onPress(ev) {
        if (ev.get_button() === Clutter.BUTTON_PRIMARY)
            [this._pressX] = ev.get_coords();
        this._swiped = false;
        return Clutter.EVENT_PROPAGATE;
    }

    _onRelease(ev) {
        if (this._pressX === undefined)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = ev.get_coords();
        const dx = x - this._pressX;
        this._pressX = undefined;
        if (Math.abs(dx) > SWIPE_PX) {
            this._swiped = true;    // the tile under the release must not launch
            this._goto(this._page + (dx < 0 ? 1 : -1), true);
            return Clutter.EVENT_STOP;
        }
        // click on empty space closes, like macOS
        const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (hit === this._actor || hit === this._viewport || hit === this._strip)
            this.close();
        return Clutter.EVENT_PROPAGATE;
    }

    _onScroll(ev) {
        // one page per gesture: ignore the burst of events right after a flip
        const now = GLib.get_monotonic_time();
        if (now - (this._lastScroll ?? 0) < 350000)
            return Clutter.EVENT_STOP;
        let step = 0;
        switch (ev.get_scroll_direction()) {
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = ev.get_scroll_delta();
            const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(d) >= 0.5)
                step = d > 0 ? 1 : -1;
            break;
        }
        }
        if (step) {
            this._lastScroll = now;
            this._goto(this._page + step, true);
        }
        return Clutter.EVENT_STOP;
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            if (this._search.get_text())
                this._search.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        // arrows page only while the search field is empty (otherwise they move the cursor)
        if (!this._search.get_text()) {
            if (sym === Clutter.KEY_Right || sym === Clutter.KEY_Page_Down) {
                this._goto(this._page + 1, true);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Left || sym === Clutter.KEY_Page_Up) {
                this._goto(this._page - 1, true);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        Shell.AppSystem.get_default().disconnectObject(this);
        this._appCache = null;
        Main.wm.removeKeybinding('launchpad-hotkey');
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._destroyActor();
    }
}
