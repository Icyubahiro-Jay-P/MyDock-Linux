// Pure text parsers for aboutpc.js. No gi imports, so node can test them (aboutpc.test.mjs).

// /proc/stat first line: user nice system idle iowait irq softirq steal ...
export function parseCpuStat(text) {
    const f = text?.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    if (!f?.length || f.some(Number.isNaN))
        return null;
    return {total: f.reduce((a, b) => a + b, 0), idle: f[3] + (f[4] ?? 0)};
}

// busy percent (0..100) between two parseCpuStat samples
export function cpuUsage(prev, cur) {
    const dt = cur.total - prev.total;
    if (dt <= 0)
        return 0;
    return Math.min(100, Math.max(0, 100 * (1 - (cur.idle - prev.idle) / dt)));
}

// [[label text|null, temp*_input text|null], ...] -> [['Core 0', '46°'], ...], package last; unreadable inputs are skipped
export function parseSensors(entries) {
    const rows = [];
    entries.forEach(([label, input], i) => {
        const milli = parseInt(input);
        if (Number.isNaN(milli))
            return;
        rows.push([label?.trim() || `Sensor ${i + 1}`, `${Math.round(milli / 1000)}°`]);
    });
    return rows.sort((x, y) => /^Package/.test(x[0]) - /^Package/.test(y[0]));
}

export function parseCpuModel(cpuinfo) {
    return cpuinfo?.match(/^model name\s*:\s*(.+)$/m)?.[1].replace(/\s+/g, ' ').trim() ?? null;
}

export function parseMemTotal(meminfo) {
    const kb = Number(meminfo?.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    return kb ? `${(kb / 1024 / 1024).toFixed(1)} GB` : null;
}

export function parseOsRelease(text) {
    const v = text?.match(/^PRETTY_NAME=(.*)$/m)?.[1].trim();
    return v ? v.replace(/^(["'])(.*)\1$/, '$2') : null;
}

// skip the vendor when product_name already starts with it ("HP" + "HP EliteBook 840 G3")
export function formatModel(vendor, product) {
    vendor = vendor?.trim() ?? '';
    product = product?.trim() ?? '';
    if (!product)
        return vendor;
    return !vendor || product.toLowerCase().startsWith(vendor.toLowerCase()) ? product : `${vendor} ${product}`;
}

// `lspci -mm`: slot "class" "vendor" "device" ... -> "Intel HD Graphics 520" per VGA/3D/Display line
export function parseLspciGpu(text) {
    const gpus = [];
    for (const line of text?.split('\n') ?? []) {
        const [cls, vendor, device] = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
        if (!device || !/VGA|3D|Display/i.test(cls))
            continue;
        const v = vendor.match(/\[([^\]]+)\]/)?.[1] ?? vendor.replace(/,?\s+(Corporation|Corp\.|Inc\.|Co\.|Ltd\.).*$/i, '');
        const d = device.match(/\[([^\]]+)\]/)?.[1] ?? device;
        gpus.push(`${v} ${d}`);
    }
    return gpus.join('\n') || null;
}

// one parseCpuStat sample per "cpuN" line of /proc/stat (per core)
export function parseCoreStats(text) {
    return (text?.split('\n') ?? []).filter(l => /^cpu\d+\s/.test(l)).map(parseCpuStat).filter(Boolean);
}

// /proc/meminfo -> bytes {total, avail, swapTotal, swapFree}; null without MemTotal
export function parseMemInfo(text) {
    const kb = key => 1024 * Number(text?.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    const total = kb('MemTotal');
    return total ? {total, avail: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree')} : null;
}

// /proc/net/dev -> summed rx/tx bytes of every interface but loopback
export function parseNetDev(text) {
    const lines = text?.split('\n').slice(2) ?? [];
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

// 1024-based, no space before the unit like the reference bar: "0.0KB/s", "12MB/s"
export function formatRate(bytesPerSec) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let v = Math.max(0, bytesPerSec), u = 0;
    while (v >= 1000 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}

export function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Math.max(0, bytes), u = 0;
    while (v >= 1000 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    return `${u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
