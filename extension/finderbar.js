// MyDock - Finder bar. Restyles and rearranges the existing Main.panel into a macOS-like menu bar:
// logo menu + focused app name on the left, quick settings then clock on the right, optional blur.
// destroy() puts every moved/hidden panel piece back where it was.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

const STORE_APPS = ['snap-store_snap-store.desktop', 'io.snapcraft.Store.desktop', 'org.gnome.Software.desktop'];
const FALLBACK_APP = 'org.gnome.Nautilus.desktop';
// strftime conversions that show seconds (%S %s %T %r %X %c %f, with optional flags/E/O); %% is a literal
const SECONDS_RE = /%[-_0^#]*[EO]?[sSTrXcf]/;

export class FinderBar {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._sigs = [];
        this._bindings = [];
        const panel = Main.panel;

        // remember original state for destroy()
        const dateBox = panel.statusArea.dateMenu?.container;
        this._dateParent = dateBox?.get_parent() ?? null;
        this._dateIndex = this._dateParent ? this._dateParent.get_children().indexOf(dateBox) : -1;
        this._activitiesVisible = panel.statusArea.activities?.container.visible ?? false;
        this._bannerAlignment = Main.messageTray.bannerAlignment;

        panel.add_style_class_name('mydock-finderbar');

        this._buildLogo();
        this._buildAppName();
        this._buildClock();
        this._layout();
        this._syncBlur();

        this._connect(this._settings, 'changed::finderbar-blur', () => this._syncBlur());
        this._connect(this._settings, 'changed::logo-path', () => this._syncLogo());
        this._connect(this._settings, 'changed::time-format', () => this._tick(true));
        this._connect(this._settings, 'changed::stage-manager',
            () => this._stageItem.setToggleState(this._settings.get_boolean('stage-manager')));
        // session mode changes (e.g. after unlock) rebuild the panel boxes and undo our layout
        this._connect(Main.sessionMode, 'updated', () => this._layout());
    }

    _connect(obj, sig, fn) {
        this._sigs.push([obj, obj.connect(sig, fn)]);
    }

    // ---- left: logo menu ----

    _buildLogo() {
        const btn = new PanelMenu.Button(0.0, 'MyDock Menu');
        btn.add_style_class_name('mydock-logo-button');
        this._logoIcon = new St.Icon({style_class: 'system-status-icon mydock-logo-icon'});
        btn.add_child(this._logoIcon);
        this._logoButton = btn;
        this._syncLogo();

        const menu = btn.menu;
        const appSys = Shell.AppSystem.get_default();

        menu.addAction('About This Computer', () => {
            const about = appSys.lookup_app('gnome-about-panel.desktop');
            if (about)
                about.activate();
            else
                Util.spawn(['gnome-control-center', 'system', 'about']);
        });
        menu.addAction('System Settings...', () => {
            const s = appSys.lookup_app('org.gnome.Settings.desktop');
            if (s)
                s.activate();
            else
                Util.spawn(['gnome-control-center']);
        });
        const store = STORE_APPS.map(id => appSys.lookup_app(id)).find(a => a);
        if (store)
            menu.addAction('App Store...', () => store.activate());

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._stageItem = new PopupMenu.PopupSwitchMenuItem('Stage Manager',
            this._settings.get_boolean('stage-manager'));
        this._stageItem.connect('toggled', (_item, state) => this._settings.set_boolean('stage-manager', state));
        menu.addMenuItem(this._stageItem);
        menu.addAction('MyDock Settings...', () => this._ext.openPreferences());

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const actions = SystemActions.getDefault();
        for (const [label, prop, fn] of [
            ['Sleep', 'can-suspend', () => actions.activateSuspend()],
            ['Restart...', 'can-restart', () => actions.activateRestart()],
            ['Shut Down...', 'can-power-off', () => actions.activatePowerOff()],
            ['Lock Screen', 'can-lock-screen', () => actions.activateLockScreen()],
            ['Log Out...', 'can-logout', () => actions.activateLogout()],
        ]) {
            const item = menu.addAction(label, fn);
            this._bindings.push(actions.bind_property(prop, item, 'visible', GObject.BindingFlags.SYNC_CREATE));
        }

        Main.panel.addToStatusArea('mydock-logo', btn, 0, 'left');
    }

    _syncLogo() {
        const path = this._settings.get_string('logo-path');
        const file = path ? Gio.File.new_for_path(path) : null;
        this._logoIcon.gicon = file?.query_exists(null)
            ? new Gio.FileIcon({file})
            : new Gio.ThemedIcon({names: ['distributor-logo', 'start-here-symbolic']});
    }

    // ---- left: focused app name + its app menu ----

    _buildAppName() {
        const btn = new PanelMenu.Button(0.0, 'App Menu', true);
        btn.add_style_class_name('mydock-appname-button');
        this._appLabel = new St.Label({
            style_class: 'mydock-appname',
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.add_child(this._appLabel);
        this._appMenu = new AppMenu(btn);
        btn.setMenu(this._appMenu);
        this._appButton = btn;
        Main.panel.addToStatusArea('mydock-appname', btn, 1, 'left');

        this._tracker = Shell.WindowTracker.get_default();
        this._connect(this._tracker, 'notify::focus-app', () => this._syncApp());
        this._syncApp();
    }

    _syncApp() {
        // nothing focused -> behave like macOS Finder: show the file manager
        const app = this._tracker.focus_app ??
            Shell.AppSystem.get_default().lookup_app(FALLBACK_APP);
        this._appLabel.text = app?.get_name() ?? 'Desktop';
        this._appMenu.setApp(app);
    }

    // ---- right: clock ----

    _buildClock() {
        this._clockDisplay = Main.panel.statusArea.dateMenu?._clockDisplay ?? null;
        if (!this._clockDisplay)
            return;
        this._clockLabel = new St.Label({
            style_class: 'clock mydock-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockDisplay.get_parent().insert_child_above(this._clockLabel, this._clockDisplay);
        this._clockWasVisible = this._clockDisplay.visible;
        this._clockDisplay.hide();
        // WallClock (same as the shell's clock) wakes once a minute, aligned to the minute and
        // resynced after suspend / time changes; once a second only if the format shows seconds
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connect('notify::clock', () => this._tick(false));
        this._tick(true);
    }

    _tick(force) {
        if (!this._clockLabel)
            return;
        const format = this._settings.get_string('time-format');
        if (force) {
            // only on build / format change: setting it re-runs the WallClock update
            const secs = SECONDS_RE.test(format.replaceAll('%%', ''));
            if (this._wallClock.force_seconds !== secs)
                this._wallClock.force_seconds = secs;
        }
        const now = GLib.DateTime.new_now_local();
        // invalid format returns null: fall back to the shell's own clock text
        const text = now.format(format) || this._clockDisplay.text;
        if (force || text !== this._clockLabel.text)
            this._clockLabel.text = text;
    }

    // ---- layout / blur ----

    _layout() {
        const panel = Main.panel;
        panel.statusArea.activities?.container.hide();
        const dateBox = panel.statusArea.dateMenu?.container;
        if (dateBox && dateBox.get_parent() !== panel._rightBox) {
            dateBox.get_parent()?.remove_child(dateBox);
            panel._rightBox.add_child(dateBox);
        }
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
    }

    _syncBlur() {
        const on = this._settings.get_boolean('finderbar-blur');
        if (on && !this._blur) {
            this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius: 20, brightness: 1.0});
            Main.panel.add_effect_with_name('mydock-finderbar-blur', this._blur);
            Main.panel.add_style_class_name('mydock-finderbar-blur');
        } else if (!on && this._blur) {
            Main.panel.remove_effect(this._blur);
            this._blur = null;
            Main.panel.remove_style_class_name('mydock-finderbar-blur');
        }
    }

    destroy() {
        for (const [obj, id] of this._sigs)
            obj.disconnect(id);
        this._sigs = [];
        for (const b of this._bindings)
            b.unbind();
        this._bindings = [];

        if (this._wallClock) {
            this._wallClock.run_dispose(); // stops its timer now instead of at GC
            this._wallClock = null;
        }
        if (this._clockLabel) {
            this._clockLabel.destroy();
            this._clockLabel = null;
            this._clockDisplay.visible = this._clockWasVisible;
        }

        this._appButton.destroy(); // also destroys its menu
        this._logoButton.destroy();

        if (this._blur) {
            Main.panel.remove_effect(this._blur);
            this._blur = null;
        }
        Main.panel.remove_style_class_name('mydock-finderbar-blur');
        Main.panel.remove_style_class_name('mydock-finderbar');

        const panel = Main.panel;
        const dateBox = panel.statusArea.dateMenu?.container;
        if (dateBox && this._dateParent && dateBox.get_parent() !== this._dateParent) {
            dateBox.get_parent()?.remove_child(dateBox);
            this._dateParent.insert_child_at_index(dateBox,
                Math.min(Math.max(this._dateIndex, 0), this._dateParent.get_n_children()));
        }
        // Clutter.Actor has no set_visible(); use the property
        if (panel.statusArea.activities)
            panel.statusArea.activities.container.visible = this._activitiesVisible;
        Main.messageTray.bannerAlignment = this._bannerAlignment;

        this._ext = null;
        this._settings = null;
    }
}
