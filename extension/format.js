// Pure helpers for statusmenus.js. No gi imports, so node can test them (format.test.mjs).

// Wi-Fi strength (0..100) -> the network-wireless-signal-<level>-symbolic icon level
export function signalLevel(strength) {
    if (strength < 20)
        return 'none';
    if (strength < 40)
        return 'weak';
    if (strength < 50)
        return 'ok';
    return strength < 80 ? 'good' : 'excellent';
}

// microseconds -> "mm:ss"
export function formatTime(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
