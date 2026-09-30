// MyDock - Window buttons. Moves close / minimize / maximize to the left of every title bar in
// macOS order, and optionally paints them as red / yellow / green "traffic lights".
// destroy() puts the user's own button layout back and removes our CSS from their gtk.css files.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WM_SCHEMA = 'org.gnome.desktop.wm.preferences';
const LAYOUT = 'close,minimize,maximize:';
const START = '/* mydock-traffic-lights start: managed by MY DOCK FINDER FOR LINUX, do not edit */';
const END = '/* mydock-traffic-lights end */';

const GTK3_CSS = `
headerbar button.titlebutton, .titlebar button.titlebutton {
  min-width: 14px; min-height: 14px; padding: 0; margin: 0 3px;
  border: none; border-radius: 50%; box-shadow: none; background-image: none;
  color: transparent; -gtk-icon-shadow: none;
}
headerbar button.titlebutton:hover, .titlebar button.titlebutton:hover { color: rgba(0, 0, 0, 0.55); }
headerbar button.titlebutton.close, .titlebar button.titlebutton.close { background-color: #ff5f57; }
headerbar button.titlebutton.minimize, .titlebar button.titlebutton.minimize { background-color: #febc2e; }
headerbar button.titlebutton.maximize, .titlebar button.titlebutton.maximize { background-color: #28c840; }
headerbar:backdrop button.titlebutton, .titlebar:backdrop button.titlebutton { background-color: rgba(128, 128, 128, 0.35); }
`;

const GTK4_CSS = `
windowcontrols > button { min-width: 14px; min-height: 14px; padding: 0; margin: 0 3px; }
windowcontrols > button > image {
  min-width: 12px; min-height: 12px; padding: 1px; border-radius: 50%;
  box-shadow: none; color: transparent;
}
windowcontrols > button:hover > image { color: rgba(0, 0, 0, 0.55); }
windowcontrols > button.close > image { background-color: #ff5f57; }
windowcontrols > button.minimize > image { background-color: #febc2e; }
windowcontrols > button.maximize > image { background-color: #28c840; }
windowcontrols > button:backdrop > image { background-color: rgba(128, 128, 128, 0.35); }
`;

const CSS_FILES = [['gtk-3.0', GTK3_CSS], ['gtk-4.0', GTK4_CSS]];

export class WindowButtons {
    constructor(ext) {
        this._settings = ext.settings;
        this._wm = new Gio.Settings({schema_id: WM_SCHEMA});

        // Only remember the original once: after a shell crash the saved value is still the
        // user's real layout, and the live value is already ours.
        const current = this._wm.get_string('button-layout');
        if (!this._settings.get_string('saved-button-layout') && current !== LAYOUT)
            this._settings.set_string('saved-button-layout', current);
        if (current !== LAYOUT)
            this._wm.set_string('button-layout', LAYOUT);

        this._syncTrafficLights();
        this._sigId = this._settings.connect('changed::traffic-lights', () => this._syncTrafficLights());
    }

    _syncTrafficLights() {
        const on = this._settings.get_boolean('traffic-lights');
        for (const [dir, css] of CSS_FILES)
            writeBlock(`${GLib.get_user_config_dir()}/${dir}/gtk.css`, on ? css : null);
    }

    destroy() {
        this._settings.disconnect(this._sigId);

        // The shell disables extensions while the screen is locked; leave everything in place
        // so apps do not flip their buttons around on every lock / unlock.
        if (!Main.sessionMode.isLocked) {
            const saved = this._settings.get_string('saved-button-layout');
            // If the user picked another layout meanwhile, keep their choice.
            if (saved && this._wm.get_string('button-layout') === LAYOUT)
                this._wm.set_string('button-layout', saved);
            this._settings.reset('saved-button-layout');
            for (const [dir] of CSS_FILES)
                writeBlock(`${GLib.get_user_config_dir()}/${dir}/gtk.css`, null);
        }

        this._wm = null;
        this._settings = null;
    }
}

// Replaces our marked block in a gtk.css file with `css`, or removes it when `css` is null.
// Never touches anything outside the markers, and deletes nothing it did not write.
function writeBlock(path, css) {
    const file = Gio.File.new_for_path(path);
    let text = '';
    try {
        const [, bytes] = file.load_contents(null);
        text = new TextDecoder().decode(bytes);
    } catch {
        if (css === null)
            return; // no file, nothing to remove
    }

    const start = text.indexOf(START);
    const end = text.indexOf(END, start);
    let rest = text;
    if (start >= 0 && end >= 0)
        rest = (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, '\n\n');
    const next = css === null ? rest : `${rest.trimEnd()}${rest.trim() ? '\n\n' : ''}${START}${css}${END}\n`;
    if (next === text)
        return;

    try {
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
        file.replace_contents(new TextEncoder().encode(next), null, false,
            Gio.FileCreateFlags.NONE, null);
    } catch (e) {
        logError(e, `MyDock: could not update ${path}`);
    }
}
