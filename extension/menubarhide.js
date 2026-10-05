// MyDock - menu bar autohide, like macOS "Automatically hide and show the menu bar".
// The top panel slides up off screen and gives its space to windows; pushing the pointer
// against the top edge, opening a panel menu or the overview brings it back.
// destroy() puts the panel back and reserves its space again.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SLIDE_MS = 200;
const POLL_MS = 150;    // one cheap pointer check while the bar is shown
const HIDE_AFTER = 450; // ms the pointer has to stay away before the bar hides again

export class MenuBarAutohide {
    constructor(_ext) {
        this._box = Main.layoutManager.panelBox;
        this._track(false);
        this._shown = true;
        this._away = 0;
        this._pollId = 0;
        // nothing polls while hidden: a 1px strip on the top edge, the overview and a panel menu
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
        ];
        this._startPoll();
    }

    _startPoll() {
        this._pollId ||= GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPoll() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    // Re-register the panel as chrome with or without a strut (the space windows keep free).
    _track(struts) {
        const lm = Main.layoutManager;
        lm.untrackChrome(this._box);
        lm.trackChrome(this._box, {affectsStruts: struts, trackFullscreen: true});
    }

    _poll() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        const [x, y] = global.get_pointer();
        const onMonitor = x >= m.x && x < m.x + m.width;
        const busy = Main.overview.visible || !!Main.panel.menuManager.activeMenu;
        const near = onMonitor && y < m.y + this._box.height + 4;
        this._away = busy || near ? 0 : this._away + POLL_MS;
        if (this._away >= HIDE_AFTER)
            this._slide(false);
    }

    _slide(show) {
        this._shown = show;
        this._away = 0;
        const m = Main.layoutManager.primaryMonitor;
        if (show) {
            this._edge.hide();
            this._startPoll();
        } else {
            this._stopPoll();
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
        this._stopPoll();
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
