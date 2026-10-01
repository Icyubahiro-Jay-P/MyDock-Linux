// MyDock - Finder bar. Restyles and rearranges the existing Main.panel into a macOS-like menu bar:
// logo menu + focused app name on the left, quick settings then clock on the right, optional blur.
// Ctrl + drag moves any other panel item anywhere in the bar; the order is saved in finderbar-order.
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

const STATS_SECONDS = 2;
// [stat key (settings key is stats-<key>), icon file in icons/mydock-<icon>-symbolic.svg]
const STATS = [['cpu', 'cpu'], ['temp', 'temp'], ['mem', 'memory'], ['disk', 'disk'], ['net', 'network']];

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

// /proc/stat first line: user nice system idle iowait irq softirq steal ...
function readCpu() {
    const f = readText('/proc/stat')?.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    if (!f?.length)
        return null;
    return {total: f.reduce((a, b) => a + b, 0), idle: f[3] + (f[4] ?? 0)};
}

// summed rx/tx bytes of every interface but loopback
function readNet() {
    const lines = readText('/proc/net/dev')?.split('\n').slice(2) ?? [];
    let rx = 0, tx = 0;
    for (const line of lines) {
        const [name, data] = line.split(':');
        if (!data || name.trim() === 'lo')
            continue;
        const f = data.trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
    }
    return lines.length ? {rx, tx} : null;
}

// CPU package temperature: coretemp / k10temp hwmon, else the x86_pkg_temp or first thermal zone
function findTempFile() {
    for (let i = 0; i < 32; i++) {
        const name = readText(`/sys/class/hwmon/hwmon${i}/name`)?.trim();
        if (name === undefined)
            continue;
        if (['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'].includes(name) && readText(`/sys/class/hwmon/hwmon${i}/temp1_input`))
            return `/sys/class/hwmon/hwmon${i}/temp1_input`;
    }
    let first = null;
    for (let i = 0; i < 32; i++) {
        const type = readText(`/sys/class/thermal/thermal_zone${i}/type`)?.trim();
        if (type === undefined)
            continue;
        if (type === 'x86_pkg_temp')
            return `/sys/class/thermal/thermal_zone${i}/temp`;
        first ??= `/sys/class/thermal/thermal_zone${i}/temp`;
    }
    return first;
}

function formatRate(bytesPerSec) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let v = Math.max(0, bytesPerSec), u = 0;
    while (v >= 1000 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}

// GNOME's Panel gives each side at most half the bar width, so a busy right side (stats, tray
// icons, clock) got squeezed and ellipsized while the left half sat mostly empty. This runs
// after the panel allocates the right box and widens it leftwards up to the left box / center.
const RIGHT_GAP = 12;
const RightBoxWidth = GObject.registerClass(
class MyDockRightBoxWidth extends Clutter.Constraint {
    vfunc_update_allocation(actor, box) {
        const panel = Main.panel;
        const W = panel.width;
        const [, natural] = actor.get_preferred_width(-1);
        const [, leftNat] = panel._leftBox.get_preferred_width(-1);
        const [, centerNat] = panel._centerBox.get_preferred_width(-1);
        const leftEnd = Math.max(Math.min(leftNat, W / 2), centerNat ? (W + centerNat) / 2 : 0);
        const x1 = Math.max(leftEnd + RIGHT_GAP, Math.min(box.x1, box.x2 - natural));
        box.init_rect(x1, box.y1, box.x2 - x1, box.y2 - box.y1);
    }
});

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
        this._origPos = new Map(); // role -> [parent, index] before we first moved it
        this._boxes = {left: panel._leftBox, center: panel._centerBox, right: panel._rightBox};

        panel.add_style_class_name('mydock-finderbar');
        this._rightWidth = new RightBoxWidth();
        panel._rightBox.add_constraint(this._rightWidth);

        this._buildLogo();
        this._buildAppName();
        this._buildClock();
        this._syncStats();
        this._layout();
        this._syncBlur();

        this._connect(this._settings, 'changed::finderbar-blur', () => this._syncBlur());
        this._connect(this._settings, 'changed::logo-path', () => this._syncLogo());
        this._connect(this._settings, 'changed::time-format', () => this._tick(true));
        this._connect(this._settings, 'changed::finderbar-stats', () => this._syncStats());
        this._connect(this._settings, 'changed::stage-manager',
            () => this._stageItem.setToggleState(this._settings.get_boolean('stage-manager')));
        // session mode changes (e.g. after unlock) rebuild the panel boxes and undo our layout
        this._connect(Main.sessionMode, 'updated', () => this._layout());

        // ---- Ctrl + drag reordering ----
        this._connect(panel, 'captured-event', (_a, ev) => this._onPanelEvent(ev));
        this._connect(this._settings, 'changed::finderbar-order', () => this._applyOrder());
        // indicators added later (other extensions, session changes) go back to their saved place
        for (const box of Object.values(this._boxes))
            this._connect(box, 'child-added', () => this._queueApplyOrder());
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

    // ---- right: live system stats (CPU, temperature, memory, disk, network) ----

    _syncStats() {
        const on = this._settings.get_boolean('finderbar-stats');
        if (on && !this._statsButton)
            this._buildStats();
        else if (!on && this._statsButton)
            this._destroyStats();
    }

    _buildStats() {
        const btn = new PanelMenu.Button(0.0, 'System Stats', true);
        btn.add_style_class_name('mydock-stats-button');
        const box = new St.BoxLayout({style_class: 'mydock-stats', y_align: Clutter.ActorAlign.CENTER});
        this._stat = {};
        this._statCell = {};
        this._statOk = {};
        for (const [key, icon] of STATS) {
            const cell = new St.BoxLayout({style_class: 'mydock-stat', y_align: Clutter.ActorAlign.CENTER});
            const file = Gio.File.new_for_path(`${this._ext.path}/icons/mydock-${icon}-symbolic.svg`);
            cell.add_child(new St.Icon({
                gicon: new Gio.FileIcon({file}),
                style_class: 'mydock-stat-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const value = new St.Label({
                style_class: key === 'net' ? 'mydock-stat-value mydock-stat-net' : 'mydock-stat-value',
                y_align: Clutter.ActorAlign.CENTER,
            });
            cell.add_child(value);
            box.add_child(cell);
            this._stat[key] = value;
            this._statCell[key] = cell;
            this._statOk[key] = true;
            this._statSigs ??= [];
            this._statSigs.push(this._settings.connect(`changed::stats-${key}`, () => this._syncStatCells()));
        }
        btn.add_child(box);
        this._statsButton = btn;
        this._tempFile = findTempFile();
        this._statOk.temp = !!this._tempFile;
        this._prevCpu = null;
        this._prevNet = null;
        this._statTick = 0;
        this._syncStatCells();
        Main.panel.addToStatusArea('mydock-stats', btn, 0, 'right');
        this._updateStats();
        this._statsId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, STATS_SECONDS, () => {
            this._updateStats();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // each stat has its own on/off key; a stat the system can't provide stays hidden
    _syncStatCells() {
        let any = false;
        for (const [key] of STATS) {
            const on = this._settings.get_boolean(`stats-${key}`) && this._statOk[key];
            this._statCell[key].visible = on;
            any ||= on;
        }
        this._statsButton.visible = any;
    }

    _destroyStats() {
        if (this._statsId) {
            GLib.source_remove(this._statsId);
            this._statsId = 0;
        }
        for (const id of this._statSigs ?? [])
            this._settings.disconnect(id);
        this._statSigs = null;
        this._statsButton?.destroy();
        this._statsButton = null;
        this._stat = this._statCell = null;
    }

    _updateStats() {
        const cpu = readCpu();
        if (cpu && this._prevCpu) {
            const total = cpu.total - this._prevCpu.total;
            const busy = total - (cpu.idle - this._prevCpu.idle);
            this._stat.cpu.text = `${total > 0 ? Math.round(100 * busy / total) : 0}%`;
        }
        this._prevCpu = cpu;

        const temp = this._tempFile ? parseInt(readText(this._tempFile)) : NaN;
        if (this._statOk.temp === isNaN(temp)) {
            this._statOk.temp = !isNaN(temp);
            this._syncStatCells();
        }
        this._stat.temp.text = `${Math.round(temp / 1000)}\u00b0`;

        const mem = readText('/proc/meminfo');
        const kb = name => parseInt(mem?.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? '0');
        const total = kb('MemTotal');
        this._stat.mem.text = total ? `${Math.round(100 * (total - kb('MemAvailable')) / total)}%` : '';

        // disk usage changes slowly: every 15th tick (~30 s)
        if (this._statTick++ % 15 === 0) {
            try {
                const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
                const size = info.get_attribute_uint64('filesystem::size');
                const free = info.get_attribute_uint64('filesystem::free');
                this._stat.disk.text = size ? `${Math.round(100 * (size - free) / size)}%` : '';
            } catch {
                this._statOk.disk = false;
                this._syncStatCells();
            }
        }

        const net = readNet();
        const now = GLib.get_monotonic_time();
        if (net && this._prevNet) {
            const dt = (now - this._prevNet.time) / 1e6;
            const up = (net.tx - this._prevNet.tx) / dt, down = (net.rx - this._prevNet.rx) / dt;
            this._stat.net.text = `${formatRate(up)}\n${formatRate(down)}`;
        }
        this._prevNet = net ? {...net, time: now} : null;
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
        this._applyOrder();
    }

    // ---- Ctrl + drag reordering ----

    _roleOf(actor) {
        const area = Main.panel.statusArea;
        return Object.keys(area).find(r => area[r]?.container === actor) ?? null;
    }

    _boxName(box) {
        return Object.keys(this._boxes).find(n => this._boxes[n] === box) ?? null;
    }

    _pinned(actor) {
        return actor === this._logoButton.container || actor === this._appButton.container;
    }

    _remember(actor) {
        const role = this._roleOf(actor);
        const parent = actor.get_parent();
        if (role && parent && !this._origPos.has(role))
            this._origPos.set(role, [parent, parent.get_children().indexOf(actor)]);
    }

    // first index a movable item may take in `box` (logo + app name stay first on the left)
    _minIndex(box, kids) {
        return box === this._boxes.left ? kids.indexOf(this._appButton.container) + 1 : 0;
    }

    _queueApplyOrder() {
        if (this._applying || this._orderId)
            return;
        this._orderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._orderId = 0;
            this._applyOrder();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyOrder() {
        const order = this._settings.get_strv('finderbar-order');
        if (!order.length || this._drag)
            return;
        this._applying = true;
        const next = {};
        for (const entry of order) {
            const [name, role] = entry.split(':');
            const box = this._boxes[name];
            const actor = Main.panel.statusArea[role]?.container;
            if (!box || !actor || this._pinned(actor))
                continue;
            next[name] ??= this._minIndex(box, box.get_children());
            const parent = actor.get_parent();
            if (parent !== box || box.get_children().indexOf(actor) !== next[name]) {
                this._remember(actor);
                parent?.remove_child(actor);
                box.insert_child_at_index(actor, Math.min(next[name], box.get_n_children()));
            }
            next[name]++;
        }
        this._applying = false;
    }

    _saveOrder() {
        const order = [];
        for (const [name, box] of Object.entries(this._boxes)) {
            for (const kid of box.get_children()) {
                const role = this._roleOf(kid);
                if (role && !this._pinned(kid))
                    order.push(`${name}:${role}`);
            }
        }
        this._settings.set_strv('finderbar-order', order);
    }

    _onPanelEvent(ev) {
        const type = ev.type();
        if (!this._drag) {
            if (type !== Clutter.EventType.BUTTON_PRESS || ev.get_button() !== Clutter.BUTTON_PRIMARY ||
                !(ev.get_state() & Clutter.ModifierType.CONTROL_MASK))
                return Clutter.EVENT_PROPAGATE;
            const boxes = Object.values(this._boxes);
            let actor = ev.get_source();
            while (actor && !boxes.includes(actor.get_parent()))
                actor = actor.get_parent();
            if (!actor || this._pinned(actor) || !this._roleOf(actor))
                return Clutter.EVENT_PROPAGATE;
            this._startDrag(actor, ev);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.MOTION) {
            this._moveDrag(ev);
        } else if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag(true);
        } else if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
            this._endDrag(false);
        }
        return Clutter.EVENT_STOP;
    }

    _startDrag(actor, ev) {
        const [px, py] = ev.get_coords();
        const [ax, ay] = actor.get_transformed_position();
        const clone = new Clutter.Clone({source: actor, opacity: 210, reactive: false});
        const marker = new St.Widget({style_class: 'mydock-finderbar-marker', visible: false});
        Main.uiGroup.add_child(clone);
        Main.uiGroup.add_child(marker);
        clone.set_position(ax, ay);
        actor.opacity = 80;
        this._drag = {actor, clone, marker, dx: px - ax, dy: py - ay, target: null};
        // keep receiving motion/release when the pointer leaves the panel
        this._grab = global.stage.grab(Main.panel);
        this._moveDrag(ev);
    }

    // box + child index under the pointer, or null when the pointer is off the panel
    _dropTarget(px, py) {
        const [, panelY] = Main.panel.get_transformed_position();
        if (py < panelY - 20 || py > panelY + Main.panel.height + 20)
            return null;
        const {actor} = this._drag;
        let best = null;
        for (const box of Object.values(this._boxes)) {
            const [bx] = box.get_transformed_position();
            const [bw] = box.get_transformed_size();
            const dist = px < bx ? bx - px : Math.max(0, px - bx - bw);
            if (!best || dist < best.dist)
                best = {box, dist};
        }
        const box = best.box;
        const kids = box.get_children().filter(k => k !== actor);
        const min = this._minIndex(box, kids);
        let index = kids.length;
        for (let i = min; i < kids.length; i++) {
            if (!kids[i].visible)
                continue;
            const [kx] = kids[i].get_transformed_position();
            const [kw] = kids[i].get_transformed_size();
            if (px < kx + kw / 2) {
                index = i;
                break;
            }
        }
        return {box, kids, index: Math.max(index, min)};
    }

    _moveDrag(ev) {
        const [px, py] = ev.get_coords();
        const d = this._drag;
        d.clone.set_position(Math.round(px - d.dx), Math.round(py - d.dy));
        d.target = this._dropTarget(px, py);
        if (!d.target) {
            d.marker.hide();
            return;
        }
        // marker at the left edge of the item we insert before, else after the last visible item
        const {box, kids, index} = d.target;
        const before = kids.slice(index).find(k => k.visible);
        const after = kids.slice(0, index).reverse().find(k => k.visible);
        let x;
        if (before) {
            [x] = before.get_transformed_position();
        } else if (after) {
            const [ax] = after.get_transformed_position();
            x = ax + after.get_transformed_size()[0];
        } else {
            [x] = box.get_transformed_position();
        }
        const [, y] = Main.panel.get_transformed_position();
        d.marker.set_position(Math.round(x - 1), Math.round(y + 4));
        d.marker.height = Math.max(1, Main.panel.height - 8);
        d.marker.show();
    }

    _endDrag(drop) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
        d.clone.destroy();
        d.marker.destroy();
        d.actor.opacity = 255;
        if (!drop || !d.target)
            return;
        const {box, kids, index} = d.target;
        this._remember(d.actor);
        this._applying = true;
        d.actor.get_parent()?.remove_child(d.actor);
        // kids excludes the dragged actor, so after removing it `index` is its slot in box
        box.insert_child_at_index(d.actor, Math.min(index, box.get_n_children()));
        this._applying = false;
        this._saveOrder();
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
        this._endDrag(false);
        for (const [obj, id] of this._sigs)
            obj.disconnect(id);
        this._sigs = [];
        if (this._orderId) {
            GLib.source_remove(this._orderId);
            this._orderId = 0;
        }
        // put reordered items back, lowest original index first so the indices still line up
        const moved = [...this._origPos].sort((a, b) => a[1][1] - b[1][1]);
        for (const [role, [parent, index]] of moved) {
            const actor = Main.panel.statusArea[role]?.container;
            if (!actor)
                continue;
            actor.get_parent()?.remove_child(actor);
            parent.insert_child_at_index(actor, Math.min(Math.max(index, 0), parent.get_n_children()));
        }
        this._origPos.clear();
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

        this._destroyStats();
        this._appButton.destroy(); // also destroys its menu
        this._logoButton.destroy();

        if (this._blur) {
            Main.panel.remove_effect(this._blur);
            this._blur = null;
        }
        Main.panel.remove_style_class_name('mydock-finderbar-blur');
        Main.panel.remove_style_class_name('mydock-finderbar');
        Main.panel._rightBox.remove_constraint(this._rightWidth);
        this._rightWidth = null;

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
