// Pure helper for the Finder bar's Ctrl + drag order (finderbar.js). No gi imports, so node can
// test it (panel-order.test.mjs). Entries are "box:role"; a role may itself contain ':'.

export function entryRole(entry) {
    return entry.slice(entry.indexOf(':') + 1);
}

// `primary` plus every entry of `secondary` whose role it lacks, each placed right after the
// nearest entry before it in `secondary` that is already in the result (else first).
// Applying: primary = saved order, secondary = bar now, so items the saved order has never seen
// keep their spot next to their current neighbours instead of piling up at the end of a box.
// Saving: primary = bar now, secondary = saved order, so items that are away (stat switched off,
// status menus not built yet) keep their slot for when they come back.
export function mergeOrder(primary, secondary) {
    const out = [...primary];
    const placed = new Set(primary.map(entryRole));
    let prev = -1; // index in `out` of the last secondary entry seen
    for (const entry of secondary) {
        const role = entryRole(entry);
        if (placed.has(role)) {
            prev = out.findIndex(e => entryRole(e) === role);
            continue;
        }
        out.splice(++prev, 0, entry);
        placed.add(role);
    }
    return out;
}
