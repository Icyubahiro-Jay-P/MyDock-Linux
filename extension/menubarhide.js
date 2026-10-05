// MyDock - menu bar autohide, like macOS "Automatically hide and show the menu bar".
// The top panel slides up off screen and gives its space to windows; pushing the pointer
// against the top edge, opening a panel menu or the overview brings it back.
// destroy() puts the panel back and reserves its space again.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SLIDE_MS = 200;
const POLL_MS = 150;    // one cheap pointer check; also catches menus opened from the keyboard
const HIDE_AFTER = 450; // ms the pointer has to stay away before the bar hides again

export class MenuBarAutohide {
    constructor(_ext) {
        this._box = Main.layoutManager.panelBox;
        this._track(false);
        this._shown = true;
        this._away = 0;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
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
        if (!this._shown) {
            if (busy || (onMonitor && y <= m.y))
                this._slide(true);
            return;
        }
        const near = onMonitor && y < m.y + this._box.height + 4;
        this._away = busy || near ? 0 : this._away + POLL_MS;
        if (this._away >= HIDE_AFTER)
            this._slide(false);
    }

    _slide(show) {
        this._shown = show;
        this._away = 0;
        this._box.ease({
            translation_y: show ? 0 : -this._box.height,
            duration: SLIDE_MS,
            mode: show ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    destroy() {
        GLib.source_remove(this._pollId);
        this._pollId = 0;
        this._box.remove_all_transitions();
        this._box.translation_y = 0;
        this._track(true);
        this._box = null;
    }
}
