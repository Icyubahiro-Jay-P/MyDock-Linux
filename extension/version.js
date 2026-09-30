// Pure helper (no gi imports) so it can be tested under node: see version.test.mjs.

// Numeric semver compare: <0 if a < b, 0 if equal, >0 if a > b. Leading "v" and
// any "-suffix" are ignored, missing parts count as 0 ("1.2" == "1.2.0").
export function compareVersions(a, b) {
    const parse = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
    const x = parse(a), y = parse(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d)
            return d;
    }
    return 0;
}
