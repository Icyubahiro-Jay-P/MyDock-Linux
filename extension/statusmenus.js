// MyDock - status menus. macOS-like status items for the Finder bar: Wi-Fi, Bluetooth, Account,
// Display, Battery, Sound, a tray chevron for third-party indicators, and the Control Center
// (our own tile panel, standing in for GNOME's quick settings button).
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

// new panel items go just left of the Control Center (ours, else GNOME's quick settings);
// FinderBar's saved order wins afterwards
function addButton(role, btn) {
    const area = Main.panel.statusArea;
    const kids = Main.panel._rightBox.get_children();
    const index = kids.indexOf((area['mydock-control-center'] ?? area.quickSettings)?.container);
    Main.panel.addToStatusArea(role, btn, Math.max(index, 0), 'right');
}

// ---- menu building blocks ----

function heading(text) {
    return new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false, style_class: 'mydock-status-heading'});
}

// round icon chip, blue (:checked) when on; a button when it has its own click
function chip(gicon, on = false, button = false) {
    const actor = new (button ? St.Button : St.Bin)({
        style_class: 'mydock-chip',
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({gicon, style_class: 'mydock-chip-icon'}),
    });
    if (on)
        actor.add_style_pseudo_class('checked');
    return actor;
}

// row with a round icon chip (blue when active) + label + optional trailing icon
function chipRow(text, gicon, active = false, trailing = null) {
    const item = new PopupMenu.PopupBaseMenuItem({style_class: 'mydock-status-row'});
    item.add_child(chip(gicon, active));
    item.add_child(new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    if (trailing)
        item.add_child(new St.Icon({icon_name: trailing, style_class: 'mydock-row-trailing'}));
    return item;
}

const themed = name => new Gio.ThemedIcon({name});

// pill slider with its value (0-100) written on the knob; set() moves it without calling onChange back
function valueSlider(value, onChange) {
    const slider = new Slider(value);
    slider.add_style_class_name('mydock-slider');
    slider.x_expand = true;
    // BinLayout only honours x_align START for an x_expand child, else it centres it
    const label = new St.Label({
        style_class: 'mydock-slider-value',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
    actor.add_child(slider);
    actor.add_child(label);
    // ui/slider.js draws the knob centre at r + (width - 2r) * value, r = ceil(radius + border)
    const place = () => {
        if (!actor.has_allocation())
            return; // not laid out yet: notify::width brings us back
        const r = Math.ceil(slider._handleRadius + slider._handleBorderWidth);
        let x = r + (slider.width - 2 * r) * slider.value;
        if (slider.get_text_direction() === Clutter.TextDirection.RTL)
            x = slider.width - x;
        label.translation_x = Math.round(x - label.width / 2);
    };
    const show = () => {
        label.text = `${Math.round(slider.value * 100)}`;
        place();
    };
    slider.connect('notify::width', place);
    label.connect('notify::width', place);
    show();

    let syncing = false;
    slider.connect('notify::value', () => {
        show();
        if (!syncing)
            onChange(slider.value);
    });
    const set = v => {
        if (slider._dragging)
            return; // don't fight the user's drag
        syncing = true;
        slider.value = Math.min(Math.max(v, 0), 1);
        syncing = false;
    };
    return {actor, slider, set};
}

function sliderItem(actor) {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false, style_class: 'mydock-slider-row'});
    item.add_child(actor);
    return item;
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
        // made up front so the Control Center finds it ready
        this._proxy = new BrightnessProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Power',
            '/org/gnome/SettingsDaemon/Power', (_p, error) => !error && this._queueRefresh());
    }

    // brightness slider that follows the backlight until `drops` run; null without a backlight
    brightnessSlider(drops) {
        const valid = b => Number.isInteger(b) && b >= 0; // -1 / missing: no backlight
        const b = this._proxy.Brightness;
        if (!valid(b))
            return null;
        const s = valueSlider(b / 100, v => (this._proxy.Brightness = Math.round(v * 100)));
        this._connect(this._proxy, 'g-properties-changed', () => {
            const nb = this._proxy.Brightness;
            if (valid(nb))
                s.set(nb / 100);
        }, drops);
        return s;
    }

    _fill(menu) {
        this._iface ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._color ??= new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});

        menu.addMenuItem(heading('Display'));
        const s = this.brightnessSlider(this._openDrops);
        if (s)
            menu.addMenuItem(sliderItem(s.actor));
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
        this._volSliders = new Set(); // open volume sliders (this menu, Control Center)
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
        this._volSliders.forEach(s => s.set(v));
    }

    // volume slider that follows the default sink until `drops` run
    volumeSlider(drops) {
        const s = valueSlider(this._level(), v => this._setVolume(v));
        this._volSliders.add(s);
        drops.push(() => this._volSliders.delete(s));
        return s;
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
        menu.addMenuItem(sliderItem(this.volumeSlider(this._openDrops).actor));

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

        const sep = new PopupMenu.PopupSeparatorMenuItem();
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false, style_class: 'mydock-media'});
        const media = nowPlaying(this._openDrops);
        item.add_child(media);
        for (const a of [sep, item]) {
            media.bind_property('visible', a, 'visible', GObject.BindingFlags.SYNC_CREATE);
            menu.addMenuItem(a);
        }
        addSettings(menu, 'Audio settings', 'sound');
    }

    destroy() {
        this._run(this._streamSigs);
        super.destroy();
        this._stream = null;
        this._control = null;
        this._sound = null;
    }
}

// now playing for the playing (else paused) MPRIS player, looked up and followed until `drops`
// run; the widget hides while there is none. compact (Control Center): cover, title and buttons
// on one line, no artist, progress or times.
function nowPlaying(drops, compact = false) {
    const col = new St.BoxLayout({vertical: true, x_expand: true, visible: false, style_class: 'mydock-media-box'});
    const top = new St.BoxLayout({style_class: 'mydock-media-top', x_expand: true});
    // a Bin, not an Icon: St clips a background-image to border-radius but never an icon
    const coverIcon = new St.Icon({style_class: 'mydock-media-cover-icon', x_expand: true, y_expand: true});
    const cover = new St.Bin({style_class: 'mydock-media-cover', y_align: Clutter.ActorAlign.CENTER, child: coverIcon});
    const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const title = new St.Label({style_class: 'mydock-media-title'});
    const artist = new St.Label({style_class: 'mydock-media-artist', visible: !compact});
    text.add_child(title);
    text.add_child(artist);
    top.add_child(cover);
    top.add_child(text);
    col.add_child(top);
    const controls = new St.BoxLayout({style_class: 'mydock-media-controls', x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER});
    let player = null;
    const button = (icon, fn) => {
        const b = new St.Button({style_class: 'mydock-media-button', can_focus: true, child: new St.Icon({icon_name: icon})});
        b.connect('clicked', () => player && fn(player));
        controls.add_child(b);
        return b;
    };
    const prev = button('media-skip-backward-symbolic', p => p.previous());
    const play = button('media-playback-start-symbolic', p => p.playPause());
    const next = button('media-skip-forward-symbolic', p => p.next());
    let bar = null, elapsed, total;
    if (compact) {
        col.add_style_class_name('mydock-media-compact');
        top.add_child(controls);
    } else {
        bar = new BarLevel({style_class: 'slider mydock-media-progress', x_expand: true});
        const times = new St.BoxLayout({style_class: 'mydock-media-times'});
        elapsed = new St.Label({x_expand: true});
        total = new St.Label();
        times.add_child(elapsed);
        times.add_child(total);
        for (const a of [bar, times, controls])
            col.add_child(a);
    }

    const cancel = new Gio.Cancellable();
    const players = new Map(); // bus name -> [MprisPlayer, signal ids]
    let playerName = null;
    let pos = null; // {us, t}: position at monotonic time t
    let seekedId = 0;
    let timerId = 0;

    const length = () => player?._playerProxy?.Metadata?.['mpris:length']?.deepUnpack() ?? 0;
    const tick = () => {
        if (!pos || !bar)
            return;
        const playing = player?.status === 'Playing';
        const us = pos.us + (playing ? GLib.get_monotonic_time() - pos.t : 0);
        const len = length();
        bar.value = len > 0 ? Math.min(us / len, 1) : 0;
        elapsed.text = formatTime(us);
        total.text = len > 0 ? formatTime(len) : '';
    };
    const fetchPosition = () => {
        const name = playerName;
        Gio.DBus.session.call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER, 'Position']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, cancel, (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    if (name === playerName) {
                        pos = {us: Number(v.deepUnpack()), t: GLib.get_monotonic_time()};
                        tick();
                    }
                } catch {} // cancelled, or the player has no position
            });
    };
    const sync = () => {
        const all = [...players.values()].map(([p]) => p);
        const found = all.find(p => p.status === 'Playing') ?? all.find(p => p.status === 'Paused') ?? null;
        const name = found ? [...players].find(([, [p]]) => p === found)[0] : null;
        if (name !== playerName) {
            if (seekedId)
                Gio.DBus.session.signal_unsubscribe(seekedId);
            seekedId = name ? Gio.DBus.session.signal_subscribe(name, MPRIS_PLAYER, 'Seeked', MPRIS_PATH, null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    pos = {us: Number(params.deepUnpack()[0]), t: GLib.get_monotonic_time()};
                    tick();
                }) : 0;
            playerName = name;
            pos = null;
        }
        player = found;
        col.visible = !!player;
        const playing = player?.status === 'Playing';
        if (playing && !timerId && bar) {
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
        // ponytail: only local art (file://) gets rounded corners; http(s) art (Spotify) stays a
        // square icon until it is downloaded to a cache file first
        const url = player.trackCoverUrl ?? '';
        const local = url.startsWith('file://') ? Gio.File.new_for_uri(url).get_path() : null;
        cover.style = local ? `background-image: url("${local.replace(/["\\]/g, '\\$&')}");` : null;
        coverIcon.visible = !local;
        coverIcon.gicon = url && !local
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(url)})
            : themed('audio-x-generic-symbolic');
        title.text = player.trackTitle ?? '';
        artist.text = player.trackArtists?.join(', ') ?? '';
        play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        prev.reactive = !!player.canGoPrevious;
        next.reactive = !!player.canGoNext;
        if (bar)
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

    drops.push(() => {
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
        player = null;
        playerName = null;
    });
    return col;
}

// ---- tray chevron: third-party indicators (AppIndicator / StatusNotifierItem apps such as Spotify,
// Discord or Steam, plus other extensions' buttons) leave the bar and are listed in its menu, one row
// per app (reference screenshot 51). The AppIndicator host is Ubuntu's ubuntu-appindicators
// extension: it puts each app in Main.panel.statusArea as 'appindicator-<id>', so we only collect.
// ponytail: without that host (non-Ubuntu session) nothing registers SNI apps; we don't run our own
// StatusNotifierWatcher, install the AppIndicator extension instead ----

// first St.Icon inside an indicator, the one its row's chip copies
function findIcon(actor) {
    if (actor instanceof St.Icon)
        return actor;
    for (const child of actor.get_children()) {
        const icon = findIcon(child);
        if (icon)
            return icon;
    }
    return null;
}

class TrayItem extends StatusItem {
    constructor() {
        super('mydock-tray', 'Background Apps', 'pan-down-symbolic');
        this.btn.add_style_class_name('mydock-tray-button');
        this.btn.menu.actor.add_style_class_name('mydock-tray-menu');
        this._hidden = new Map(); // container -> its visibility before we hid it
        const p = Main.panel;
        for (const box of [p._leftBox, p._centerBox, p._rightBox]) {
            for (const sig of ['child-added', 'child-removed'])
                this._connect(box, sig, () => this._queueSync());
        }
        this._sync();
    }

    _indicators() {
        const area = Main.panel.statusArea;
        return Object.keys(area)
            .filter(r => !r.startsWith('mydock-') && !BUILTIN_ROLES.has(r))
            .map(r => area[r]).filter(ind => ind?.container);
    }

    _queueSync() {
        this._syncId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const current = new Set(this._indicators().map(ind => ind.container));
        for (const c of [...this._hidden.keys()]) {
            if (!current.has(c))
                this._hidden.delete(c); // indicator went away
        }
        for (const c of current) {
            if (!this._hidden.has(c))
                this._hidden.set(c, c.visible);
            c.visible = false; // again: the shell re-shows a container it moves (tray-pos change)
        }
        this.btn.container.visible = current.size > 0;
    }

    _fill(menu) {
        for (const ind of this._indicators()) {
            if (!ind.visible)
                continue; // not ready yet, or a passive (idle) AppIndicator
            const sni = ind._indicator; // ubuntu-appindicators' StatusNotifierItem
            const name = sni?.title || sni?.id || ind._icon?.wm_class || ind.accessible_name || 'App';
            const icon = findIcon(ind);
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'mydock-status-row'});
            const c = chip(icon?.gicon ?? (icon?.icon_name ? themed(icon.icon_name) : null));
            if (!icon && ind._icon instanceof Clutter.Actor) // legacy XEmbed tray icon: no St.Icon to copy
                c.child = new Clutter.Clone({source: ind._icon});
            item.add_child(c);
            item.add_child(new St.Label({text: name, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            item.connect('activate', (_i, event) => this._activate(ind, event));
            menu.addMenuItem(item);
        }
        if (menu.isEmpty())
            menu.addMenuItem(heading('No apps in the background'));
    }

    // what a left click on the indicator itself does: its menu, else the app's own Activate
    _activate(ind, event) {
        this.btn.menu.close();
        const menu = ind.menu;
        if (menu?.numMenuItems) {
            // its own button is hidden, so the menu would have nothing to point at: anchor it to
            // the chevron while open
            const source = menu.sourceActor;
            menu.sourceActor = this.btn;
            menu.toggle();
            if (menu.isOpen) {
                const unanchor = (close = true) => {
                    if (this._unanchor === unanchor)
                        this._unanchor = null;
                    menu.disconnect(id);
                    if (close)
                        menu.close();
                    menu.sourceActor = source;
                };
                const id = menu.connect('open-state-changed', (_m, open) => !open && unanchor(false));
                this._unanchor = unanchor;
                return;
            }
            menu.sourceActor = source; // nothing visible in it: activate instead
        }
        const [x, y] = event?.get_coords() ?? [0, 0];
        if (typeof ind._indicator?.open === 'function')
            ind._indicator.open(x, y, event?.get_time() ?? global.get_current_time()).catch(logError);
        else if (typeof ind._icon?.click === 'function' && event)
            ind._icon.click(event); // ponytail: legacy XEmbed icon (X11 only), untested
    }

    destroy() {
        this._run(this._sigs);
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        this._unanchor?.();
        this._sync(); // drop containers of indicators that left meanwhile
        for (const [c, visible] of this._hidden)
            c.visible = visible;
        this._hidden.clear();
        super.destroy();
    }
}

// ---- Control Center: our own tile panel (reference screenshot 39) in place of GNOME's quick settings ----

// QuickSettings indicator properties shown by our own status menus instead
const DUPLICATE_INDICATORS = ['_network', '_bluetooth', '_volumeOutput', '_system', '_brightness',
    '_backlight', '_darkMode', '_nightLight', '_powerProfiles', '_rfkill'];

class ControlCenter extends StatusItem {
    constructor(ext, parts) {
        super('mydock-control-center', 'Control Center', 'emblem-system-symbolic');
        this._ext = ext;
        this._parts = parts; // the sibling items, whose backends the tiles reuse
        this._notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.btn.add_style_class_name('mydock-control-center-button');
        this.btn.menu.actor.add_style_class_name('mydock-control-center');
        this.icon.add_style_class_name('mydock-control-center-icon');
        // optional theme icon, else the stock settings symbol
        const file = Gio.File.new_for_path(`${ext.path}/icons/mydock-control-center-symbolic.svg`);
        this.icon.gicon = file.query_exists(null)
            ? new Gio.FileIcon({file})
            : new Gio.ThemedIcon({names: ['org.gnome.Settings-symbolic', 'emblem-system-symbolic']});

        // GNOME's quick settings button goes away. Its indicator box moves onto our button, minus the
        // ones our own menus replace, so the privacy indicators (camera, mic in use, location, screen
        // sharing) stay. Detached, not hidden: they re-sync their own visibility.
        const qs = Main.panel.statusArea.quickSettings;
        this._qs = qs ?? null;
        this._detached = [];
        const box = qs?._indicators;
        if (box) {
            for (const name of DUPLICATE_INDICATORS) {
                const actor = qs[name];
                if (!actor || actor.get_parent() !== box)
                    continue;
                this._detached.push([actor, box.get_children().indexOf(actor)]);
                box.remove_child(actor);
            }
            this._qsIndex = qs.get_children().indexOf(box);
            qs.remove_child(box);
            this._box.insert_child_at_index(box, 0);
        }
        if (qs) {
            this._qsVisible = qs.container.visible;
            qs.container.hide();
        }
        // Super+S opens ours (the prototype's version is back once this own property is deleted)
        Main.panel.toggleQuickSettings = () => Main.panel._toggleMenu(this.btn);
    }

    _find(T) {
        return this._parts.find(p => p instanceof T) ?? null;
    }

    // close, then show the item's own menu (its panel when the item is hidden)
    _openItem(part, panel) {
        this.btn.menu.close();
        if (part?.btn.container.visible)
            part.btn.menu.toggle();
        else
            openPanel(panel);
    }

    _fill(menu) {
        const wifi = this._find(WifiItem);
        const bt = this._find(BluetoothItem);
        const drops = this._openDrops;
        const syncs = []; // tile updaters, rerun on any state change while open
        const sync = () => syncs.forEach(f => f());
        const box = (style_class, vertical = false) => new St.BoxLayout({style_class, vertical, x_expand: true});
        const row = () => {
            const b = box('mydock-cc-row');
            b.layout_manager.homogeneous = true;
            return b;
        };

        const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false, style_class: 'mydock-cc-item'});
        const grid = box('mydock-cc', true);
        item.add_child(grid);
        menu.addMenuItem(item);
        const top = row();
        grid.add_child(top);

        // left tile: radios. The chip toggles, the name opens that item's own menu.
        const radios = box('mydock-cc-tile mydock-cc-radios', true);
        top.add_child(radios);
        const radio = (name, icon, part, isOn, toggle, subtitle = () => '') => {
            const line = box('mydock-cc-radio');
            const c = chip(themed(icon), false, true);
            c.connect('clicked', () => toggle());
            const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const title = new St.Label({text: name, style_class: 'mydock-cc-title'});
            const sub = new St.Label({style_class: 'mydock-cc-subtitle'});
            text.add_child(title);
            text.add_child(sub);
            const label = new St.Button({child: text, x_expand: true, can_focus: true, style_class: 'mydock-cc-label'});
            label.connect('clicked', () => this._openItem(part, name === 'Bluetooth' ? 'bluetooth' : 'wifi'));
            line.add_child(c);
            line.add_child(label);
            radios.add_child(line);
            syncs.push(() => {
                c.checked = isOn();
                c.reactive = !part || part.btn.container.visible; // no hardware: nothing to toggle
                sub.text = subtitle();
                sub.visible = !!sub.text;
            });
        };

        const nm = wifi?._client;
        radio('Wi-Fi', 'network-wireless-signal-excellent-symbolic', wifi, () => !!nm?.wireless_enabled,
            () => nm && (nm.wireless_enabled = !nm.wireless_enabled), () => {
                const ssid = nm?.wireless_enabled && wifi._device?.active_access_point?.get_ssid();
                return ssid ? wifi._NM.utils_ssid_to_utf8(ssid.get_data()) : '';
            });
        if (nm) {
            this._connect(nm, 'notify::wireless-enabled', sync, drops);
            if (wifi._device)
                this._connect(wifi._device, 'notify::active-access-point', sync, drops);
        }

        const bc = bt?._client;
        radio('Bluetooth', 'bluetooth-active-symbolic', bt, () => !!bc?.default_adapter_powered,
            () => bc && bt._setPowered(!bc.default_adapter_powered), () => {
                if (!bc?.default_adapter_powered)
                    return '';
                // ponytail: names are read on open and on power changes, not per device connect
                const store = bc.get_devices();
                const names = [];
                for (let i = 0; i < store.get_n_items(); i++) {
                    const d = store.get_item(i);
                    if (d.connected)
                        names.push(d.alias || d.name);
                }
                return names.join(', ');
            });
        if (bc)
            this._connect(bc, 'notify::default-adapter-powered', sync, drops);

        // ponytail: the shell has no simple hotspot API (NM needs a shared AP connection), so
        // Hotspot opens the Wi-Fi panel where it is switched on
        radio('Hotspot', 'network-wireless-hotspot-symbolic', null, () => false,
            () => this._openItem(null, 'wifi'));

        // right column: Focus, then Stage Manager and Screen Mirroring squares
        const right = box('mydock-cc-column', true);
        top.add_child(right);
        const focusChip = chip(themed('weather-clear-night-symbolic'));
        const focusBox = new St.BoxLayout({style_class: 'mydock-cc-radio', x_expand: true});
        focusBox.add_child(focusChip);
        focusBox.add_child(new St.Label({text: 'Focus', style_class: 'mydock-cc-title', y_align: Clutter.ActorAlign.CENTER}));
        const focus = new St.Button({child: focusBox, can_focus: true, x_expand: true, y_expand: true,
            style_class: 'mydock-cc-tile mydock-cc-focus'});
        // Focus on = notification banners off
        focus.connect('clicked', () => this._notif.set_boolean('show-banners', !this._notif.get_boolean('show-banners')));
        syncs.push(() => {
            const on = !this._notif.get_boolean('show-banners');
            focus.checked = on;
            on ? focusChip.add_style_pseudo_class('checked') : focusChip.remove_style_pseudo_class('checked');
        });
        this._connect(this._notif, 'changed::show-banners', sync, drops);
        right.add_child(focus);

        const squares = row();
        right.add_child(squares);
        // our own drawings of the reference's icons (no stock symbolic looks like them)
        const svg = icon => new Gio.FileIcon({file: Gio.File.new_for_path(`${this._ext.path}/icons/mydock-${icon}-symbolic.svg`)});
        const square = (text, icon, fn) => {
            const b = new St.Button({can_focus: true, x_expand: true, style_class: 'mydock-cc-tile mydock-cc-square'});
            const v = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            b._icon = new St.Icon({gicon: svg(icon), style_class: 'mydock-cc-square-icon', x_align: Clutter.ActorAlign.CENTER});
            v.add_child(b._icon);
            v.add_child(new St.Label({text, style_class: 'mydock-cc-square-label', x_align: Clutter.ActorAlign.CENTER}));
            b.child = v;
            b.connect('clicked', fn);
            squares.add_child(b);
            return b;
        };
        const settings = this._ext.settings;
        const stage = square('Stage\nManager', 'stage-manager',
            () => settings.set_boolean('stage-manager', !settings.get_boolean('stage-manager')));
        // filled while Stage Manager is on, outlined while off
        syncs.push(() => {
            stage.checked = settings.get_boolean('stage-manager');
            stage._icon.gicon = svg(stage.checked ? 'stage-manager-filled' : 'stage-manager');
        });
        this._connect(settings, 'changed::stage-manager', sync, drops);
        square('Screen\nMirroring', 'screen-mirroring', () => {
            this.btn.menu.close();
            const app = Shell.AppSystem.get_default().lookup_app('org.gnome.NetworkDisplays.desktop');
            if (app)
                app.activate();
            else
                openPanel('display');
        });

        // slider tiles: heading, slider, optional trailing button
        const sliderTile = (name, s, trailing = null) => {
            const tile = box('mydock-cc-tile mydock-cc-slider', true);
            tile.add_child(new St.Label({text: name, style_class: 'mydock-cc-title'}));
            const line = box('mydock-cc-slider-line');
            line.add_child(s.actor);
            if (trailing)
                line.add_child(trailing);
            tile.add_child(line);
            grid.add_child(tile);
        };
        const brightness = this._find(DisplayItem)?.brightnessSlider(drops);
        if (brightness)
            sliderTile('Display', brightness);

        const sound = this._find(SoundItem);
        if (sound?._stream) {
            const source = sound._control.get_default_source();
            let mic = null;
            if (source) {
                mic = chip(themed('audio-input-microphone-symbolic'), false, true);
                mic.add_style_class_name('mydock-cc-mic');
                mic.accessible_name = 'Microphone';
                mic.connect('clicked', () => source.change_is_muted(!source.is_muted));
                const syncMic = () => (mic.child.gicon = themed(source.is_muted
                    ? 'microphone-sensitivity-muted-symbolic' : 'audio-input-microphone-symbolic'));
                this._connect(source, 'notify::is-muted', syncMic, drops);
                syncMic();
            }
            sliderTile('Sound', sound.volumeSlider(drops), mic);
        }

        const media = nowPlaying(drops, true);
        const mediaTile = box('mydock-cc-tile mydock-cc-media');
        mediaTile.add_child(media);
        media.bind_property('visible', mediaTile, 'visible', GObject.BindingFlags.SYNC_CREATE);
        grid.add_child(mediaTile);

        sync();
    }

    destroy() {
        delete Main.panel.toggleQuickSettings;
        const qs = this._qs;
        const box = qs?._indicators;
        if (box?.get_parent() === this._box) {
            this._box.remove_child(box);
            qs.insert_child_at_index(box, Math.max(this._qsIndex, 0));
        }
        // undo in reverse: each index was taken after the earlier removals
        for (const [actor, index] of this._detached.reverse())
            box.insert_child_at_index(actor, Math.min(index, box.get_n_children()));
        this._detached = [];
        if (qs)
            qs.container.visible = this._qsVisible;
        this._qs = null;
        super.destroy();
        this._notif = null;
        this._parts = null;
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
                    this._parts.push(new Part(this._ext, this._parts));
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
