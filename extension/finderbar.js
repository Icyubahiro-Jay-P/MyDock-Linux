// MyDock - Finder bar. Restyles and rearranges the existing Main.panel into a macOS-like menu bar:
// logo menu + focused app name + File / View / Window menus on the left, quick settings then clock on
// the right, optional blur.
// Ctrl + drag moves any other panel item anywhere in the bar; the order is saved in finderbar-order.
// destroy() puts every moved/hidden panel piece back where it was.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {showAboutPC, closeAboutPC, attachStatPopup} from './aboutpc.js';
import {mergeOrder} from './panel-order.js';
import {parseCpuStat, cpuUsage, parseMemInfo, parseNetDev, formatRate} from './sysinfo.js';

const STORE_APPS = ['snap-store_snap-store.desktop', 'io.snapcraft.Store.desktop', 'org.gnome.Software.desktop'];
const TASK_APPS = ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop', 'gnome-system-monitor-kde.desktop'];
const FALLBACK_APP = 'org.gnome.Nautilus.desktop';
const RECENT_MAX = 10;
// strftime conversions that show seconds (%S %s %T %r %X %c %f, with optional flags/E/O); %% is a literal
const SECONDS_RE = /%[-_0^#]*[EO]?[sSTrXcf]/;

// Mutter 49 replaced get_maximized() / maximize(flags) / unmaximize(flags) with
// get_maximize_flags() and flagless maximize() / unmaximize(); support both.
const maximizeFlags = win => win.get_maximize_flags?.() ?? win.get_maximized();
const maximize = win => win.is_maximized ? win.maximize() : win.maximize(Meta.MaximizeFlags.BOTH);
const unmaximize = win => win.is_maximized ? win.unmaximize() : win.unmaximize(Meta.MaximizeFlags.BOTH);

const STATS_SECONDS = 2;
// [stat key (settings key is stats-<key>), icon file in icons/mydock-<icon>-symbolic.svg, name]
const STATS = [
    ['cpu', 'cpu', 'CPU Usage'], ['temp', 'temp', 'CPU Temperature'], ['mem', 'memory', 'Memory Usage'],
    ['disk', 'disk', 'Disk Usage'], ['net', 'network', 'Network Speed'],
];

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

// newest RECENT_MAX local files in the GTK recent list that still exist, as [uri, name]
function recentFiles() {
    const bf = new GLib.BookmarkFile();
    try {
        bf.load_from_file(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
    } catch {
        return [];
    }
    const out = [];
    const uris = bf.get_uris().filter(u => u.startsWith('file://'))
        .map(u => [u, bf.get_modified_date_time(u)?.to_unix() ?? 0]).sort((a, b) => b[1] - a[1]);
    for (const [uri] of uris) {
        const file = Gio.File.new_for_uri(uri);
        if (file.query_exists(null))
            out.push([uri, file.get_basename()]);
        if (out.length === RECENT_MAX)
            break;
    }
    return out;
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

        // GNOME's own clock / quick settings popups get the finder menu look too
        this._gnomeMenus = ['dateMenu', 'quickSettings'].map(r => panel.statusArea[r]?.menu?.actor).filter(a => a);
        for (const actor of this._gnomeMenus)
            actor.add_style_class_name('mydock-menu');

        this._menuBtns = [];
        this._buildLogo();
        this._buildAppName();
        this._buildAppMenus();
        this._buildClock();
        this._statBtn = {}; // stat key -> its PanelMenu.Button
        this._stat = {}; // stat key -> its value label
        this._popup = {}; // stat key -> its popup card (aboutpc.js)
        this._syncStats();
        this._layout();
        this._syncBlur();

        this._connect(this._settings, 'changed::finderbar-blur', () => this._syncBlur());
        this._connect(this._settings, 'changed::logo-path', () => this._syncLogo());
        this._connect(this._settings, 'changed::time-format', () => this._tick(true));
        this._connect(this._settings, 'changed::finderbar-stats', () => this._syncStats());
        for (const [key] of STATS)
            this._connect(this._settings, `changed::stats-${key}`, () => this._syncStat(key));
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
        // centered in the square button (CSS: bar-height square highlight)
        this._logoIcon = new St.Icon({
            style_class: 'system-status-icon mydock-logo-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.add_child(this._logoIcon);
        this._logoButton = btn;
        this._syncLogo();

        const menu = btn.menu;
        menu.actor.add_style_class_name('mydock-menu');
        const appSys = Shell.AppSystem.get_default();
        const sep = () => menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        menu.addAction('About This PC', () => showAboutPC(this._ext));
        sep();
        menu.addAction('System Settings', () => {
            const s = appSys.lookup_app('org.gnome.Settings.desktop');
            if (s)
                s.activate();
            else
                Util.spawn(['gnome-control-center']);
        });
        menu.addAction('Preferences', () => this._ext.openPreferences());
        const store = STORE_APPS.map(id => appSys.lookup_app(id)).find(a => a);
        if (store)
            menu.addAction('App Store', () => store.activate());
        sep();
        const task = TASK_APPS.map(id => appSys.lookup_app(id)).find(a => a);
        menu.addAction('Task Manager', () => task ? task.activate() : Util.spawn(['gnome-system-monitor']));
        sep();

        // filled each time the logo menu opens (a PopupSubMenu with no items would not open)
        const recent = new PopupMenu.PopupSubMenuMenuItem('Recently opened files');
        menu.addMenuItem(recent);
        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._fillRecent(recent.menu);
        });
        sep();

        const actions = SystemActions.getDefault();
        for (const entry of [
            ['Sleep', 'can-suspend', () => actions.activateSuspend()],
            ['Restart', 'can-restart', () => actions.activateRestart()],
            ['Shut Down', 'can-power-off', () => actions.activatePowerOff()],
            null,
            ['Lock', 'can-lock-screen', () => actions.activateLockScreen()],
            ['Log out', 'can-logout', () => actions.activateLogout()],
        ]) {
            if (!entry) {
                sep();
                continue;
            }
            const [label, prop, fn] = entry;
            const item = menu.addAction(label, fn);
            this._bindings.push(actions.bind_property(prop, item, 'visible', GObject.BindingFlags.SYNC_CREATE));
        }

        Main.panel.addToStatusArea('mydock-logo', btn, 0, 'left');
    }

    _fillRecent(menu) {
        menu.removeAll();
        const files = recentFiles();
        for (const [uri, name] of files) {
            menu.addAction(name, () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
                } catch (e) {
                    logError(e, `MyDock: cannot open ${uri}`);
                }
            });
        }
        if (!files.length)
            menu.addMenuItem(new PopupMenu.PopupMenuItem('No recent files', {reactive: false}));
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
        this._appMenu.actor.add_style_class_name('mydock-menu');
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
        for (const b of this._menuBtns)
            b.container.visible = !!this._tracker.focus_app;
    }

    // ---- left: File / View / Window menus for the focused app ----
    // each menu is rebuilt when it opens; with no window every item is just insensitive, so a
    // menu is never empty (an empty PopupMenu refuses to open)

    _buildAppMenus() {
        const fills = [['File', m => this._fillFile(m)], ['View', m => this._fillView(m)],
            ['Window', m => this._fillWindow(m)]];
        fills.forEach(([label, fill], i) => {
            const btn = new PanelMenu.Button(0.0, label);
            btn.add_style_class_name('mydock-appmenu-button');
            btn.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            btn.menu.actor.add_style_class_name('mydock-menu');
            const build = () => {
                btn.menu.removeAll();
                fill(btn.menu);
            };
            build();
            btn.menu.connect('open-state-changed', (_m, open) => {
                if (open)
                    build();
            });
            Main.panel.addToStatusArea(`mydock-menu-${label.toLowerCase()}`, btn, 2 + i, 'left');
            this._menuBtns.push(btn);
        });
        this._syncApp();
    }

    // focused app and its window (the focused one, else its most recent)
    _target() {
        const app = this._tracker.focus_app;
        const focus = global.display.focus_window;
        const win = focus && this._tracker.get_window_app(focus) === app ? focus : app?.get_windows()[0];
        return [app, win ?? null];
    }

    _addItem(menu, label, ok, fn) {
        menu.addAction(label, fn).setSensitive(!!ok);
    }

    _fillFile(menu) {
        const [app, win] = this._target();
        this._addItem(menu, 'New Window', app?.can_open_new_window(), () => app.open_new_window(-1));
        this._addItem(menu, 'Close Window', win, () => win.delete(global.get_current_time()));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addItem(menu, `Quit ${app?.get_name() ?? ''}`.trim(), app, () => app.request_quit());
    }

    _fillView(menu) {
        const [, win] = this._target();
        this._addItem(menu, win?.is_fullscreen() ? 'Exit Full Screen' : 'Enter Full Screen', win,
            () => win.is_fullscreen() ? win.unmake_fullscreen() : win.make_fullscreen());
    }

    _fillWindow(menu) {
        const [app, win] = this._target();
        this._addItem(menu, 'Minimize', win?.can_minimize(), () => win.minimize());
        this._addItem(menu, 'Zoom', win?.can_maximize(), () => maximizeFlags(win) === Meta.MaximizeFlags.BOTH
            ? unmaximize(win) : maximize(win));
        // half of the work area; mutter's own tiling isn't exposed to JS
        const tile = right => {
            const area = win.get_work_area_current_monitor();
            const w = Math.floor(area.width / 2);
            if (maximizeFlags(win))
                unmaximize(win);
            win.move_resize_frame(true, right ? area.x + area.width - w : area.x, area.y, w, area.height);
        };
        this._addItem(menu, 'Tile Window to Left of Screen', win?.allows_resize(), () => tile(false));
        this._addItem(menu, 'Tile Window to Right of Screen', win?.allows_resize(), () => tile(true));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Shell.App.activate raises all of the app's windows on this workspace
        this._addItem(menu, 'Bring All to Front', app, () => app.activate());
        const wins = app?.get_windows() ?? [];
        if (wins.length)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const w of wins) {
            const item = menu.addAction(w.get_title() || app.get_name(), () => Main.activateWindow(w));
            if (w === win)
                item.setOrnament(PopupMenu.Ornament.DOT);
        }
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
    // every stat is its own panel item (role mydock-stat-<key>), so Ctrl + drag moves each one

    // finderbar-stats toggled / startup: (re)build every stat, the queued _applyOrder restores
    // the saved order. Reverse so the default placement (index 0 of the right box) reads cpu..net.
    _syncStats() {
        if (!Object.keys(this._statBtn).length) {
            // nothing built: re-probe what the system can provide
            this._tempFile = findTempFile();
            this._statOk = {cpu: true, temp: !!this._tempFile, mem: true, disk: true, net: true};
        }
        for (const [key] of [...STATS].reverse())
            this._syncStat(key, true);
        if (this._statsId)
            this._updateStats(); // once for all, not per stat: back-to-back CPU reads give a bogus 0%
    }

    // a stat exists only while it is switched on and the system can provide it
    _syncStat(key, initial = false) {
        const on = this._settings.get_boolean('finderbar-stats') &&
            this._settings.get_boolean(`stats-${key}`) && this._statOk[key];
        if (on && !this._statBtn[key])
            this._buildStat(key, initial);
        else if (!on && this._statBtn[key])
            this._destroyStat(key);
    }

    _buildStat(key, initial) {
        const [, icon, name] = STATS.find(s => s[0] === key);
        // a click opens the stat's live graph card (aboutpc.js)
        const btn = new PanelMenu.Button(0.0, name);
        btn.add_style_class_name('mydock-stat-button');
        btn.menu.actor.add_style_class_name('mydock-menu');
        this._popup[key] = attachStatPopup(btn.menu, key, this._tempFile);
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
        btn.add_child(cell);
        this._statBtn[key] = btn;
        this._stat[key] = value;

        // the queued _applyOrder puts it back in its saved slot (kept while it was switched off)
        Main.panel.addToStatusArea(`mydock-stat-${key}`, btn, 0, 'right');

        if (key === 'disk')
            this._statTick = 0; // read it on the next update
        if (!this._statsId) {
            this._statTick = 0;
            this._statsId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, STATS_SECONDS, () => {
                this._updateStats();
                return GLib.SOURCE_CONTINUE;
            });
        }
        if (!initial)
            this._updateStats();
    }

    _destroyStat(key) {
        this._popup[key]?.destroy();
        delete this._popup[key];
        this._statBtn[key].destroy(); // the panel drops statusArea[role] on destroy
        delete this._statBtn[key];
        delete this._stat[key];
        if (!Object.keys(this._statBtn).length && this._statsId) {
            GLib.source_remove(this._statsId);
            this._statsId = 0;
        }
    }

    _destroyStats() {
        for (const key of Object.keys(this._statBtn))
            this._destroyStat(key);
    }

    _updateStats() {
        // read only stats on screen (not when locked, fullscreen, panel hidden); a stat not read
        // drops its previous sample so a stale delta is never used later
        const shown = key => !!this._statBtn[key]?.mapped;
        if (shown('cpu')) {
            const cpu = parseCpuStat(readText('/proc/stat'));
            if (cpu && this._prevCpu)
                this._stat.cpu.text = `${Math.round(cpuUsage(this._prevCpu, cpu))}%`;
            this._prevCpu = cpu;
        } else {
            this._prevCpu = null;
        }

        if (shown('temp')) {
            const temp = parseInt(readText(this._tempFile));
            if (isNaN(temp)) {
                this._statOk.temp = false;
                this._syncStat('temp');
            } else {
                this._stat.temp.text = `${Math.round(temp / 1000)}°`;
            }
        }

        if (shown('mem')) {
            const mem = parseMemInfo(readText('/proc/meminfo'));
            this._stat.mem.text = mem ? `${Math.round(100 * (mem.total - mem.avail) / mem.total)}%` : '';
        }

        // disk usage changes slowly: every 15th tick (~30 s); async so a slow statfs never
        // stalls the compositor
        if (shown('disk') && this._statTick++ % 15 === 0) {
            Gio.File.new_for_path('/').query_filesystem_info_async('filesystem::size,filesystem::free',
                GLib.PRIORITY_LOW, null, (f, res) => {
                    if (!this._stat?.disk)
                        return; // disk stat turned off / destroyed meanwhile
                    try {
                        const info = f.query_filesystem_info_finish(res);
                        const size = info.get_attribute_uint64('filesystem::size');
                        const free = info.get_attribute_uint64('filesystem::free');
                        this._stat.disk.text = size ? `${Math.round(100 * (size - free) / size)}%` : '';
                    } catch {
                        this._statOk.disk = false;
                        this._syncStat('disk');
                    }
                });
        }

        if (shown('net')) {
            const net = parseNetDev(readText('/proc/net/dev'));
            const now = GLib.get_monotonic_time();
            if (net && this._prevNet) {
                const dt = (now - this._prevNet.time) / 1e6;
                const up = (net.tx - this._prevNet.tx) / dt, down = (net.rx - this._prevNet.rx) / dt;
                this._stat.net.text = `${formatRate(up)}\n${formatRate(down)}`;
            }
            this._prevNet = net ? {...net, time: now} : null;
        } else {
            this._prevNet = null;
        }
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
        return actor === this._logoButton.container || actor === this._appButton.container ||
            this._menuBtns.some(b => b.container === actor);
    }

    _remember(actor) {
        const role = this._roleOf(actor);
        const parent = actor.get_parent();
        if (role && parent && !this._origPos.has(role))
            this._origPos.set(role, [parent, parent.get_children().indexOf(actor)]);
    }

    // first index a movable item may take in `box` (logo, app name and its menus stay first on the left)
    _minIndex(box, kids) {
        const last = this._menuBtns.at(-1)?.container ?? this._appButton.container;
        return box === this._boxes.left ? kids.indexOf(last) + 1 : 0;
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

    _savedOrder() {
        // the stats used to be one item (mydock-stats): put the per-stat items in its slot
        return this._settings.get_strv('finderbar-order').flatMap(e => e.endsWith(':mydock-stats')
            ? STATS.map(([key]) => e.replace('mydock-stats', `mydock-stat-${key}`)) : [e]);
    }

    // "box:role" of every movable item in the bar, left to right
    _currentOrder() {
        const order = [];
        for (const [name, box] of Object.entries(this._boxes)) {
            for (const kid of box.get_children()) {
                const role = this._roleOf(kid);
                if (role && !this._pinned(kid))
                    order.push(`${name}:${role}`);
            }
        }
        return order;
    }

    // Every item in the bar is placed, not only the saved ones: an item the saved order has never
    // seen (status menus, stats, tray icons built after it was saved) stays next to its current
    // neighbours instead of being pushed to the end of its box.
    _applyOrder() {
        const saved = this._savedOrder();
        if (!saved.length || this._drag)
            return;
        this._applying = true;
        const next = {};
        for (const entry of mergeOrder(saved, this._currentOrder())) {
            // the role may contain ':' (app indicators), the box name never does
            const name = entry.slice(0, entry.indexOf(':'));
            const role = entry.slice(name.length + 1);
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

    // our own items that are away right now (stat switched off, status menus not built yet) keep
    // their saved slot; others' are dropped (app indicator roles change every run)
    _saveOrder() {
        const away = this._savedOrder().filter(e => e.includes(':mydock-'));
        this._settings.set_strv('finderbar-order', mergeOrder(this._currentOrder(), away));
    }

    _onPanelEvent(ev) {
        const type = ev.type();
        if (!this._drag) {
            if (type !== Clutter.EventType.BUTTON_PRESS || ev.get_button() !== Clutter.BUTTON_PRIMARY ||
                !(ev.get_state() & Clutter.ModifierType.CONTROL_MASK))
                return Clutter.EVENT_PROPAGATE;
            const boxes = Object.values(this._boxes);
            let actor = global.stage.get_event_actor(ev);
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
        closeAboutPC();
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
        for (const b of this._menuBtns)
            b.destroy();
        this._menuBtns = [];
        this._appButton.destroy(); // also destroys its menu
        this._logoButton.destroy();

        if (this._blur) {
            Main.panel.remove_effect(this._blur);
            this._blur = null;
        }
        Main.panel.remove_style_class_name('mydock-finderbar-blur');
        Main.panel.remove_style_class_name('mydock-finderbar');
        for (const actor of this._gnomeMenus)
            actor.remove_style_class_name('mydock-menu');
        this._gnomeMenus = [];
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
