// MyDock - entry point. Each feature lives in its own module with the same shape:
//   new Feature(ext)  -> builds itself, reads ext.settings
//   feature.destroy() -> removes everything it added
// Features are created/destroyed live when their on/off setting changes.

import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dock} from './dock.js';
import {FinderBar} from './finderbar.js';
import {Launchpad} from './launchpad.js';
import {StageManager} from './stagemanager.js';
import {StatusMenus} from './statusmenus.js';
import {MinimizeEffects} from './minimize.js';
import {Updater} from './updater.js';
import {WindowButtons} from './windowbuttons.js';
import {MenuBarAutohide} from './menubarhide.js';

// [property on ext, class, setting that toggles it (null = always on)]
const FEATURES = [
    ['launchpad', Launchpad, null],
    ['dock', Dock, 'dock-enabled'],
    ['finderbar', FinderBar, 'finderbar-enabled'],
    ['statusMenus', StatusMenus, 'finderbar-status-menus'],
    ['stageManager', StageManager, 'stage-manager'],
    ['minimize', MinimizeEffects, null],
    ['windowButtons', WindowButtons, 'window-buttons-left'],
    ['menuBarAutohide', MenuBarAutohide, 'finderbar-autohide'],
    ['updater', Updater, null], // check-updates only gates the daily check; the About page can always ask
];

export default class MyDockExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._sigs = [];

        this._loadTheme();
        this._applyDarkMode();
        this._sigs.push([this.settings, this.settings.connect('changed::theme-path', () => this._loadTheme())]);
        this._sigs.push([this.settings, this.settings.connect('changed::dark-mode', () => this._applyDarkMode())]);
        this._sigs.push([this._iface, this._iface.connect('changed::color-scheme', () => this._applyDarkMode())]);

        for (const [prop, Cls, key] of FEATURES) {
            this._sync(prop, Cls, key);
            if (key)
                this._sigs.push([this.settings, this.settings.connect(`changed::${key}`, () => this._sync(prop, Cls, key))]);
        }
    }

    disable() {
        for (const [obj, id] of this._sigs ?? [])
            obj.disconnect(id);
        this._sigs = null;
        for (const [prop] of [...FEATURES].reverse())
            this._destroy(prop);
        this._unloadTheme();
        Main.uiGroup.remove_style_class_name('mydock-dark');
        Main.uiGroup.remove_style_class_name('mydock-light');
        this._iface = null;
        this._icons = null;
        this.settings = null;
    }

    _sync(prop, Cls, key) {
        const want = key === null || this.settings.get_boolean(key);
        if (want && !this[prop]) {
            try {
                this[prop] = new Cls(this);
            } catch (e) {
                // one broken feature must not take the whole shell session down
                logError(e, `MyDock: ${prop} failed to start`);
                this[prop] = null;
            }
        } else if (!want && this[prop]) {
            this._destroy(prop);
        }
    }

    _destroy(prop) {
        try {
            this[prop]?.destroy();
        } catch (e) {
            logError(e, `MyDock: ${prop} failed to stop`);
        }
        this[prop] = null;
    }

    isDark() {
        const mode = this.settings.get_int('dark-mode');
        if (mode === 1)
            return false;
        if (mode === 2)
            return true;
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    _applyDarkMode() {
        const dark = this.isDark();
        Main.uiGroup.add_style_class_name(dark ? 'mydock-dark' : 'mydock-light');
        Main.uiGroup.remove_style_class_name(dark ? 'mydock-light' : 'mydock-dark');
    }

    // Theme = folder with stylesheet.css (+ optional icons/<app-id>.png, see iconOverride()).
    _themeDir() {
        const p = this.settings.get_string('theme-path');
        return Gio.File.new_for_path(p || `${this.path}/themes/default`);
    }

    _loadTheme() {
        this._unloadTheme();
        this._icons = new Map();
        const css = this._themeDir().get_child('stylesheet.css');
        if (!css.query_exists(null))
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(css);
        this._themeCss = css;
    }

    _unloadTheme() {
        if (!this._themeCss)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._themeCss);
        this._themeCss = null;
    }

    // Returns a Gio.FileIcon if the theme overrides this app's icon, else null.
    // Cached per theme (reset in _loadTheme) so dock rebuilds don't stat the disk per app.
    iconOverride(appId) {
        if (!appId || !this._icons)
            return null;
        if (!this._icons.has(appId)) {
            const f = this._themeDir().get_child('icons').get_child(`${appId.replace(/\.desktop$/, '')}.png`);
            this._icons.set(appId, f.query_exists(null) ? new Gio.FileIcon({file: f}) : null);
        }
        return this._icons.get(appId);
    }
}
