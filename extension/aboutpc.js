// About This PC dialog and the CPU temperature popup card (finderbar.js calls both).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {
    parseCpuStat, cpuUsage, parseSensors, parseCpuModel, parseMemTotal,
    parseOsRelease, formatModel, parseLspciGpu,
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

    const close = new St.Button({style_class: 'mydock-about-close', x_align: Clutter.ActorAlign.START});
    close.connect('clicked', () => dialog.close());
    box.add_child(close);

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

function drawChart(area, history) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    cr.setSourceRGBA(1, 1, 1, 0.25);
    cr.setLineWidth(1);
    cr.setDash([3, 3], 0);
    for (const y of [0.5, Math.round(h * 0.3) + 0.5]) {
        cr.moveTo(0, y);
        cr.lineTo(w, y);
    }
    cr.stroke();
    cr.setDash([], 0);

    const slot = w / HISTORY;
    const bar = Math.max(1, slot - 2);
    const top = h * 0.3;
    cr.setSourceRGBA(0.12, 0.38, 0.95, 1);
    history.forEach((v, i) => {
        const bh = Math.max(1, (h - top) * v / 100);
        cr.rectangle(w - (history.length - i) * slot + (slot - bar) / 2, h - bh, bar, bh);
    });
    cr.fill();
    cr.$dispose();
}

export function attachTempPopup(menu, tempFile) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'mydock-temp-item'});
    const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mydock-temp-card'});
    card.add_child(new St.Label({text: 'CPU', style_class: 'mydock-temp-title', x_align: Clutter.ActorAlign.CENTER}));
    const history = [];
    const chart = new St.DrawingArea({style_class: 'mydock-temp-chart', x_expand: true});
    chart.connect('repaint', () => drawChart(chart, history));
    card.add_child(chart);
    const rows = new St.BoxLayout({vertical: true, style_class: 'mydock-temp-rows'});
    card.add_child(rows);
    item.add_child(card);
    menu.addMenuItem(item);

    // seeded now so the first open already has a delta to draw a bar from
    let prev = parseCpuStat(readText('/proc/stat')), timerId = 0, alive = true;
    const sample = () => {
        const cur = parseCpuStat(readText('/proc/stat'));
        if (cur && prev) {
            history.push(cpuUsage(prev, cur));
            if (history.length > HISTORY)
                history.shift();
        }
        prev = cur ?? prev;
        chart.queue_repaint();
        rows.destroy_all_children();
        for (const [name, value] of readSensors(tempFile)) {
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
