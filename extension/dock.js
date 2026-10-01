// MyDock - the dock. One DockBar per monitor, all fed by the same app list.
// Magnification is done with set_scale + translation_x only (no relayout),
// driven by a per-frame timeline that eases current values toward targets.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

// Changing any of these rebuilds the bars; blur/opacity only restyle.
const REBUILD_KEYS = [
    'icon-size', 'max-size', 'magnify', 'icon-space', 'edge-distance', 'autohide',
    'multi-monitor', 'show-launchpad', 'show-trash', 'show-calendar', 'show-clock',
    'show-running-dots', 'theme-path',
];

const BLUR_BANDS = 6;       // blur bands per rounded corner (see restyle)
const HIDE_DELAY = 400; // ms before intellihide re-evaluates after pointer leaves
const CALENDAR_ID = 'org.gnome.Calendar.desktop';
const CLOCKS_ID = 'org.gnome.clocks.desktop';

function appFromSource(source) {
    return source?.app instanceof Shell.App ? source.app : null;
}

// A dock icon: St.Button holding a fixed S x S slot with an M x M icon actor
// scaled down to S (so magnification up to M stays crisp) and a running dot below.
const DockItem = GObject.registerClass(
class DockItem extends St.Button {
    _init(bar, iconActor, {app = null, label = '', onClick = null, buildMenu = null}) {
        super._init({
            style_class: 'mydock-item',
            reactive: true,
            track_hover: true,
            can_focus: false,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
        });
        this._bar = bar;
        this.app = app;
        this.labelText = label; // not `label`: that is an St.Button property
        this._onClick = onClick;
        this._buildMenu = buildMenu;
        this.pinned = false;
        this.scaleCur = 1;
        this.shift = 0;

        const {S, M, P} = bar.geom;
        const slot = new St.Widget({width: S, height: S});
        this._icon = iconActor;
        this._icon.reactive = true; // so the magnified part outside the slot is pickable
        this._icon.set_size(M, M);
        this._icon.set_position((S - M) / 2, S - M);
        this._icon.set_pivot_point(0.5, 1);
        this._icon.set_scale(S / M, S / M);
        slot.add_child(this._icon);

        this._dot = new St.Widget({
            style_class: 'mydock-dot',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const dotRow = new St.Bin({height: P, child: this._dot});

        const col = new St.BoxLayout({vertical: true});
        col.add_child(slot);
        col.add_child(dotRow);
        this.set_child(col);

        this.connect('clicked', (_b, button) => this._clicked(button));
        this.connect('notify::hover', () => bar.onItemHover(this));

        if (app && !app.is_window_backed()) {
            this._delegate = this;
            this._draggable = DND.makeDraggable(this);
            this._draggable.connect('drag-begin', () => {
                this.fake_release();
                bar.hideLabel();
                this.opacity = 90;
                bar.dock.setDragging(true);
            });
            this._draggable.connect('drag-cancelled', () => bar.dock.onDragCancelled(this));
            this._draggable.connect('drag-end', () => {
                this.opacity = 255;
                bar.dock.clearDropGaps();
                bar.dock.setDragging(false);
            });
        }
        this.connect('destroy', () => {
            this._menu?.destroy();
            this._menu = null;
            this._bouncing = false;
            this._gone = true;
        });
        this.sync();
    }

    get icon() {
        return this._icon;
    }

    get menuOpen() {
        return !!this._menu?.isOpen;
    }

    applyScale(s) {
        const k = this._bar.geom.S / this._bar.geom.M * s;
        this._icon.set_scale(k, k);
    }

    // DND source interface
    getDragActor() {
        const {S} = this._bar.geom;
        const gicon = this._bar.dock.ext.iconOverride(this.app.get_id());
        return gicon ? new St.Icon({gicon, icon_size: S}) : this.app.create_icon_texture(S);
    }

    getDragActorSource() {
        return this._icon;
    }

    sync() {
        if (!this.app)
            return;
        const settings = this._bar.dock.ext.settings;
        this._dot.visible = settings.get_boolean('show-running-dots') &&
            this.app.state !== Shell.AppState.STOPPED;
        if (this.app.state === Shell.AppState.STARTING && settings.get_boolean('bounce-on-launch'))
            this._bounce();
    }

    _bounce() {
        if (this._bouncing)
            return;
        this._bouncing = true;
        const h = this._bar.geom.S * 0.45;
        // an interrupted ease (unmap, replaced transition) never completes: always land back at 0
        const reset = () => {
            this._bouncing = false;
            if (this._gone)
                return;
            if (this._icon.mapped)
                this._icon.ease({translation_y: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                this._icon.translation_y = 0;
        };
        const step = () => {
            if (!this._bouncing || this.app.state !== Shell.AppState.STARTING) {
                reset();
                return;
            }
            this._icon.ease({
                translation_y: -h,
                duration: 280,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: up => (up ? this._icon.ease({
                    translation_y: 0,
                    duration: 280,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onStopped: down => (down ? step() : reset()),
                }) : reset()),
            });
        };
        step();
    }

    _clicked(button) {
        this._bar.hideLabel();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._popupMenu();
            return;
        }
        if (this._onClick) {
            this._onClick(button);
            return;
        }
        if (this.app)
            this._activateApp(button);
    }

    _activateApp(button) {
        const app = this.app;
        if (button === Clutter.BUTTON_MIDDLE && app.can_open_new_window()) {
            app.open_new_window(-1);
            Main.overview.hide();
            return;
        }
        if (app.state === Shell.AppState.RUNNING && !Main.overview.visible) {
            const focused = global.display.focus_window;
            const focusedApp = focused && Shell.WindowTracker.get_default().get_window_app(focused);
            if (focusedApp === app) {
                const ws = global.workspace_manager.get_active_workspace();
                const wins = app.get_windows().filter(w => w.get_workspace() === ws && w.can_minimize());
                if (wins.length) {
                    wins.forEach(w => w.minimize());
                    return;
                }
            }
        }
        app.activate();
        Main.overview.hide();
    }

    _popupMenu() {
        if (!this._menu) {
            if (this.app) {
                this._menu = new AppMenu(this, St.Side.BOTTOM, {favoritesSection: true, showSingleWindows: true});
                this._menu.setApp(this.app);
            } else if (this._buildMenu) {
                this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
                this._buildMenu(this._menu);
            } else {
                return;
            }
            if (this.app) {
                this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._sepItem = this._menu.addAction('Add Separator After',
                    () => this._bar.dock.addSeparator(this.app.get_id()));
            }
            this._menu.actor.add_style_class_name('mydock-menu');
            this._menu.connect('open-state-changed', () => this._bar.dock.queueHideCheck());
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._menuManager = new PopupMenu.PopupMenuManager(this);
            this._menuManager.addMenu(this._menu);
        }
        if (this._sepItem) {
            this._sepItem.visible = this.pinned &&
                !this._bar.dock.ext.settings.get_strv('dock-separators').includes(this.app.get_id());
        }
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }
});

// User separator placed after the pinned app `anchor`. Drag to move, drag off the dock or
// right-click > Remove to delete. Positions live in the `dock-separators` setting.
const DockSeparator = GObject.registerClass(
class DockSeparator extends St.Widget {
    _init(bar, anchor) {
        super._init({
            style_class: 'mydock-user-separator',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._bar = bar;
        this.anchor = anchor;
        this.shift = 0;
        // the line is 1px; its CSS margins make the grab area
        this.add_child(new St.Widget({style_class: 'mydock-separator', height: Math.round(bar.geom.S * 0.8)}));

        this._delegate = this;
        this._draggable = DND.makeDraggable(this);
        this._draggable.connect('drag-begin', () => {
            bar.hideLabel();
            this.opacity = 90;
            bar.dock.setDragging(true);
        });
        this._draggable.connect('drag-cancelled', () => bar.dock.onDragCancelled(this));
        this._draggable.connect('drag-end', () => {
            this.opacity = 255;
            bar.dock.clearDropGaps();
            bar.dock.setDragging(false);
        });
        this.connect('button-release-event', (_a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._popupMenu();
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => {
            this._menu?.destroy();
            this._menu = null;
        });
    }

    get menuOpen() {
        return !!this._menu?.isOpen;
    }

    getDragActor() {
        return new St.Widget({style_class: 'mydock-separator', height: Math.round(this._bar.geom.S * 0.8)});
    }

    _popupMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
            this._menu.addAction('Remove Separator', () => this._bar.dock.removeSeparator(this.anchor));
            this._menu.actor.add_style_class_name('mydock-menu');
            this._menu.connect('open-state-changed', () => this._bar.dock.queueHideCheck());
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._menuManager = new PopupMenu.PopupMenuManager(this);
            this._menuManager.addMenu(this._menu);
        }
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }
});

// Live calendar icon: day of week + day number.
function makeCalendarIcon(M) {
    const w = new St.BoxLayout({style_class: 'mydock-calendar', vertical: true,
        style: `border-radius: ${Math.round(M * 0.22)}px; padding-top: ${Math.round(M * 0.05)}px;`});
    const dow = new St.Label({style_class: 'mydock-calendar-dow', x_align: Clutter.ActorAlign.CENTER,
        style: `font-size: ${Math.round(M * 0.17)}px;`});
    const day = new St.Label({style_class: 'mydock-calendar-day', x_align: Clutter.ActorAlign.CENTER,
        y_expand: true, y_align: Clutter.ActorAlign.CENTER, style: `font-size: ${Math.round(M * 0.48)}px;`});
    w.add_child(dow);
    w.add_child(day);
    w.update = () => {
        const now = GLib.DateTime.new_now_local();
        const d = `${now.get_day_of_month()}`;
        if (d === day.text)
            return; // only relayout when the day changes
        dow.text = now.format('%a').toUpperCase();
        day.text = d;
    };
    w.update();
    return w;
}

// Rounded square app tile, inset like themed icons so it lines up with its neighbours.
// Leaves the cairo origin at the tile center and returns the tile size.
function drawTile(cr, w, h, top, bottom) {
    const s = Math.min(w, h) * 0.88;
    const x = (w - s) / 2, y = (h - s) / 2, r = s * 0.22;
    cr.newSubPath();
    cr.arc(x + s - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + s - r, y + s - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + s - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    const g = new Cairo.LinearGradient(0, y, 0, y + s);
    g.addColorStopRGB(0, ...top);
    g.addColorStopRGB(1, ...bottom);
    cr.setSource(g);
    cr.fill();
    cr.translate(w / 2, h / 2);
    return s;
}

// Launchpad icon: white rocket flying up-right on a navy tile.
function makeLaunchpadIcon() {
    const area = new St.DrawingArea({style_class: 'mydock-launchpad-icon'});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const s = drawTile(cr, w, h, [0.16, 0.33, 0.68], [0.05, 0.16, 0.42]);
        cr.rotate(Math.PI / 4);
        cr.scale(s, s);
        cr.setSourceRGBA(1, 1, 1, 1);
        // body
        cr.moveTo(0, -0.36);
        cr.curveTo(0.13, -0.26, 0.14, -0.06, 0.1, 0.14);
        cr.lineTo(-0.1, 0.14);
        cr.curveTo(-0.14, -0.06, -0.13, -0.26, 0, -0.36);
        cr.fill();
        // fins
        for (const d of [-1, 1]) {
            cr.moveTo(d * 0.1, -0.02);
            cr.lineTo(d * 0.21, 0.12);
            cr.lineTo(d * 0.2, 0.22);
            cr.lineTo(d * 0.08, 0.14);
            cr.closePath();
            cr.fill();
        }
        // exhaust
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.moveTo(-0.06, 0.18);
        cr.lineTo(0.06, 0.18);
        cr.lineTo(0, 0.33);
        cr.closePath();
        cr.fill();
        // window
        cr.setSourceRGBA(0.1, 0.24, 0.55, 1);
        cr.arc(0, -0.12, 0.045, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    });
    return area;
}

// Live analog clock icon: black face with white numerals on a dark tile, orange seconds hand.
function makeClockIcon() {
    const area = new St.DrawingArea({style_class: 'mydock-clock'});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const s = drawTile(cr, w, h, [0.2, 0.2, 0.21], [0.1, 0.1, 0.11]);
        const r = s * 0.45;
        const now = GLib.DateTime.new_now_local();
        cr.arc(0, 0, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fill();

        cr.setSourceRGBA(1, 1, 1, 1);
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(r * 0.3);
        for (let n = 1; n <= 12; n++) {
            const a = n * Math.PI / 6;
            const t = cr.textExtents(`${n}`);
            cr.moveTo(Math.sin(a) * r * 0.78 - t.width / 2 - t.xBearing,
                -Math.cos(a) * r * 0.78 - t.height / 2 - t.yBearing);
            cr.showText(`${n}`);
        }

        cr.setLineCap(Cairo.LineCap.ROUND);
        const hand = (angle, len, width, tail = 0) => {
            cr.setLineWidth(r * width);
            cr.moveTo(-Math.sin(angle) * r * tail, Math.cos(angle) * r * tail);
            cr.lineTo(Math.sin(angle) * r * len, -Math.cos(angle) * r * len);
            cr.stroke();
        };
        const min = now.get_minute();
        hand((now.get_hour() % 12 + min / 60) * Math.PI / 6, 0.45, 0.09);
        hand((min + now.get_second() / 60) * Math.PI / 30, 0.72, 0.07);
        cr.setSourceRGBA(1, 0.58, 0, 1);
        hand(now.get_second() * Math.PI / 30, 0.8, 0.025, 0.2);
        cr.arc(0, 0, r * 0.07, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.arc(0, 0, r * 0.03, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    });
    area.update = () => area.queue_repaint();
    return area;
}

function launchAppId(id) {
    const app = Shell.AppSystem.get_default().lookup_app(id);
    if (app) {
        app.activate();
        Main.overview.hide();
    }
}

// One dock on one monitor.
class DockBar {
    constructor(dock, monitor) {
        this.dock = dock;
        this.monitor = monitor;
        const s = dock.ext.settings;
        const S = s.get_int('icon-size');
        const M = s.get_boolean('magnify') ? Math.max(S, s.get_int('max-size')) : S;
        const P = Math.round(S * 0.1) + 4;
        const sp = s.get_int('icon-space');
        const E = s.get_int('edge-distance');
        this.geom = {S, M, P, sp, E, H: S + 2 * P};
        this.autohide = s.get_boolean('autohide');
        this.hidden = false;
        this._items = new Map(); // app id -> DockItem
        this._seps = new Map(); // anchor app id -> DockSeparator
        this._specials = [];
        this._pointerX = null;
        this._dropIndex = null;
        this._gapCur = 0;
        this._hoverItem = null;

        // Full monitor width, transparent, non-reactive: only the box and icons take input.
        this.actor = new St.Widget({
            name: 'mydock',
            style_class: 'mydock',
            reactive: false,
            layout_manager: new Clutter.BinLayout(),
            x: monitor.x,
            y: monitor.y + monitor.height - this.geom.H - E,
            width: monitor.width,
            height: this.geom.H + E,
        });

        // placed by _frame() from the box allocation (fixed position, natural size)
        this._bg = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._tint = new St.Widget({style_class: 'mydock-bg', x_expand: true, y_expand: true});
        // the corner radius comes from the theme, which may resolve after the first layout
        this._tint.connect('style-changed', () => {
            this._blurKey = null;
            this._layoutBlur();
        });
        this._bg.add_child(this._tint);
        this.actor.add_child(this._bg);

        this.box = new St.BoxLayout({
            style_class: 'mydock-box',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            height: this.geom.H,
            style: `spacing: ${sp}px; padding: ${P}px ${P}px 0 ${P}px;`,
        });
        this.box._delegate = this;
        this.actor.add_child(this.box);

        // Background follows the box from _frame(). Not BindConstraints: _bg is allocated before
        // the box, so a relayout bound it to the box's stale allocation and it stayed off to the side.
        this.box.connect('notify::allocation', () => {
            const b = this.box;
            const key = `${b.x},${b.y},${b.width},${b.height}`;
            if (key !== this._boxKey) {
                this._boxKey = key;
                this._kick();
            }
        });

        this.box.connect('motion-event', (_a, ev) => {
            const [x, y] = ev.get_coords();
            [, this._pointerX] = this.box.transform_stage_point(x, y);
            this._kick();
            return Clutter.EVENT_PROPAGATE;
        });
        this.box.connect('notify::hover', () => {
            if (!this.box.hover)
                this._pointerX = null;
            this._kick();
            this.dock.queueHideCheck();
        });

        this._label = new St.Label({style_class: 'mydock-label', visible: false});
        Main.uiGroup.add_child(this._label);

        this._timeline = new Clutter.Timeline({actor: this.box, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => {
            if (this._frame())
                this._timeline.stop();
        });

        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: !this.autohide,
            trackFullscreen: true,
        });

        if (this.autohide) {
            // 1px reactive strip at the bottom edge reveals the hidden dock.
            this._strip = new St.Widget({reactive: true, track_hover: true, height: 1});
            Main.layoutManager.addChrome(this._strip, {affectsStruts: false, trackFullscreen: true});
            this._strip.connect('notify::hover', () => {
                if (this._strip.hover)
                    this.setHidden(false);
                this.dock.queueHideCheck();
            });
            this.box.connect('notify::allocation', () => this._placeStrip());
        }

        this._buildSpecials();
        this.restyle();
    }

    get hovered() {
        return this.box.hover || !!this._strip?.hover ||
            [...this._items.values(), ...this._specials, ...this._seps.values()].some(i => i.menuOpen);
    }

    _buildSpecials() {
        const s = this.dock.ext.settings;
        const ext = this.dock.ext;
        const {M} = this.geom;
        const themed = (id, names) => new St.Icon({gicon: ext.iconOverride(id) ?? new Gio.ThemedIcon({names}), icon_size: M});

        if (s.get_boolean('show-launchpad')) {
            const gicon = ext.iconOverride('launchpad');
            const icon = gicon ? new St.Icon({gicon, icon_size: M}) : makeLaunchpadIcon();
            this._specials.push(new DockItem(this, icon, {
                label: 'Launchpad',
                onClick: () => ext.launchpad?.toggle(),
            }));
        }
        if (s.get_boolean('show-calendar')) {
            this._calendar = makeCalendarIcon(M);
            this._specials.push(new DockItem(this, this._calendar, {
                label: 'Calendar',
                onClick: () => launchAppId(CALENDAR_ID),
            }));
        }
        if (s.get_boolean('show-clock')) {
            this._clock = makeClockIcon();
            this._secondsId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._clock.update();
                return GLib.SOURCE_CONTINUE;
            });
            this._specials.push(new DockItem(this, this._clock, {
                label: 'Clock',
                onClick: () => launchAppId(CLOCKS_ID),
            }));
        }
        if (this._calendar || this._clock) {
            // ticks on the minute (and after suspend / time changes) instead of polling
            this._wallClock = new GnomeDesktop.WallClock({time_only: true});
            this._wallClock.connect('notify::clock', () => {
                this._calendar?.update();
                this._clock?.update();
            });
        }
        if (s.get_boolean('show-trash')) {
            this._trashIcon = themed('user-trash', ['user-trash']);
            this._specials.push(new DockItem(this, this._trashIcon, {
                label: 'Trash',
                onClick: () => Gio.AppInfo.launch_default_for_uri('trash:///', null),
                buildMenu: menu => {
                    menu.addAction('Open', () => Gio.AppInfo.launch_default_for_uri('trash:///', null));
                    menu.addAction('Empty Trash', () => Gio.Subprocess.new(['gio', 'trash', '--empty'], Gio.SubprocessFlags.NONE));
                },
            }));
            this._trashFile = Gio.File.new_for_uri('trash:///');
            try {
                this._trashMonitor = this._trashFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
                this._trashMonitor.connect('changed', () => this._updateTrash());
            } catch (e) {
                logError(e, 'MyDock: cannot monitor trash');
            }
            this._updateTrash();
        }
        if (this._specials.length) {
            this._separator = new St.Widget({
                style_class: 'mydock-separator',
                y_align: Clutter.ActorAlign.CENTER,
                height: Math.round(this.geom.S * 0.8),
            });
        }
    }

    _updateTrash() {
        this._trashFile.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (f, res) => {
                let full;
                try {
                    full = f.query_info_finish(res).get_attribute_uint32('trash::item-count') > 0;
                } catch {
                    return;
                }
                if (!this._trashIcon)
                    return;
                const name = full ? 'user-trash-full' : 'user-trash';
                this._trashIcon.gicon = this.dock.ext.iconOverride(name) ?? new Gio.ThemedIcon({name});
            });
    }

    restyle() {
        const s = this.dock.ext.settings;
        this._tint.opacity = Math.round(s.get_int('opacity') * 2.55);
        const radius = s.get_int('blur');
        // blur effects set up before the dock is first painted leave square corner artifacts;
        // build them once it is on screen
        if (!this._bg.mapped) {
            this._bg.connectObject('notify::mapped', () => {
                this._bg.disconnectObject(this);
                this.restyle();
            }, this);
            return;
        }
        // Shell.BlurEffect can't round its corners (GNOME 46), so the blur is made of horizontal
        // bands: a full-width middle band plus BLUR_BANDS bands per corner row, each inset to
        // follow the tint's corner curve. _layoutBlur() sizes them.
        if (radius > 0 && !this._blurBands) {
            this._blurBands = [];
            for (let i = 0; i < 2 * BLUR_BANDS + 1; i++) {
                const band = new St.Widget({x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START});
                band.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 1.0}));
                this._bg.insert_child_below(band, this._tint);
                this._blurBands.push(band);
            }
        } else if (radius === 0 && this._blurBands) {
            this._blurBands.forEach(b => b.destroy());
            this._blurBands = null;
        }
        this._blurBands?.forEach(b => (b.get_effects()[0].radius = radius));
        this._blurKey = null;
        this._layoutBlur();
    }

    _layoutBlur() {
        if (!this._blurBands)
            return;
        const [W, H] = this._bg.get_size();
        const node = this._tint.get_theme_node?.();
        const r = Math.min(H / 2, W / 2, node ? node.get_border_radius(St.Corner.TOPLEFT) : 18);
        const key = `${W}x${H}x${r}`;
        if (key === this._blurKey)
            return;
        this._blurKey = key;
        const [mid, ...corners] = this._blurBands;
        mid.set_position(0, Math.round(r));
        mid.set_size(W, Math.max(0, H - 2 * Math.round(r)));
        const step = r / BLUR_BANDS;
        for (let i = 0; i < BLUR_BANDS; i++) {
            // inset of the circle at the band's middle row, measured from the corner center
            const dy = r - (i + 0.5) * step;
            const inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
            const y0 = Math.round(i * step), y1 = Math.round((i + 1) * step);
            for (const [band, y] of [[corners[2 * i], y0], [corners[2 * i + 1], H - y1]]) {
                band.set_position(inset, y);
                band.set_size(Math.max(0, W - 2 * inset), y1 - y0);
            }
        }
    }

    // Rebuild the children order: pinned (+ user separators), running, separator, specials.
    setApps(pinned, running) {
        const want = [...pinned, ...running];
        const ids = new Set(want.map(a => a.get_id()));
        for (const [id, item] of this._items) {
            if (!ids.has(id)) {
                item.destroy();
                this._items.delete(id);
            }
        }
        const pinnedIds = new Set(pinned.map(a => a.get_id()));
        const anchors = new Set(this.dock.ext.settings.get_strv('dock-separators'));
        for (const [id, sep] of this._seps) {
            if (!anchors.has(id) || !pinnedIds.has(id)) {
                sep.destroy();
                this._seps.delete(id);
            }
        }
        const children = [];
        const pinnedSet = new Set(pinned);
        for (const app of want) {
            let item = this._items.get(app.get_id());
            if (!item) {
                const gicon = this.dock.ext.iconOverride(app.get_id());
                const icon = gicon
                    ? new St.Icon({gicon, icon_size: this.geom.M})
                    : app.create_icon_texture(this.geom.M);
                item = new DockItem(this, icon, {app, label: app.get_name()});
                this._items.set(app.get_id(), item);
            }
            item.pinned = pinnedSet.has(app);
            item.sync();
            children.push(item);
            const id = app.get_id();
            if (item.pinned && anchors.has(id)) {
                let sep = this._seps.get(id);
                if (!sep) {
                    sep = new DockSeparator(this, id);
                    this._seps.set(id, sep);
                }
                children.push(sep);
            }
        }
        if (this._separator)
            children.push(this._separator, ...this._specials);

        const current = this.box.get_children();
        if (current.length === children.length && current.every((c, i) => c === children[i]))
            return;
        // move only what changed: re-adding every child unmaps it and kills running eases (bounce)
        const keep = new Set(children);
        for (const c of current) {
            if (!keep.has(c))
                this.box.remove_child(c);
        }
        children.forEach((c, i) => {
            if (c.get_parent() !== this.box)
                this.box.insert_child_at_index(c, i);
            else if (this.box.get_child_at_index(i) !== c)
                this.box.set_child_at_index(c, i);
        });
        this._kick();
    }

    syncApp(app) {
        this._items.get(app.get_id())?.sync();
    }

    itemFor(app) {
        return this._items.get(app.get_id()) ?? null;
    }

    // Stage rect of the unmagnified dock panel (used for intellihide / unpin).
    dockRect() {
        const [x, y] = this.box.get_transformed_position();
        return {x, y: y - this.actor.translation_y, width: this.box.width, height: this.box.height};
    }

    _placeStrip() {
        // not get_transformed_position(): it is NaN while notify::allocation is being emitted
        const x = this.actor.x + this.box.x;
        this._strip.set_position(Math.round(x), this.monitor.y + this.monitor.height - 1);
        this._strip.width = Math.max(1, Math.round(this.box.width));
    }

    setHidden(hidden) {
        if (!this.autohide)
            hidden = false;
        if (this.hidden === hidden)
            return;
        this.hidden = hidden;
        if (hidden) {
            this._pointerX = null;
            this.hideLabel();
        }
        this.actor.ease({
            translation_y: hidden ? this.geom.H + this.geom.E + 2 : 0,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    onItemHover(item) {
        if (item.hover && this.dock.ext.settings.get_boolean('show-labels') && item.labelText && !item.menuOpen) {
            this._hoverItem = item;
            this._label.text = item.labelText;
            this._label.show();
            this._placeLabel();
            this._kick();
        } else if (this._hoverItem === item) {
            this.hideLabel();
        }
    }

    hideLabel() {
        this._hoverItem = null;
        this._label.hide();
    }

    _placeLabel() {
        const icon = this._hoverItem?.icon;
        if (!icon)
            return;
        const [x, y] = icon.get_transformed_position();
        const [w] = icon.get_transformed_size();
        this._label.set_position(
            Math.round(x + w / 2 - this._label.width / 2),
            Math.round(y - this._label.height - 8));
    }

    // DND target interface (box._delegate = this)
    _dropPos(x) {
        const kids = this.box.get_children();
        const pinned = kids.filter(k => k.pinned);
        let index = 0;
        for (const k of pinned) {
            if (k.x + k.width / 2 < x)
                index++;
        }
        return {index, pinned};
    }

    handleDragOver(source, _actor, x) {
        if (source instanceof DockSeparator) {
            const {index} = this._dropPos(x);
            if (!index) {
                this.clearDropGap();
                return DND.DragMotionResult.NO_DROP;
            }
            if (this._dropIndex !== index) {
                this._dropIndex = index;
                this._kick();
            }
            return DND.DragMotionResult.MOVE_DROP;
        }
        const app = appFromSource(source);
        if (!app || app.is_window_backed() || !global.settings.is_writable('favorite-apps'))
            return DND.DragMotionResult.NO_DROP;
        const {index} = this._dropPos(x);
        if (this._dropIndex !== index) {
            this._dropIndex = index;
            this._kick();
        }
        return AppFavorites.getAppFavorites().isFavorite(app.get_id())
            ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source, _actor, x) {
        if (source instanceof DockSeparator) {
            const {index, pinned} = this._dropPos(x);
            this.clearDropGap();
            if (!index)
                return false;
            this.dock.moveSeparator(source.anchor, pinned[index - 1].app.get_id());
            return true;
        }
        const app = appFromSource(source);
        if (!app || app.is_window_backed() || !global.settings.is_writable('favorite-apps'))
            return false;
        const id = app.get_id();
        const {index, pinned} = this._dropPos(x);
        // position in the favorites list once the app itself is removed from it
        const pos = pinned.slice(0, index).filter(k => k.app.get_id() !== id).length;
        this.clearDropGap();
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            const favs = AppFavorites.getAppFavorites();
            if (favs.isFavorite(id))
                favs.moveFavoriteToPos(id, pos);
            else
                favs.addFavoriteAtPos(id, pos);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    clearDropGap() {
        if (this._dropIndex === null)
            return;
        this._dropIndex = null;
        this._kick();
    }

    _kick() {
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    // One animation step. Returns true when everything has settled.
    _frame() {
        const {S, M, sp} = this.geom;
        const k = 1 - Math.pow(0.65, Math.min(this._timeline.get_delta(), 100) / 16.7);
        const factor = M / S;
        const R = (S + sp) * 2; // cosine falloff radius (~3 icons visibly grow)
        const half = (S + sp) / 2;
        const kids = this.box.get_children();
        const px = this.hidden ? null : this._pointerX;
        let settled = true;
        let total = 0;
        let pinnedSeen = 0;

        const approach = (cur, target) => {
            const v = cur + (target - cur) * k;
            if (Math.abs(target - v) < 0.002)
                return target;
            settled = false;
            return v;
        };

        for (const kid of kids) {
            const isItem = kid instanceof DockItem;
            if (isItem) {
                let target = 1;
                if (px !== null && factor > 1) {
                    const d = Math.abs(px - (kid.x + kid.width / 2));
                    if (d < R)
                        target = 1 + (factor - 1) * (1 + Math.cos(Math.PI * d / R)) / 2;
                }
                kid.scaleCur = approach(kid.scaleCur, target);
                total += (kid.scaleCur - 1) * S;
            }
            let gap = 0;
            if (this._dropIndex !== null)
                gap = pinnedSeen >= this._dropIndex ? half : -half;
            kid.shift = approach(kid.shift ?? 0, gap);
            if (isItem && kid.pinned)
                pinnedSeen++;
        }
        this._gapCur = approach(this._gapCur, this._dropIndex !== null ? 2 * half : 0);

        let acc = -total / 2;
        for (const kid of kids) {
            const extra = kid instanceof DockItem ? (kid.scaleCur - 1) * S : 0;
            kid.translation_x = acc + extra / 2 + kid.shift;
            acc += extra;
            if (kid instanceof DockItem)
                kid.applyScale(kid.scaleCur);
        }
        const grow = total + this._gapCur;
        this._bg.set_position(Math.round(this.box.x - grow / 2), this.box.y);
        this._bg.set_size(Math.round(this.box.width + grow), this.box.height);
        this._layoutBlur();

        if (this._label.visible)
            this._placeLabel();
        return settled;
    }

    destroy() {
        this._timeline.stop();
        if (this._secondsId)
            GLib.source_remove(this._secondsId);
        this._wallClock?.run_dispose();
        this._wallClock = null;
        this._trashMonitor?.cancel();
        this._trashIcon = null;
        this._label.destroy();
        this._strip?.destroy();
        for (const item of [...this._items.values(), ...this._specials])
            item.destroy();
        this._items.clear();
        this._seps.forEach(s => s.destroy());
        this._seps.clear();
        this._specials = [];
        this._separator?.destroy();
        this.actor.destroy();
    }
}

export class Dock {
    constructor(ext) {
        this.ext = ext;
        this._bars = [];
        this._runningOrder = [];
        this._dragging = false;
        this._favs = AppFavorites.getAppFavorites();
        this._appSystem = Shell.AppSystem.get_default();

        this._favs.connectObject('changed', () => this._refresh(), this);
        this._appSystem.connectObject('app-state-changed', (_s, app) => this._onAppState(app), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._rebuild(), this);
        global.display.connectObject(
            'notify::focus-window', () => this._trackFocus(),
            'window-created', () => this._queueIconGeometry(),
            this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this.queueHideCheck(), this);
        Main.overview.connectObject(
            'showing', () => this.queueHideCheck(0),
            'hidden', () => this.queueHideCheck(0),
            'item-drag-end', () => this.clearDropGaps(),
            'item-drag-cancelled', () => this.clearDropGaps(),
            this);
        ext.settings.connectObject('changed', (_s, key) => {
            if (REBUILD_KEYS.includes(key))
                this._rebuild();
            else if (key === 'blur' || key === 'opacity')
                this._bars.forEach(b => b.restyle());
            else if (key === 'bounce-on-launch' || key === 'show-labels' || key === 'dock-separators')
                this._refresh();
        }, this);

        // Clear drop gaps as soon as a drag leaves a dock.
        this._dragMonitor = {
            dragMotion: ev => {
                for (const b of this._bars) {
                    if (!b.box.contains(ev.targetActor))
                        b.clearDropGap();
                }
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);

        this._rebuild();
        this._trackFocus();
    }

    _rebuild() {
        this._bars.forEach(b => b.destroy());
        this._bars = [];
        const lm = Main.layoutManager;
        const monitors = this.ext.settings.get_boolean('multi-monitor')
            ? [lm.primaryMonitor, ...lm.monitors.filter(m => m !== lm.primaryMonitor)]
            : [lm.primaryMonitor];
        for (const m of monitors) {
            if (m)
                this._bars.push(new DockBar(this, m));
        }
        this._refresh();
        this.queueHideCheck(0);
    }

    _onAppState(app) {
        const known = this._bars[0]?.itemFor(app);
        const shouldShow = app.state !== Shell.AppState.STOPPED || this._favs.isFavorite(app.get_id());
        if (!known !== !shouldShow)
            this._refresh();
        else
            this._bars.forEach(b => b.syncApp(app));
        this._queueIconGeometry();
    }

    _refresh() {
        const pinned = this._favs.getFavorites();
        const pinnedIds = new Set(pinned.map(a => a.get_id()));
        const running = this._appSystem.get_running().filter(a => !pinnedIds.has(a.get_id()));
        // keep running apps in first-seen order so icons don't jump around
        const runIds = new Set(running.map(a => a.get_id()));
        this._runningOrder = this._runningOrder.filter(id => runIds.has(id));
        for (const a of running) {
            if (!this._runningOrder.includes(a.get_id()))
                this._runningOrder.push(a.get_id());
        }
        running.sort((a, b) => this._runningOrder.indexOf(a.get_id()) - this._runningOrder.indexOf(b.get_id()));
        this._bars.forEach(b => b.setApps(pinned, running));
        this._queueIconGeometry();
    }

    _barFor(monitorIndex) {
        return this._bars.find(b => b.monitor.index === monitorIndex) ?? this._bars[0] ?? null;
    }

    // Public: stage rect of the app's icon on the dock nearest `win` (or the app's first window).
    getIconRect(app, win = null) {
        if (!app)
            return null;
        const w = win ?? app.get_windows()[0];
        const bar = this._barFor(w ? w.get_monitor() : Main.layoutManager.primaryIndex);
        const item = bar?.itemFor(app);
        if (!item || !item.mapped)
            return null;
        const [x, y] = item.get_transformed_position();
        const {S} = bar.geom;
        // unmagnified slot position, as if the dock were shown
        return {
            x: Math.round(x - item.translation_x),
            y: Math.round(y - bar.actor.translation_y),
            width: S,
            height: S,
        };
    }

    _queueIconGeometry() {
        if (this._geomId)
            return;
        this._geomId = GLib.timeout_add(GLib.PRIORITY_LOW, 300, () => {
            this._geomId = 0;
            for (const app of this._appSystem.get_running()) {
                for (const w of app.get_windows()) {
                    const r = this.getIconRect(app, w);
                    if (r)
                        w.set_icon_geometry(new Mtk.Rectangle(r));
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    clearDropGaps() {
        this._bars.forEach(b => b.clearDropGap());
    }

    // Dragging a pinned icon (or a separator) out of the dock and releasing it removes it.
    onDragCancelled(item) {
        const ev = Clutter.get_current_event();
        const sep = item instanceof DockSeparator;
        if ((!sep && !item.pinned) || ev?.type() !== Clutter.EventType.BUTTON_RELEASE)
            return;
        const [px, py] = global.get_pointer();
        const over = this._bars.some(b => {
            const r = b.dockRect();
            return px >= r.x && px <= r.x + r.width && py >= r.y - b.geom.S && py <= r.y + r.height + b.geom.E;
        });
        if (over)
            return;
        if (sep) {
            this.removeSeparator(item.anchor);
            return;
        }
        const id = item.app.get_id();
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._favs.removeFavorite(id);
            return GLib.SOURCE_REMOVE;
        });
    }

    // A dock drag grabs the pointer, so the box loses hover: keep an auto-hidden dock up meanwhile.
    setDragging(dragging) {
        this._dragging = dragging;
        if (!dragging)
            this.queueHideCheck();
    }

    // Separator edits run before the next redraw: they rebuild the bars, which may destroy
    // the separator a running drag still references.
    _editSeparators(fn) {
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            const s = this.ext.settings;
            s.set_strv('dock-separators', [...new Set(fn(s.get_strv('dock-separators')))]);
            return GLib.SOURCE_REMOVE;
        });
    }

    addSeparator(id) {
        this._editSeparators(list => [...list, id]);
    }

    removeSeparator(id) {
        this._editSeparators(list => list.filter(a => a !== id));
    }

    moveSeparator(from, to) {
        this._editSeparators(list => [...list.filter(a => a !== from), to]);
    }

    // Intellihide: hide a bar when the focused window on its monitor overlaps it.
    _trackFocus() {
        this._focusWin?.disconnectObject(this);
        this._focusWin = global.display.focus_window;
        this._focusWin?.connectObject(
            'position-changed', () => this.queueHideCheck(),
            'size-changed', () => this.queueHideCheck(),
            'notify::minimized', () => this.queueHideCheck(),
            'unmanaged', () => {
                this._focusWin?.disconnectObject(this);
                this._focusWin = null;
            },
            this);
        this.queueHideCheck();
    }

    queueHideCheck(delay = HIDE_DELAY) {
        // no autohide bar: nothing to evaluate (skips a timer per focus-window move/resize)
        if (!this._bars.some(b => b.autohide))
            return;
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideId = 0;
            this._bars.forEach(b => b.setHidden(this._shouldHide(b)));
            return GLib.SOURCE_REMOVE;
        });
    }

    _shouldHide(bar) {
        if (!bar.autohide || this._dragging || Main.overview.visible || bar.hovered)
            return false;
        const win = this._focusWin;
        if (!win || win.minimized || win.get_monitor() !== bar.monitor.index ||
            win.get_window_type() === Meta.WindowType.DESKTOP)
            return false;
        const f = win.get_frame_rect();
        const d = bar.dockRect();
        return f.x < d.x + d.width && f.x + f.width > d.x && f.y < d.y + d.height && f.y + f.height > d.y;
    }

    destroy() {
        DND.removeDragMonitor(this._dragMonitor);
        for (const obj of [this._favs, this._appSystem, Main.layoutManager, global.display,
            global.workspace_manager, Main.overview, this.ext.settings, this._focusWin])
            obj?.disconnectObject(this);
        this._focusWin = null;
        if (this._hideId)
            GLib.source_remove(this._hideId);
        if (this._geomId)
            GLib.source_remove(this._geomId);
        this._bars.forEach(b => b.destroy());
        this._bars = [];
    }
}
