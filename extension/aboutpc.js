// About This PC dialog and the Finder bar stat popup cards (finderbar.js calls both).
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {
    parseCpuStat, cpuUsage, parseSensors, parseCpuModel, parseMemTotal,
    parseOsRelease, formatModel, parseLspciGpu, parseCoreStats, parseMemInfo, parseNetDev,
    formatRate, formatBytes,
} from './sysinfo.js';

const HISTORY = 30;
const DMI = '/sys/class/dmi/id';
// SMBIOS chassis types that are portable (laptop, notebook, sub notebook, convertible, detachable ...)
const LAPTOP_CHASSIS = [8, 9, 10, 14, 30, 31, 32];

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

function infoRow(box, key, value) {
    const row = new St.BoxLayout({style_class: 'mydock-about-row', x_align: Clutter.ActorAlign.CENTER});
    row.add_child(new St.Label({text: key, style_class: 'mydock-about-key'}));
    const label = new St.Label({text: value ?? 'Unknown', style_class: 'mydock-about-value'});
    label.clutter_text.line_wrap = true;
    row.add_child(label);
    box.add_child(row);
    return label;
}

let _about = null;

export function showAboutPC(_ext) {
    if (_about)
        return;
    const dialog = new ModalDialog.ModalDialog({styleClass: 'mydock-about', destroyOnClose: true});
    _about = dialog;
    dialog.connect('destroy', () => {
        if (_about === dialog)
            _about = null;
    });
    dialog.buttonLayout.hide();
    const box = dialog.contentLayout;

    // traffic lights: red closes, the other two are decoration like on a macOS About window
    const lights = new St.BoxLayout({style_class: 'mydock-about-lights', x_align: Clutter.ActorAlign.START});
    const close = new St.Button({style_class: 'mydock-about-close'});
    close.connect('clicked', () => dialog.close());
    lights.add_child(close);
    lights.add_child(new St.Widget({style_class: 'mydock-about-light'}));
    lights.add_child(new St.Widget({style_class: 'mydock-about-light'}));
    box.add_child(lights);

    const laptop = LAPTOP_CHASSIS.includes(parseInt(readText(`${DMI}/chassis_type`)));
    box.add_child(new St.Icon({
        gicon: Gio.ThemedIcon.new_from_names(laptop ? ['computer-laptop', 'computer'] : ['computer']),
        icon_size: 112,
        style_class: 'mydock-about-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(new St.Label({
        text: GLib.get_host_name(), style_class: 'mydock-about-host', x_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(new St.Label({
        text: formatModel(readText(`${DMI}/sys_vendor`), readText(`${DMI}/product_name`)),
        style_class: 'mydock-about-model', x_align: Clutter.ActorAlign.CENTER,
    }));

    infoRow(box, 'Processor', parseCpuModel(readText('/proc/cpuinfo')));
    const gpu = infoRow(box, 'Graphics', '...');
    infoRow(box, 'Memory', parseMemTotal(readText('/proc/meminfo')));
    const os = parseOsRelease(readText('/etc/os-release')) ?? 'Linux';
    const kernel = readText('/proc/sys/kernel/osrelease')?.trim();
    infoRow(box, 'OS', kernel ? `${os}\n${kernel}` : os);

    const more = new St.Button({
        label: 'More info', style_class: 'mydock-about-more', x_align: Clutter.ActorAlign.CENTER, can_focus: true,
    });
    more.connect('clicked', () => {
        Util.spawn(['gnome-control-center', 'system']);
        dialog.close();
    });
    box.add_child(more);

    dialog.connect('key-press-event', (_a, event) => {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        dialog.close();
        return Clutter.EVENT_STOP;
    });

    try {
        const proc = Gio.Subprocess.new(['lspci', '-mm'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out = null;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch {}
            if (_about === dialog)
                gpu.text = parseLspciGpu(out) ?? 'Unknown';
        });
    } catch {
        gpu.text = 'Unknown';
    }

    dialog.setInitialKeyFocus(more);
    if (!dialog.open())
        dialog.destroy(); // no modal grab: drop it, or _about would block every later open
}

export function closeAboutPC() {
    _about?.close();
}

// one sensor row per temp*_input in tempFile's hwmon dir, or a single "CPU" row for a thermal zone
function readSensors(tempFile) {
    if (!tempFile)
        return [];
    if (tempFile.includes('/hwmon')) {
        const dir = GLib.path_get_dirname(tempFile);
        const entries = [];
        for (let i = 1; i <= 64; i++) {
            const input = readText(`${dir}/temp${i}_input`);
            if (input !== null)
                entries.push([readText(`${dir}/temp${i}_label`), input]);
        }
        const rows = parseSensors(entries);
        if (rows.length)
            return rows;
    }
    return parseSensors([['CPU', readText(tempFile)]]);
}

// Like the reference: two faint dashed grid lines (top and a quarter down), then blue bars with
// rounded tops, a touch darker toward the bottom. Bars are history / max.
function drawChart(area, history, max) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    cr.setSourceRGBA(1, 1, 1, 0.15);
    cr.setLineWidth(1);
    cr.setDash([5, 2], 0);
    for (const y of [0.5, Math.round(h * 0.25) + 0.5]) {
        cr.moveTo(0, y);
        cr.lineTo(w, y);
    }
    cr.stroke();
    cr.setDash([], 0);

    const slot = w / HISTORY;
    const bar = Math.max(1, slot - 2);
    const top = h * 0.3;
    history.forEach((v, i) => {
        const bh = Math.max(1, (h - top) * Math.min(1, v / max));
        const x = w - (history.length - i) * slot + (slot - bar) / 2;
        const y = h - bh;
        const r = Math.min(2, bh / 2, bar / 2);
        cr.moveTo(x, h);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.arc(x + bar - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
        cr.lineTo(x + bar, h);
        cr.closePath();
    });
    const fill = new Cairo.LinearGradient(0, 0, 0, h);
    fill.addColorStopRGBA(0, 27 / 255, 102 / 255, 240 / 255, 1);
    fill.addColorStopRGBA(1, 23 / 255, 88 / 255, 205 / 255, 1);
    cr.setSource(fill);
    cr.fill();
    cr.$dispose();
}

// ---- samplers: () -> {value: bar height or null, rows: [[name, text], ...]} ----

const MAX_CORE_ROWS = 8; // more cores than this: total only, the card would outgrow the screen

// seeded now so the first open already has a delta to draw a bar from
function cpuSampler() {
    let text = readText('/proc/stat');
    let prev = parseCpuStat(text), prevCores = parseCoreStats(text);
    return () => {
        text = readText('/proc/stat');
        const cur = parseCpuStat(text), cores = parseCoreStats(text);
        const value = cur && prev ? cpuUsage(prev, cur) : null;
        const pct = v => `${Math.round(v)}%`;
        const rows = [['Usage', value === null ? '...' : pct(value)]];
        const load = readText('/proc/loadavg')?.split(' ').slice(0, 3).join('  ');
        if (load)
            rows.push(['Load average', load]);
        if (cores.length <= MAX_CORE_ROWS && cores.length === prevCores.length)
            cores.forEach((c, i) => rows.push([`Core ${i + 1}`, pct(cpuUsage(prevCores[i], c))]));
        prev = cur ?? prev;
        prevCores = cores;
        return {value, rows};
    };
}

function tempSampler(tempFile) {
    const cpu = cpuSampler();
    return () => ({value: cpu().value, rows: readSensors(tempFile)});
}

function memSampler() {
    return () => {
        const m = parseMemInfo(readText('/proc/meminfo'));
        if (!m)
            return null;
        const used = m.total - m.avail;
        const value = 100 * used / m.total;
        return {value, rows: [
            ['Used', `${formatBytes(used)} (${Math.round(value)}%)`],
            ['Total', formatBytes(m.total)],
            ['Swap', m.swapTotal ? `${formatBytes(m.swapTotal - m.swapFree)} / ${formatBytes(m.swapTotal)}` : 'None'],
        ]};
    };
}

// statfs is async so a slow disk never stalls the compositor: each call returns the last result
function diskSampler() {
    let last = null;
    return () => {
        Gio.File.new_for_path('/').query_filesystem_info_async('filesystem::size,filesystem::free',
            GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    const info = f.query_filesystem_info_finish(res);
                    const size = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    last = size ? {value: 100 * (size - free) / size, rows: [
                        ['Used', `${formatBytes(size - free)} (${Math.round(100 * (size - free) / size)}%)`],
                        ['Free', formatBytes(free)],
                        ['Total', formatBytes(size)],
                    ]} : null;
                } catch {}
            });
        return last;
    };
}

// bar = down + up bytes/s, scaled to the busiest second in the chart
function netSampler() {
    let prev = null;
    return () => {
        const net = parseNetDev(readText('/proc/net/dev'));
        const now = GLib.get_monotonic_time();
        let down = null, up = null;
        if (net && prev) {
            const dt = (now - prev.time) / 1e6;
            down = Math.max(0, (net.rx - prev.rx) / dt);
            up = Math.max(0, (net.tx - prev.tx) / dt);
        }
        prev = net ? {...net, time: now} : null;
        return {value: down === null ? null : down + up, rows: [
            ['Download', down === null ? '...' : formatRate(down)],
            ['Upload', up === null ? '...' : formatRate(up)],
        ]};
    };
}

// stat key -> [card title, sampler factory, bars relative to the chart's max instead of 0..100 %]
const POPUPS = {
    temp: ['CPU', tempSampler, false],
    cpu: ['CPU Usage', cpuSampler, false],
    mem: ['Memory', memSampler, false],
    disk: ['Disk', diskSampler, false],
    net: ['Network', netSampler, true],
};

// The Finder bar stat popup card (reference screenshot 44): centered title, live bar chart and
// detail rows, sampled once a second while the menu is open. Returns a handle with destroy().
export function attachStatPopup(menu, key, tempFile) {
    const [title, makeSampler, relative] = POPUPS[key];
    const sampler = makeSampler(tempFile);
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'mydock-temp-item'});
    const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mydock-temp-card'});
    card.add_child(new St.Label({text: title, style_class: 'mydock-temp-title', x_align: Clutter.ActorAlign.CENTER}));
    const history = [];
    const chart = new St.DrawingArea({style_class: 'mydock-temp-chart', x_expand: true});
    chart.connect('repaint', () => drawChart(chart, history, relative ? Math.max(1, ...history) : 100));
    card.add_child(chart);
    const rows = new St.BoxLayout({vertical: true, style_class: 'mydock-temp-rows'});
    card.add_child(rows);
    item.add_child(card);
    menu.addMenuItem(item);

    let timerId = 0, alive = true;
    const sample = () => {
        const s = sampler();
        if (typeof s?.value === 'number') {
            history.push(s.value);
            if (history.length > HISTORY)
                history.shift();
        }
        chart.queue_repaint();
        if (!s)
            return;
        rows.destroy_all_children();
        for (const [name, value] of s.rows) {
            const row = new St.BoxLayout({style_class: 'mydock-temp-row'});
            row.add_child(new St.Label({text: name, x_expand: true}));
            row.add_child(new St.Label({text: value}));
            rows.add_child(row);
        }
    };
    const stop = () => {
        if (timerId)
            GLib.source_remove(timerId);
        timerId = 0;
    };
    const openId = menu.connect('open-state-changed', (_m, open) => {
        stop();
        if (!open || !alive)
            return;
        sample();
        timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            sample();
            return GLib.SOURCE_CONTINUE;
        });
    });
    // the menu may destroy the item before our handle is destroyed
    item.connect('destroy', () => {
        alive = false;
        stop();
    });

    return {
        destroy() {
            stop();
            try {
                menu.disconnect(openId);
            } catch {} // menu already destroyed
            if (alive)
                item.destroy();
        },
    };
}
