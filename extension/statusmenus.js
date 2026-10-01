// MyDock - status menus. macOS-like status items for the Finder bar: Wi-Fi, Bluetooth, Account,
// Display, Battery, Sound, a tray chevron for third-party indicators, and the Control Center
// (GNOME's quick settings shown as one icon, restyled through the mydock-control-center class).
// Every item reuses the shell's own backends, builds its menu only when opened, and hides when its
// hardware is missing. Only active while finderbar-enabled is on. destroy() undoes everything.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';
import AccountsService from 'gi://AccountsService';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import {MprisPlayer} from 'resource:///org/gnome/shell/ui/mpris.js';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';

const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.gnome.SettingsDaemon.Power.Screen'));
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));
const ProfilesProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('net.hadess.PowerProfiles'));
const RfkillProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.gnome.SettingsDaemon.Rfkill'));

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';

// panel roles that belong to GNOME itself; everything else not starting with mydock- is "third party"
const BUILTIN_ROLES = new Set(['activities', 'appMenu', 'dateMenu', 'quickSettings', 'a11y', 'keyboard',
    'screenRecording', 'screenSharing', 'dwellClick']);

const PROFILES = {
    'performance': ['Performance', 'power-profile-performance-symbolic'],
    'balanced': ['Balanced', 'power-profile-balanced-symbolic'],
    'power-saver': ['Power Saver', 'power-profile-power-saver-symbolic'],
};

const BATTERY_STATE = {
    [UPower.DeviceState.CHARGING]: 'Charging',
    [UPower.DeviceState.DISCHARGING]: 'On Battery',
    [UPower.DeviceState.EMPTY]: 'Empty',
    [UPower.DeviceState.FULLY_CHARGED]: 'Fully Charged',
    [UPower.DeviceState.PENDING_CHARGE]: 'Power Source Connected, Not Charging',
    [UPower.DeviceState.PENDING_DISCHARGE]: 'On Battery',
};

function signalLevel(strength) {
    if (strength < 20)
        return 'none';
    if (strength < 40)
        return 'weak';
    if (strength < 50)
        return 'ok';
    return strength < 80 ? 'good' : 'excellent';
}

function formatTime(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// the matching Settings panel (gnome-<name>-panel.desktop), else gnome-control-center <name>
function openPanel(name) {
    Main.overview.hide();
    const app = Shell.AppSystem.get_default().lookup_app(`gnome-${name}-panel.desktop`);
    if (app)
        app.activate();
    else
        Util.spawn(['gnome-control-center', name]);
}

// new panel items go just left of the Control Center; FinderBar's saved order wins afterwards
function addButton(role, btn) {
    const kids = Main.panel._rightBox.get_children();
    const index = kids.indexOf(Main.panel.statusArea.quickSettings?.container);
    Main.panel.addToStatusArea(role, btn, Math.max(index, 0), 'right');
}

// ---- menu building blocks ----

function heading(text) {
    return new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false, style_class: 'mydock-status-heading'});
}

// row with a round icon chip (blue when active) + label + optional trailing icon
function chipRow(text, gicon, active = false, trailing = null) {
    const item = new PopupMenu.PopupBaseMenuItem({style_class: 'mydock-status-row'});
    const chip = new St.Bin({
        style_class: 'mydock-chip',
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({gicon, style_class: 'mydock-chip-icon'}),
    });
    if (active)
        chip.add_style_pseudo_class('checked');
    item.add_child(chip);
    item.add_child(new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    if (trailing)
        item.add_child(new St.Icon({icon_name: trailing, style_class: 'mydock-row-trailing'}));
    return item;
}

const themed = name => new Gio.ThemedIcon({name});

// slider row; set() moves it without calling onChange back
function sliderRow(value, onChange) {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, style_class: 'mydock-slider-row'});
    const slider = new Slider(value);
    slider.add_style_class_name('mydock-slider');
    item.add_child(slider);
    let syncing = false;
    slider.connect('notify::value', () => !syncing && onChange(slider.value));
    const set = v => {
        if (slider._dragging)
            return; // don't fight the user's drag
        syncing = true;
        slider.value = Math.min(Math.max(v, 0), 1);
        syncing = false;
    };
    return {item, slider, set};
}

function addSettings(menu, text, panel) {
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    menu.addAction(text, () => openPanel(panel));
}

// ---- base: one panel button with a lazily built menu ----

class StatusItem {
    constructor(role, name, iconName) {
        this._sigs = []; // undo functions, live as long as the item
        this._openDrops = []; // undo functions, live while the menu is open
        this.btn = new PanelMenu.Button(0.0, name);
        this.btn.add_style_class_name('mydock-status-button');
        this._box = new St.BoxLayout({style_class: 'mydock-status-box'});
        this.icon = new St.Icon({icon_name: iconName, style_class: 'system-status-icon'});
        this._box.add_child(this.icon);
        this.btn.add_child(this._box);
        const menu = this.btn.menu;
        menu.actor.add_style_class_name('mydock-menu');
        menu.actor.add_style_class_name('mydock-status-menu');
        // fill right before opening: PopupMenu.open() refuses an empty menu, so building on
        // open-state-changed would never get there
        const open = menu.open.bind(menu);
        menu.open = animate => {
            if (!menu.isOpen) {
                this._onOpen?.();
                this._rebuild();
            }
            open(animate);
        };
        menu.connect('open-state-changed', (_m, isOpen) => {
            if (!isOpen)
                this._run(this._openDrops);
        });
        addButton(role, this.btn);
    }

    _connect(obj, sig, fn, list = this._sigs) {
        const id = obj.connect(sig, fn);
        // not obj.disconnect(): NM.Device.disconnect() drops the network connection instead
        list.push(obj instanceof GObject.Object
            ? () => GObject.signal_handler_disconnect(obj, id)
            : () => obj.disconnect(id));
    }

    _run(list) {
        while (list.length)
            list.pop()();
    }

    setShown(on) {
        this.btn.container.visible = on;
        if (!on)
            this.btn.menu.close();
    }

    _rebuild() {
        this._run(this._openDrops);
        this.btn.menu.removeAll();
        this._fill(this.btn.menu);
    }

    // rebuild the open menu once the current burst of changes is over
    _queueRefresh() {
        if (this._refreshId || !this.btn.menu.isOpen)
            return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            if (this.btn.menu.isOpen)
                this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        this._run(this._openDrops);
        this._run(this._sigs);
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this.btn.destroy(); // the panel drops statusArea[role] on destroy
    }
}

// ---- Wi-Fi (NM.Client) ----

class WifiItem extends StatusItem {
    constructor() {
        super('mydock-wifi', 'Wi-Fi', 'network-wireless-offline-symbolic');
        this._devSigs = [];
        this._apSigs = [];
        this.setShown(false);
        this._init().catch(e => logError(e, 'MyDock: Wi-Fi'));
    }

    async _init() {
        // imported here so a system without NetworkManager only loses this item
        const {default: NM} = await import('gi://NM');
        this._NM = NM;
        const client = await new Promise((resolve, reject) => NM.Client.new_async(null, (_o, res) => {
            try {
                resolve(NM.Client.new_finish(res));
            } catch (e) {
                reject(e);
            }
        }));
        if (this._destroyed) {
            client.run_dispose();
            return;
        }
        this._client = client;
        this._connect(client, 'device-added', () => this._syncDevice());
        this._connect(client, 'device-removed', () => this._syncDevice());
        this._connect(client, 'notify::wireless-enabled', () => {
            this._syncIcon();
            this._queueRefresh();
        });
        this._syncDevice();
    }

    _syncDevice() {
        const device = this._client.get_devices().find(d => d.device_type === this._NM.DeviceType.WIFI) ?? null;
        if (device === this._device)
            return;
        this._run(this._devSigs);
        this._device = device;
        if (device)
            this._connect(device, 'notify::active-access-point', () => this._syncAp(), this._devSigs);
        this.setShown(!!device);
        this._syncAp();
    }

    _syncAp() {
        this._run(this._apSigs);
        const ap = this._device?.active_access_point ?? null;
        if (ap)
            this._connect(ap, 'notify::strength', () => this._syncIcon(), this._apSigs);
        this._syncIcon();
        this._queueRefresh();
    }

    _syncIcon() {
        const ap = this._device?.active_access_point;
        if (!this._client.wireless_enabled)
            this.icon.icon_name = 'network-wireless-disabled-symbolic';
        else if (ap)
            this.icon.icon_name = `network-wireless-signal-${signalLevel(ap.strength)}-symbolic`;
        else
            this.icon.icon_name = 'network-wireless-offline-symbolic';
    }

    // once per open, not per rebuild: scan results arriving rebuild the list
    _onOpen() {
        if (!this._client?.wireless_enabled || !this._device)
            return;
        this._device.request_scan_async(null, (d, res) => {
            try {
                d.request_scan_finish(res);
            } catch {} // NM refuses scans that come too close together
        });
    }

    _fill(menu) {
        const client = this._client;
        if (!client)
            return;
        const on = client.wireless_enabled;
        const toggle = new PopupMenu.PopupSwitchMenuItem('Wi-Fi', on, {style_class: 'mydock-status-title'});
        toggle.connect('toggled', (_i, state) => (client.wireless_enabled = state));
        menu.addMenuItem(toggle);

        const device = this._device;
        if (on && device) {
            // AP changes only matter while someone looks at the list
            this._connect(device, 'access-point-added', () => this._queueRefresh(), this._openDrops);
            this._connect(device, 'access-point-removed', () => this._queueRefresh(), this._openDrops);

            const active = device.active_access_point;
            const name = ap => this._NM.utils_ssid_to_utf8(ap.get_ssid().get_data());
            const activeName = active?.get_ssid() ? name(active) : null;
            // one row per network name, strongest access point wins
            const best = new Map();
            for (const ap of device.get_access_points()) {
                if (!ap.get_ssid())
                    continue;
                const n = name(ap);
                if (n && (!best.has(n) || best.get(n).strength < ap.strength))
                    best.set(n, ap);
            }
            const rows = [...best].filter(([n]) => n !== activeName)
                .sort((a, b) => b[1].strength - a[1].strength).slice(0, 12);
            if (activeName)
                menu.addMenuItem(this._apRow(activeName, active, true));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            if (rows.length)
                menu.addMenuItem(heading('Other networks'));
            for (const [n, ap] of rows)
                menu.addMenuItem(this._apRow(n, ap, false));
        }
        addSettings(menu, 'Network settings', 'wifi');
    }

    _apRow(name, ap, active) {
        // 0x1 = NM80211ApFlags.PRIVACY (WEP); WPA/RSN flags mean WPA
        const secure = ap.wpa_flags || ap.rsn_flags || (ap.flags & 0x1);
        const item = chipRow(name, themed(`network-wireless-signal-${signalLevel(ap.strength)}-symbolic`),
            active, secure ? 'network-wireless-encrypted-symbolic' : null);
        item.connect('activate', () => {
            if (active)
                return;
            const conn = this._client.get_connections().find(c => ap.connection_valid(c));
            if (conn)
                this._client.activate_connection_async(conn, this._device, null, null, null);
            else
                openPanel('wifi'); // new network: let Settings ask for the password
        });
        return item;
    }

    destroy() {
        this._run(this._apSigs);
        this._run(this._devSigs);
        super.destroy();
        this._client?.run_dispose(); // our own client: drop its D-Bus objects now
        this._client = null;
        this._device = null;
    }
}

// ---- Bluetooth (GnomeBluetooth.Client, as status/bluetooth.js) ----

class BluetoothItem extends StatusItem {
    constructor() {
        super('mydock-bluetooth', 'Bluetooth', 'bluetooth-active-symbolic');
        this.setShown(false);
        this._init().catch(e => logError(e, 'MyDock: Bluetooth'));
    }

    async _init() {
        const {default: GnomeBluetooth} = await import('gi://GnomeBluetooth?version=3.0');
        if (this._destroyed)
            return;
        this._ABSENT = GnomeBluetooth.AdapterState.ABSENT;
        this._client = new GnomeBluetooth.Client();
        // rfkill is how GNOME switches Bluetooth off; powering the adapter alone can't undo that
        this._rfkill = new RfkillProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill',
            '/org/gnome/SettingsDaemon/Rfkill', () => {});
        for (const sig of ['notify::default-adapter', 'notify::default-adapter-powered', 'notify::default-adapter-state']) {
            this._connect(this._client, sig, () => {
                this._sync();
                this._queueRefresh();
            });
        }
        this._sync();
    }

    _sync() {
        const c = this._client;
        this.setShown(c.default_adapter_state !== this._ABSENT);
        this.icon.icon_name = c.default_adapter_powered ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic';
    }

    _setPowered(on) {
        if (this._rfkill.g_name_owner)
            this._rfkill.BluetoothAirplaneMode = !on;
        if (!this._rfkill.g_name_owner || on)
            this._client.default_adapter_powered = on;
    }

    _fill(menu) {
        const c = this._client;
        if (!c)
            return;
        const on = c.default_adapter_powered;
        const toggle = new PopupMenu.PopupSwitchMenuItem('Bluetooth', on, {style_class: 'mydock-status-title'});
        toggle.connect('toggled', (_i, state) => this._setPowered(state));
        menu.addMenuItem(toggle);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Bluetooth settings', () => openPanel('bluetooth'));
        if (!on)
            return;

        this._connect(c, 'device-added', () => this._queueRefresh(), this._openDrops);
        this._connect(c, 'device-removed', () => this._queueRefresh(), this._openDrops);
        const store = c.get_devices();
        const devices = [];
        for (let i = 0; i < store.get_n_items(); i++) {
            const d = store.get_item(i);
            if (d.paired || d.trusted)
                devices.push(d);
        }
        devices.sort((a, b) => (b.connected - a.connected) || (a.alias ?? '').localeCompare(b.alias ?? ''));
        if (!devices.length)
            return;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addMenuItem(heading('Device'));
        for (const d of devices) {
            this._connect(d, 'notify::connected', () => this._queueRefresh(), this._openDrops);
            const item = chipRow(d.alias || d.name || 'Unknown device', themed(d.icon || 'bluetooth-active-symbolic'), d.connected);
            item.connect('activate', () => c.connect_service(d.get_object_path(), !d.connected, null, (cl, res) => {
                try {
                    cl.connect_service_finish(res);
                } catch (e) {
                    console.warn(`MyDock: Bluetooth ${d.alias}: ${e.message}`);
                }
            }));
            menu.addMenuItem(item);
        }
    }

    destroy() {
        super.destroy();
        this._client?.run_dispose(); // our own instance (not a singleton): drop its D-Bus objects now
        this._client = null;
        this._rfkill = null;
    }
}

// ---- Account (AccountsService) ----

class AccountItem extends StatusItem {
    constructor() {
        super('mydock-account', 'Account', 'avatar-default-symbolic');
    }

    _fill(menu) {
        this._user ??= AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
        const user = this._user;
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false, style_class: 'mydock-account'});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mydock-account-box'});
        const avatar = new Avatar(user, {iconSize: 56, styleClass: 'mydock-account-avatar'});
        avatar.x_align = Clutter.ActorAlign.CENTER;
        const name = new St.Label({style_class: 'mydock-account-name', x_align: Clutter.ActorAlign.CENTER});
        box.add_child(avatar);
        box.add_child(name);
        item.add_child(box);
        menu.addMenuItem(item);
        const sync = () => {
            name.text = user.is_loaded ? user.get_real_name() || user.get_user_name() : GLib.get_real_name();
            avatar.update();
        };
        this._connect(user, 'notify::is-loaded', sync, this._openDrops);
        this._connect(user, 'changed', sync, this._openDrops);
        sync();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Lock your screen', () => SystemActions.getDefault().activateLockScreen());
        addSettings(menu, 'Account Settings', 'users');
    }
}

// ---- Display (brightness, dark mode, night light) ----

class DisplayItem extends StatusItem {
    constructor() {
        super('mydock-display', 'Display', 'video-display-symbolic');
    }

    _fill(menu) {
        this._iface ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._color ??= new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._proxy ??= new BrightnessProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power',
            '/org/gnome/SettingsDaemon/Power', (_p, error) => !error && this._queueRefresh());

        menu.addMenuItem(heading('Display'));
        const valid = b => Number.isInteger(b) && b >= 0; // -1 / missing: no backlight
        const b = this._proxy.Brightness;
        if (valid(b)) {
            const row = sliderRow(b / 100, v => (this._proxy.Brightness = Math.round(v * 100)));
            menu.addMenuItem(row.item);
            this._connect(this._proxy, 'g-properties-changed', () => {
                const nb = this._proxy.Brightness;
                if (valid(nb))
                    row.set(nb / 100);
            }, this._openDrops);
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        const darkItem = chipRow('Dark Mode', themed('dark-mode-symbolic'), dark);
        darkItem.connect('activate', () => this._iface.set_string('color-scheme', dark ? 'default' : 'prefer-dark'));
        menu.addMenuItem(darkItem);

        const night = this._color.get_boolean('night-light-enabled');
        const nightItem = chipRow('Night Light', themed('night-light-symbolic'), night);
        nightItem.connect('activate', () => this._color.set_boolean('night-light-enabled', !night));
        menu.addMenuItem(nightItem);

        addSettings(menu, 'Display settings', 'display');
    }

    destroy() {
        super.destroy();
        this._proxy = null;
        this._iface = null;
        this._color = null;
    }
}

// ---- Battery (UPower display device + power profiles) ----

class BatteryItem extends StatusItem {
    constructor() {
        super('mydock-battery', 'Battery', 'battery-missing-symbolic');
        this._label = new St.Label({style_class: 'mydock-battery-label', y_align: Clutter.ActorAlign.CENTER});
        this._box.insert_child_at_index(this._label, 0);
        this.setShown(false);
        this._proxy = new UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (_p, error) => {
                if (error || this._destroyed)
                    return;
                this._connect(this._proxy, 'g-properties-changed', () => this._sync());
                this._sync();
            });
    }

    _sync() {
        const p = this._proxy;
        this.setShown(!!p.IsPresent);
        if (!p.IsPresent)
            return;
        const level = 10 * Math.floor(p.Percentage / 10);
        const charging = p.State === UPower.DeviceState.CHARGING;
        this.icon.gicon = new Gio.ThemedIcon({
            names: [p.State === UPower.DeviceState.FULLY_CHARGED || (charging && level === 100)
                ? 'battery-level-100-charged-symbolic'
                : `battery-level-${level}${charging ? '-charging' : ''}-symbolic`, p.IconName],
        });
        this._label.text = `${Math.round(p.Percentage)}%`;
        this._queueRefresh();
    }

    _fill(menu) {
        const p = this._proxy;
        let text = `${Math.round(p.Percentage)}%  ${BATTERY_STATE[p.State] ?? ''}`;
        const secs = p.State === UPower.DeviceState.CHARGING ? p.TimeToFull : p.TimeToEmpty;
        if (secs > 0)
            text += `\n${Math.floor(secs / 3600)} h ${Math.floor(secs / 60) % 60} min remaining`;
        menu.addMenuItem(heading(text));

        this._profiles ??= new ProfilesProxy(Gio.DBus.system, 'net.hadess.PowerProfiles',
            '/net/hadess/PowerProfiles', (_p, error) => {
                if (error || this._destroyed)
                    return;
                this._connect(this._profiles, 'g-properties-changed', () => this._queueRefresh());
                this._queueRefresh();
            });
        const pp = this._profiles;
        if (pp.g_name_owner && pp.Profiles) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const profile of pp.Profiles.map(v => v.Profile.unpack()).reverse()) {
                const [name, icon] = PROFILES[profile] ?? [profile, 'power-profile-balanced-symbolic'];
                const item = chipRow(name, themed(icon), profile === pp.ActiveProfile);
                item.connect('activate', () => (pp.ActiveProfile = profile));
                menu.addMenuItem(item);
            }
        }
        addSettings(menu, 'Battery settings', 'power');
    }

    destroy() {
        super.destroy();
        this._proxy = null;
        this._profiles = null;
    }
}

// ---- Sound (shell mixer + MPRIS now playing) ----

class SoundItem extends StatusItem {
    constructor() {
        super('mydock-sound', 'Sound', 'audio-volume-high-symbolic');
        this._streamSigs = [];
        this._control = Volume.getMixerControl(); // the shell's singleton: never close it
        this._connect(this._control, 'state-changed', () => this._setStream());
        this._connect(this._control, 'default-sink-changed', () => this._setStream());
        this._setStream();
    }

    _setStream() {
        this._run(this._streamSigs);
        const ready = this._control.get_state() === Gvc.MixerControlState.READY;
        this._stream = ready ? this._control.get_default_sink() : null;
        if (this._stream) {
            this._connect(this._stream, 'notify::volume', () => this._syncVolume(), this._streamSigs);
            this._connect(this._stream, 'notify::is-muted', () => this._syncVolume(), this._streamSigs);
        }
        this.setShown(!!this._stream);
        this._syncVolume();
        this._queueRefresh();
    }

    _level() {
        const s = this._stream;
        return s && !s.is_muted ? s.volume / this._control.get_vol_max_norm() : 0;
    }

    _syncVolume() {
        const v = this._level();
        const n = v <= 0 ? 0 : Math.min(3, Math.ceil(3 * v));
        this.icon.icon_name = `audio-volume-${['muted', 'low', 'medium', 'high'][n]}-symbolic`;
        this._volRow?.set(v);
    }

    _setVolume(v) {
        const s = this._stream;
        if (!s)
            return;
        const mute = v < 0.005;
        s.volume = mute ? 0 : v * this._control.get_vol_max_norm();
        if (s.is_muted !== mute)
            s.change_is_muted(mute);
        s.push_volume();
    }

    _fill(menu) {
        menu.addMenuItem(heading('Sound'));
        this._volRow = sliderRow(this._level(), v => this._setVolume(v));
        this._openDrops.push(() => (this._volRow = null));
        menu.addMenuItem(this._volRow.item);

        this._sound ??= new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        const events = new PopupMenu.PopupSwitchMenuItem('System Sounds', this._sound.get_boolean('event-sounds'));
        events.connect('toggled', (_i, state) => this._sound.set_boolean('event-sounds', state));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addMenuItem(events);

        // ponytail: one row per sink, not per port; ports of one card switch in Sound settings
        const sinks = this._control.get_sinks();
        if (sinks.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addMenuItem(heading('Output'));
            for (const sink of sinks) {
                const item = chipRow(sink.get_description() || sink.get_name(),
                    themed('audio-speakers-symbolic'), sink.id === this._stream?.id);
                item.connect('activate', () => this._control.set_default_sink(sink));
                menu.addMenuItem(item);
            }
        }

        this._buildMedia(menu);
        addSettings(menu, 'Audio settings', 'sound');
    }

    // now playing: players are looked up and followed only while the menu is open
    _buildMedia(menu) {
        const sep = new PopupMenu.PopupSeparatorMenuItem();
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false, style_class: 'mydock-media'});
        sep.visible = item.visible = false;
        menu.addMenuItem(sep);
        menu.addMenuItem(item);

        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mydock-media-box'});
        const top = new St.BoxLayout({style_class: 'mydock-media-top'});
        const cover = new St.Icon({style_class: 'mydock-media-cover'});
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({style_class: 'mydock-media-title'});
        const artist = new St.Label({style_class: 'mydock-media-artist'});
        text.add_child(title);
        text.add_child(artist);
        top.add_child(cover);
        top.add_child(text);
        const bar = new BarLevel({style_class: 'slider mydock-media-progress', x_expand: true});
        const times = new St.BoxLayout({style_class: 'mydock-media-times'});
        const elapsed = new St.Label({x_expand: true});
        const total = new St.Label();
        times.add_child(elapsed);
        times.add_child(total);
        const controls = new St.BoxLayout({style_class: 'mydock-media-controls', x_align: Clutter.ActorAlign.CENTER});
        const button = (icon, fn) => {
            const b = new St.Button({style_class: 'mydock-media-button', can_focus: true, child: new St.Icon({icon_name: icon})});
            b.connect('clicked', () => this._player && fn(this._player));
            controls.add_child(b);
            return b;
        };
        const prev = button('media-skip-backward-symbolic', p => p.previous());
        const play = button('media-playback-start-symbolic', p => p.playPause());
        const next = button('media-skip-forward-symbolic', p => p.next());
        for (const a of [top, bar, times, controls])
            col.add_child(a);
        item.add_child(col);

        const cancel = new Gio.Cancellable();
        const players = new Map(); // bus name -> [MprisPlayer, signal ids]
        this._player = null;
        this._playerName = null;
        let pos = null; // {us, t}: position at monotonic time t
        let seekedId = 0;
        let timerId = 0;

        const length = () => this._player?._playerProxy?.Metadata?.['mpris:length']?.deepUnpack() ?? 0;
        const tick = () => {
            if (!pos)
                return;
            const playing = this._player?.status === 'Playing';
            const us = pos.us + (playing ? GLib.get_monotonic_time() - pos.t : 0);
            const len = length();
            bar.value = len > 0 ? Math.min(us / len, 1) : 0;
            elapsed.text = formatTime(us);
            total.text = len > 0 ? formatTime(len) : '';
        };
        const fetchPosition = () => {
            const name = this._playerName;
            Gio.DBus.session.call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [MPRIS_PLAYER, 'Position']), new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, -1, cancel, (conn, res) => {
                    try {
                        const [v] = conn.call_finish(res).deepUnpack();
                        if (name === this._playerName) {
                            pos = {us: Number(v.deepUnpack()), t: GLib.get_monotonic_time()};
                            tick();
                        }
                    } catch {} // cancelled, or the player has no position
                });
        };
        const sync = () => {
            const all = [...players.values()].map(([p]) => p);
            const player = all.find(p => p.status === 'Playing') ?? all.find(p => p.status === 'Paused') ?? null;
            const name = player ? [...players].find(([, [p]]) => p === player)[0] : null;
            if (name !== this._playerName) {
                if (seekedId)
                    Gio.DBus.session.signal_unsubscribe(seekedId);
                seekedId = name ? Gio.DBus.session.signal_subscribe(name, MPRIS_PLAYER, 'Seeked', MPRIS_PATH, null,
                    Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                        pos = {us: Number(params.deepUnpack()[0]), t: GLib.get_monotonic_time()};
                        tick();
                    }) : 0;
                this._playerName = name;
                pos = null;
            }
            this._player = player;
            sep.visible = item.visible = !!player;
            const playing = player?.status === 'Playing';
            if (playing && !timerId) {
                timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
                    tick();
                    return GLib.SOURCE_CONTINUE;
                });
            } else if (!playing && timerId) {
                GLib.source_remove(timerId);
                timerId = 0;
            }
            if (!player)
                return;
            cover.gicon = player.trackCoverUrl
                ? new Gio.FileIcon({file: Gio.File.new_for_uri(player.trackCoverUrl)})
                : themed('audio-x-generic-symbolic');
            title.text = player.trackTitle ?? '';
            artist.text = player.trackArtists?.join(', ') ?? '';
            play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            prev.reactive = !!player.canGoPrevious;
            next.reactive = !!player.canGoNext;
            fetchPosition(); // status or track changed: position jumps
        };
        const add = name => {
            const p = new MprisPlayer(name);
            players.set(name, [p, [
                p.connect('changed', sync),
                p.connect('closed', () => {
                    players.delete(name);
                    sync();
                }),
            ]]);
        };

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, cancel, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(add);
                } catch {} // cancelled: menu closed meanwhile
            });

        this._openDrops.push(() => {
            cancel.cancel();
            if (seekedId)
                Gio.DBus.session.signal_unsubscribe(seekedId);
            if (timerId)
                GLib.source_remove(timerId);
            for (const [p, ids] of players.values()) {
                ids.forEach(id => p.disconnect(id));
                // MprisPlayer has no destroy(): unhook its proxies so it can be collected
                p._mprisProxy?.disconnectObject(p);
                p._playerProxy?.disconnectObject(p);
            }
            players.clear();
            this._player = null;
            this._playerName = null;
        });
    }

    destroy() {
        this._run(this._streamSigs);
        super.destroy();
        this._stream = null;
        this._control = null;
        this._sound = null;
    }
}

// ---- tray chevron: collapses / expands third-party indicators ----

class TrayItem {
    constructor() {
        this._sigs = [];
        this._hidden = new Map(); // container -> its visibility before we hid it
        this._collapsed = true;
        this.btn = new PanelMenu.Button(0.0, 'Tray', true);
        this.btn.add_style_class_name('mydock-status-button');
        this.btn.add_style_class_name('mydock-tray-button');
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.btn.add_child(this._icon);
        this.btn.connect('button-press-event', () => this._toggle());
        this.btn.connect('touch-event', (_a, ev) => ev.type() === Clutter.EventType.TOUCH_BEGIN
            ? this._toggle() : Clutter.EVENT_PROPAGATE);
        this.btn.connect('key-press-event', (_a, ev) => [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space]
            .includes(ev.get_key_symbol()) ? this._toggle() : Clutter.EVENT_PROPAGATE);
        addButton('mydock-tray', this.btn);

        const p = Main.panel;
        for (const box of [p._leftBox, p._centerBox, p._rightBox]) {
            for (const sig of ['child-added', 'child-removed']) {
                const id = box.connect(sig, () => this._queueSync());
                this._sigs.push(() => box.disconnect(id));
            }
        }
        this._sync();
    }

    _toggle() {
        this._collapsed = !this._collapsed;
        this._sync();
        return Clutter.EVENT_STOP;
    }

    _queueSync() {
        this._syncId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const area = Main.panel.statusArea;
        const current = new Set(Object.keys(area)
            .filter(r => !r.startsWith('mydock-') && !BUILTIN_ROLES.has(r))
            .map(r => area[r]?.container).filter(Boolean));
        for (const c of [...this._hidden.keys()]) {
            if (!current.has(c))
                this._hidden.delete(c); // indicator went away
        }
        if (this._collapsed) {
            for (const c of current) {
                if (!this._hidden.has(c)) {
                    this._hidden.set(c, c.visible);
                    c.visible = false;
                }
            }
        } else {
            this._restore();
        }
        this.btn.container.visible = current.size > 0;
        this._icon.icon_name = this._collapsed ? 'pan-start-symbolic' : 'pan-end-symbolic';
        this.btn.accessible_name = this._collapsed ? 'Show tray icons' : 'Hide tray icons';
    }

    _restore() {
        for (const [c, visible] of this._hidden)
            c.visible = visible;
        this._hidden.clear();
    }

    destroy() {
        while (this._sigs.length)
            this._sigs.pop()();
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        this._sync(); // drop containers of indicators that left meanwhile
        this._restore();
        this.btn.destroy();
    }
}

// ---- Control Center: GNOME quick settings as one icon ----

// QuickSettings indicator properties shown by our own status menus instead
const DUPLICATE_INDICATORS = ['_network', '_bluetooth', '_volumeOutput', '_system', '_brightness',
    '_backlight', '_darkMode', '_nightLight', '_powerProfiles', '_rfkill'];

class ControlCenter {
    constructor(ext) {
        const qs = Main.panel.statusArea.quickSettings;
        if (!qs)
            return;
        this._qs = qs;
        // detach only the indicators our own menus replace; privacy ones (camera, mic in use,
        // location, screen sharing) stay. Detached, not hidden: they re-sync their own visibility.
        const box = qs._indicators;
        this._detached = [];
        for (const name of DUPLICATE_INDICATORS) {
            const actor = qs[name];
            if (!box || !actor || actor.get_parent() !== box)
                continue;
            this._detached.push([actor, box.get_children().indexOf(actor)]);
            box.remove_child(actor);
        }
        this._box = box;
        // optional theme icon, else the stock settings symbol
        const file = Gio.File.new_for_path(`${ext.path}/icons/mydock-control-center-symbolic.svg`);
        this._icon = new St.Icon({
            gicon: file.query_exists(null)
                ? new Gio.FileIcon({file})
                : new Gio.ThemedIcon({names: ['org.gnome.Settings-symbolic', 'emblem-system-symbolic']}),
            style_class: 'system-status-icon mydock-control-center-icon',
        });
        // inside the indicator box (PanelMenu.Button only lays out its first child), last so the
        // kept privacy indicators sit left of it
        if (box)
            box.add_child(this._icon);
        else
            qs.insert_child_at_index(this._icon, 0);
        qs.add_style_class_name('mydock-control-center-button');
        qs.menu.actor.add_style_class_name('mydock-control-center');
    }

    destroy() {
        if (!this._qs)
            return;
        this._icon.destroy();
        // undo in reverse: each index was taken after the earlier removals
        for (const [actor, index] of this._detached.reverse())
            this._box.insert_child_at_index(actor, Math.min(index, this._box.get_n_children()));
        this._detached = [];
        this._qs.remove_style_class_name('mydock-control-center-button');
        this._qs.menu.actor.remove_style_class_name('mydock-control-center');
        this._qs = null;
        this._box = null;
    }
}

// built in this order, each placed left of the Control Center, so the bar reads left to right
const PARTS = [ControlCenter, WifiItem, BluetoothItem, AccountItem, DisplayItem, BatteryItem, SoundItem, TrayItem];

export class StatusMenus {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.settings;
        this._parts = [];
        // lives on the Finder bar: nothing to do while it is off
        this._enabledId = this._settings.connect('changed::finderbar-enabled', () => this._sync());
        this._sync();
    }

    _sync() {
        const on = this._settings.get_boolean('finderbar-enabled');
        if (on && !this._parts.length) {
            for (const Part of PARTS) {
                try {
                    this._parts.push(new Part(this._ext));
                } catch (e) {
                    logError(e, `MyDock: ${Part.name} failed to start`);
                }
            }
        } else if (!on) {
            this._teardown();
        }
    }

    _teardown() {
        for (const part of this._parts.reverse()) {
            try {
                part.destroy();
            } catch (e) {
                logError(e, 'MyDock: status menu failed to stop');
            }
        }
        this._parts = [];
    }

    destroy() {
        this._settings.disconnect(this._enabledId);
        this._teardown();
        this._ext = null;
        this._settings = null;
    }
}
