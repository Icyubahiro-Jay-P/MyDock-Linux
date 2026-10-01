// MyDock - Launchpad. Reuses GNOME's app grid: opens the overview straight into
// the apps view as a 7 x 5 grid under a search field, hides the workspace strip
// and dash and puts a blurred wallpaper behind it. Everything is restored when the overview hides.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const GRID_MODES = [{rows: 5, columns: 7}];

export class Launchpad {
    constructor(ext) {
        this._ext = ext;
        this._active = false;
        Main.wm.addKeybinding('launchpad-hotkey', ext.settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
        Main.overview.connectObject(
            'hiding', () => this._bg?.ease({opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD}),
            'hidden', () => this._leave(),
            this);
    }

    get active() {
        return this._active;
    }

    toggle() {
        if (Main.overview.visible) {
            Main.overview.hide();
            return;
        }
        this._enter();
        Main.overview.showApps();
    }

    _enter() {
        if (this._active)
            return;
        this._active = true;
        const group = Main.layoutManager.overviewGroup;
        group.add_style_class_name('mydock-launchpad');

        // private shell actors; tolerate them missing on other shell versions
        const c = Main.overview._overview?.controls;
        this._hidden = [c?._workspacesDisplay, c?.dash]
            .filter(Boolean)
            .map(a => [a, a.opacity]);
        for (const [a] of this._hidden)
            a.opacity = 0;

        // fixed 7 x 5 pages like macOS; _currentMode reset so the new mode applies even at index 0
        this._grid = c?._appDisplay?._grid;
        if (this._grid?.setGridModes) {
            this._gridModes = this._grid._gridModes;
            this._grid._currentMode = -1;
            this._grid.setGridModes(GRID_MODES);
        }

        // blurred wallpaper under the app grid
        this._bg = new St.Widget({
            style_class: 'mydock-launchpad-bg',
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            opacity: 0,
        });
        this._bgManagers = Main.layoutManager.monitors.map(m => new Background.BackgroundManager({
            container: this._bg,
            monitorIndex: m.index,
            vignette: false,
        }));
        this._bg.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 60, brightness: 0.55}));
        group.insert_child_at_index(this._bg, 0);
        this._bg.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _leave() {
        if (!this._active)
            return;
        this._active = false;
        Main.layoutManager.overviewGroup.remove_style_class_name('mydock-launchpad');
        for (const [a, opacity] of this._hidden)
            a.opacity = opacity;
        this._hidden = [];
        if (this._grid) {
            this._grid._currentMode = -1;
            this._grid.setGridModes(this._gridModes);
            this._grid = this._gridModes = null;
        }
        this._bgManagers.forEach(m => m.destroy());
        this._bgManagers = [];
        this._bg.destroy();
        this._bg = null;
    }

    destroy() {
        Main.wm.removeKeybinding('launchpad-hotkey');
        Main.overview.disconnectObject(this);
        this._leave();
    }
}
