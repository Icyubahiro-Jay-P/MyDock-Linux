// MyDock - Stage Manager. The focused app's windows stay on stage; every other
// app on the active workspace (primary monitor) is minimized and shown as a
// stacked live thumbnail in a strip on the left edge. Click a stack to swap it in.
// destroy() unminimizes everything we minimized.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// px values are logical: multiplied by the St scale factor where used as raw actor geometry
const MARGIN = 12;          // gap between strip and screen edge
const MAX_STACK = 3;        // clones per group
const ANIM_MS = 220;
const ICON_SIZE = 28;
const STACK_INSET = 8;      // padding around the clones inside a group

export class StageManager {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._tracker = Shell.WindowTracker.get_default();
        this._stage = null;          // Shell.App currently on stage
        this._mru = [];              // Shell.App, most recent first
        this._ours = new Set();      // MetaWindows we minimized
        this._unmanagedIds = new Map();
        this._stageWinSigs = [];
        this._sigs = [];
        this._busy = false;
        this._busyId = 0;
        this._syncId = 0;
        this._placeLater = 0;
        this._peek = false;
        this._shown = false;
        this._rect = null;
        this._buttons = new Map();   // app + window ids key -> group button in the strip

        this._strip = new St.BoxLayout({
            style_class: 'mydock-stage-strip',
            vertical: true,
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 0.9, radius: 30});
        this._strip.add_effect(this._blur);
        this._strip.connect('notify::hover', () => {
            if (!this._strip.hover) {
                this._peek = false;
                this._updateReveal();
            }
        });
        // center on the real height: the preferred height read in _sync() can be stale
        this._strip.connect('notify::height', () => this._queuePlace());
        this._stripBox = this._addChrome(this._strip);
        this._stripBox.clip_to_allocation = true;   // slide out into the screen edge

        // 1px hot edge: pointer on the left edge reveals a hidden strip
        this._edge = new St.Widget({reactive: true, width: 1, visible: false});
        this._edge.connect('enter-event', () => {
            this._peek = true;
            this._updateReveal();
            return Clutter.EVENT_PROPAGATE;
        });
        this._edgeBox = this._addChrome(this._edge);

        const on = (obj, sig, fn) => this._sigs.push([obj, obj.connect(sig, fn)]);
        on(global.display, 'notify::focus-window', () => this._onFocus());
        on(global.display, 'window-created', (d, win) => {
            this._watch(win);
            this._queueSync();
        });
        on(global.workspace_manager, 'active-workspace-changed', () => {
            this._onFocus();
            this._queueSync();
        });
        on(Main.layoutManager, 'monitors-changed', () => this._queueSync());
        on(Main.overview, 'showing', () => this._updateReveal());
        on(Main.overview, 'hidden', () => this._updateReveal());
        for (const key of ['stage-count', 'stage-size', 'stage-show-title'])
            on(this._settings, `changed::${key}`, () => this._queueSync());

        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);

        this._onFocus();
        this._sync();
    }

    destroy() {
        for (const [obj, id] of this._sigs)
            obj.disconnect(id);
        this._sigs = [];
        this._dropStageWinSigs();
        for (const [win, id] of this._unmanagedIds)
            win.disconnect(id);
        this._unmanagedIds.clear();
        if (this._syncId)
            GLib.source_remove(this._syncId);
        if (this._busyId)
            GLib.source_remove(this._busyId);
        if (this._placeLater)
            global.compositor.get_laters().remove(this._placeLater);
        this._syncId = this._busyId = this._placeLater = 0;
        this._ext.stageOpening?.clear();

        // never leave windows hidden once Stage Manager is off
        for (const win of this._ours) {
            if (win.minimized)
                win.unminimize();
        }
        this._ours.clear();

        this._strip.remove_all_transitions();
        this._stripBox.destroy();
        this._edgeBox.destroy();
        this._strip = this._edge = this._blur = this._stripBox = this._edgeBox = null;
        this._stage = null;
        this._mru = [];
        this._buttons.clear();
    }

    // trackFullscreen forces the tracked actor's `visible`, so track a wrapper
    // and keep our own show/hide on the child. The wrapper shrinks to 0x0 when
    // the child is hidden, which also drops its input region.
    _addChrome(child) {
        const box = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        box.add_child(child);
        Main.layoutManager.addChrome(box, {affectsStruts: false, trackFullscreen: true});
        return box;
    }

    // --- window bookkeeping -------------------------------------------------

    _watch(win) {
        if (this._unmanagedIds.has(win))
            return;
        this._unmanagedIds.set(win, win.connect('unmanaged', () => {
            win.disconnect(this._unmanagedIds.get(win));
            this._unmanagedIds.delete(win);
            this._ours.delete(win);
            this._stageWinSigs = this._stageWinSigs.filter(([w, id]) => {
                if (w === win)
                    win.disconnect(id);
                return w !== win;
            });
            this._queueSync();
        }));
    }

    _eligible(win) {
        return win &&
            win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.skip_taskbar &&
            win.get_monitor() === Main.layoutManager.primaryIndex &&
            win.located_on_workspace(global.workspace_manager.get_active_workspace());
    }

    // Map<Shell.App, MetaWindow[]> (windows bottom-to-top in stacking order)
    _groups() {
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.display.sort_windows_by_stacking(ws.list_windows().filter(w => this._eligible(w)));
        const groups = new Map();
        for (const win of wins) {
            const app = this._tracker.get_window_app(win);
            if (!app)
                continue;
            if (!groups.has(app))
                groups.set(app, []);
            groups.get(app).push(win);
        }
        return groups;
    }

    _touch(app) {
        this._mru = [app, ...this._mru.filter(a => a !== app)];
    }

    // --- stage switching ----------------------------------------------------

    _onFocus() {
        if (this._busy)
            return;
        const win = global.display.focus_window;
        if (!win || win.skip_taskbar || win.get_monitor() !== Main.layoutManager.primaryIndex)
            return;
        // a dialog (e.g. a portal file chooser) belongs to its parent's group
        const app = this._tracker.get_window_app(win.find_root_ancestor());
        if (!app || app === this._stage)
            return;
        this._arrange(app, false);
    }

    // Put `app` on stage, minimize every other group. `activate` = user clicked
    // the strip, so also bring its windows back and focus the top one.
    _arrange(app, activate, fromActor = null) {
        const groups = this._groups();
        const stageWins = groups.get(app) ?? [];
        // nothing of `app` can go on stage (e.g. its window is not eligible): minimizing every
        // other group would leave an empty screen
        if (!stageWins.length) {
            this._queueSync();
            return;
        }
        this._setBusy();
        this._stage = app;
        this._peek = false;
        this._touch(app);

        // clicked thumbnail: minimize.js flies these windows out of it instead of the dock genie
        if (fromActor) {
            const [x, y] = fromActor.get_transformed_position();
            const [width, height] = fromActor.get_transformed_size();
            this._ext.stageOpening ??= new Map();
            const time = GLib.get_monotonic_time();
            for (const win of stageWins) {
                // only minimized windows animate out of the thumbnail
                if (win.minimized)
                    this._ext.stageOpening.set(win, {x, y, width, height, time});
            }
        }
        for (const win of stageWins) {
            // on focus changes only undo our own minimizes, not the user's
            if (win.minimized && (activate || this._ours.has(win)))
                win.unminimize();
            this._ours.delete(win);
        }
        if (activate)
            Main.activateWindow(stageWins[stageWins.length - 1]);

        for (const [other, wins] of groups) {
            if (other === app)
                continue;
            for (const win of wins) {
                if (!win.minimized) {
                    win.minimize();
                    this._ours.add(win);
                }
            }
        }

        this._dropStageWinSigs();
        for (const win of stageWins) {
            for (const sig of ['position-changed', 'size-changed'])
                this._stageWinSigs.push([win, win.connect(sig, () => this._updateReveal())]);
        }
        this._queueSync();
    }

    // Our own minimize/activate calls emit focus signals; ignore them until idle.
    _setBusy() {
        this._busy = true;
        if (this._busyId)
            GLib.source_remove(this._busyId);
        this._busyId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._busy = false;
            this._busyId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _dropStageWinSigs() {
        for (const [win, id] of this._stageWinSigs)
            win.disconnect(id);
        this._stageWinSigs = [];
    }

    // --- strip --------------------------------------------------------------

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const groups = this._groups();
        for (const app of groups.keys()) {
            if (!this._mru.includes(app))
                this._mru.push(app);
        }
        const count = this._settings.get_int('stage-count');
        const apps = this._mru.filter(a => a !== this._stage && groups.has(a)).slice(0, count);

        const mon = Main.layoutManager.primaryMonitor;
        // everything the strip shows; window-created also fires for menus/tooltips, so most
        // syncs change nothing and must not rebuild the clones. Titles are not in the key:
        // the labels follow notify::title themselves.
        const base = [mon?.x, mon?.y, mon?.height, this._settings.get_int('stage-size'),
            this._settings.get_boolean('stage-show-title')].join('|');
        const appKeys = apps.map(app => `${app.get_id()}:${groups.get(app).map(w => w.get_id()).join(',')}`);
        const key = [base, ...appKeys].join('|');
        if (key === this._key) {
            this._updateReveal();
            return;
        }
        this._key = key;

        // keep the groups whose app and windows are unchanged: a stage switch only swaps one
        // group in and one out, the others keep their clones
        if (base !== this._base) {
            this._base = base;
            this._strip.destroy_all_children();
            this._buttons.clear();
        }
        const buttons = new Map();
        apps.forEach((app, i) => {
            const k = appKeys[i];
            const button = this._buttons.get(k) ?? this._buildGroup(app, groups.get(app));
            this._buttons.delete(k);
            buttons.set(k, button);
            if (button.get_parent() !== this._strip)
                this._strip.insert_child_at_index(button, i);
            else if (this._strip.get_child_at_index(i) !== button)
                this._strip.set_child_at_index(button, i);
        });
        this._buttons.forEach(b => b.destroy());
        this._buttons = buttons;

        if (!mon)
            return;
        this._place();
        this._edgeBox.set_position(mon.x, mon.y);
        this._edge.height = mon.height;
        this._updateReveal();
    }

    // Vertically center the strip on the primary monitor, from its allocated size once known.
    _place() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || !this._strip)
            return;
        let [w, h] = this._strip.get_size();
        if (!h) {
            [, w] = this._strip.get_preferred_width(-1);
            [, h] = this._strip.get_preferred_height(w);
        }
        const m = MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const y = mon.y + Math.max(m, Math.floor((mon.height - h) / 2));
        this._stripBox.set_position(mon.x + m, y);
        this._rect = {x: mon.x, y, width: w + 2 * m, height: h};
    }

    // notify::height fires during allocation; move the parent after layout, not inside it
    _queuePlace() {
        if (this._placeLater)
            return;
        this._placeLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeLater = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildGroup(app, wins) {
        const logical = this._settings.get_int('stage-size');
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const size = logical * sf, inset = STACK_INSET * sf;
        const button = new St.Button({
            style_class: 'mydock-stage-group',
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: app.get_name(),
        });
        const box = new St.BoxLayout({vertical: true, style_class: 'mydock-stage-group-box'});
        button.set_child(box);

        // stacked clones, topmost window in front, older ones rotated behind it
        const stack = new St.Widget({style_class: 'mydock-stage-stack', layout_manager: new Clutter.FixedLayout()});
        const top = wins.slice(-MAX_STACK);
        let stackH = 0;
        top.forEach((win, i) => {
            const actor = win.get_compositor_private();
            if (!actor)
                return;
            const depth = top.length - 1 - i;      // 0 = front
            const [aw, ah] = actor.get_size();
            const cw = size - depth * 8 * sf;
            const ch = aw > 0 ? Math.round(cw * ah / aw) : Math.round(cw * 0.66);
            const clone = new Clutter.Clone({
                source: actor,
                width: cw,
                height: ch,
                x: inset + depth * 6 * sf,
                y: inset + depth * 5 * sf,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                rotation_angle_y: 14,
                rotation_angle_z: depth * -3,
                opacity: 255 - depth * 50,
            });
            stack.add_child(clone);
            stackH = Math.max(stackH, ch + depth * 5 * sf);
        });
        // room for the y-rotation perspective and the hover zoom so clones stay inside the group
        stack.set_size(size + 12 * sf + 2 * inset, stackH + 2 * inset);
        box.add_child(stack);

        const row = new St.BoxLayout({style_class: 'mydock-stage-label-row', x_align: Clutter.ActorAlign.CENTER});
        const appId = app.get_id();
        const gicon = appId ? this._ext.iconOverride?.(appId) : null;
        row.add_child(gicon
            ? new St.Icon({gicon, icon_size: ICON_SIZE, style_class: 'mydock-stage-icon'})
            : app.create_icon_texture(ICON_SIZE));
        if (this._settings.get_boolean('stage-show-title')) {
            const win = wins[wins.length - 1];
            const label = new St.Label({
                style_class: 'mydock-stage-title',
                text: win.get_title() || app.get_name(),
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.style = `max-width: ${logical - ICON_SIZE}px;`;   // CSS px: St scales it
            row.add_child(label);
            // browser tab-title churn: update the text in place (disconnected with the label)
            win.connectObject('notify::title', () => (label.text = win.get_title() || app.get_name()), label);
        }
        box.add_child(row);

        button.connect('notify::hover', () => {
            stack.ease({
                scale_x: button.hover ? 1.06 : 1,
                scale_y: button.hover ? 1.06 : 1,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
        stack.set_pivot_point(0.5, 0.5);
        button.connect('clicked', () => this._arrange(app, true, stack));
        return button;
    }

    _overlapsStage() {
        if (!this._rect || !this._stage)
            return false;
        const r = this._rect;
        for (const [win] of this._stageWinSigs) {
            if (win.minimized)
                continue;
            const f = win.get_frame_rect();
            if (f.x < r.x + r.width && f.x + f.width > r.x &&
                f.y < r.y + r.height && f.y + f.height > r.y)
                return true;
        }
        return false;
    }

    _updateReveal() {
        if (!this._strip)
            return;
        const has = this._strip.get_n_children() > 0;
        const want = has && !Main.overview.visible && (this._peek || !this._overlapsStage());
        this._edge.visible = has && !want && !Main.overview.visible;
        if (want === this._shown)
            return;
        this._shown = want;

        const off = -(this._rect?.width ?? 200);
        this._strip.remove_all_transitions();
        if (want) {
            this._strip.translation_x = off;
            this._strip.show();
            this._strip.ease({translation_x: 0, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            // hide at the end so the chrome input region goes away with it
            this._strip.ease({
                translation_x: off,
                duration: Main.overview.visible ? 0 : ANIM_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._strip?.hide(),
            });
        }
    }
}
