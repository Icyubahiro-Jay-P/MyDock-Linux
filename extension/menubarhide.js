// MyDock - menu bar autohide, like macOS "Automatically hide and show the menu bar".
// The top panel slides up off screen and gives its space to windows; pushing the pointer
// against the top edge, opening a panel menu or the overview brings it back.
// destroy() puts the panel back and reserves its space again.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SLIDE_MS = 200;
const HIDE_AFTER = 450; // ms the pointer has to stay away before the bar hides again

export class MenuBarAutohide {
    constructor(_ext) {
        this._box = Main.layoutManager.panelBox;
        this._track(false);
        this._shown = true;
        this._hideId = 0;
        // the panel's hover arms a one-shot hide timer when the pointer leaves it
        this._hoverWas = Main.panel.track_hover;
        Main.panel.track_hover = true;
        // nothing runs while hidden: a 1px strip on the top edge, the overview and a panel menu
        // taking key focus (opened from the keyboard) bring the bar back
        this._edge = new St.Widget({reactive: true, visible: false});
        Main.layoutManager.addChrome(this._edge, {trackFullscreen: true});
        this._edge.connect('enter-event', () => this._slide(true));
        const wake = () => {
            if (!this._shown && (Main.overview.visible || Main.panel.menuManager.activeMenu))
                this._slide(true);
        };
        this._sigs = [
            [Main.overview, Main.overview.connect('showing', wake)],
            [global.stage, global.stage.connect('notify::key-focus', wake)],
            [Main.panel, Main.panel.connect('notify::hover', () => {
                if (Main.panel.hover)
                    this._stopHide();
                else if (this._shown)
                    this._startHide();
            })],
            // the panel box moves / resizes with the primary monitor: redo the strip and offset
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._slide(this._shown))],
        ];
        this._startHide();
    }

    // hides once HIDE_AFTER passes with the pointer off the bar; while the overview or a panel
    // menu is open, or the pointer is still in the top strip (the bar slid in under a resting
    // pointer and no crossing event came yet), it checks again every HIDE_AFTER
    _startHide() {
        this._hideId ||= GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_AFTER, () => {
            if (this._near() || Main.overview.visible || Main.panel.menuManager.activeMenu)
                return GLib.SOURCE_CONTINUE;
            this._hideId = 0;
            this._slide(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopHide() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
    }

    _near() {
        const m = Main.layoutManager.primaryMonitor;
        const [x, y] = global.get_pointer();
        return Main.panel.hover || (!!m && x >= m.x && x < m.x + m.width && y < m.y + this._box.height + 4);
    }

    // Re-register the panel as chrome with or without a strut (the space windows keep free).
    _track(struts) {
        const lm = Main.layoutManager;
        lm.untrackChrome(this._box);
        lm.trackChrome(this._box, {affectsStruts: struts, trackFullscreen: true});
    }

    _slide(show) {
        this._shown = show;
        const m = Main.layoutManager.primaryMonitor;
        if (show) {
            this._edge.hide();
            if (!Main.panel.hover)
                this._startHide();
        } else {
            this._stopHide();
            if (m) {
                this._edge.set_position(m.x, m.y);
                this._edge.set_size(m.width, 1);
                this._edge.show();
            }
        }
        this._box.ease({
            translation_y: show ? 0 : -this._box.height,
            duration: SLIDE_MS,
            mode: show ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    destroy() {
        this._stopHide();
        Main.panel.track_hover = this._hoverWas;
        for (const [obj, id] of this._sigs)
            obj.disconnect(id);
        this._sigs = [];
        this._edge.destroy(); // the layout manager untracks it
        this._edge = null;
        this._box.remove_all_transitions();
        this._box.translation_y = 0;
        // the shell disables extensions while locked: keep the space free so windows don't
        // reflow on every lock / unlock (windowbuttons.js does the same)
        if (!Main.sessionMode.isLocked)
            this._track(true);
        this._box = null;
    }
}
