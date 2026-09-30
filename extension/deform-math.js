// MyDock - pure vertex math for the minimize effects (no gi imports, so node can test it).
// All functions work in actor-local pixels: the window is the rect (0,0,W,H), (u,v) are the
// vertex texture coords in 0..1, T = {x,y,width,height} is the target rect (dock icon)
// in the same local space. They return the deformed vertex {x,y}.

const clamp01 = t => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);

const GENIE_SPLIT = 0.4; // share of the animation spent narrowing before sliding
const SUCK_SPREAD = 1.2; // how much later the far edge starts moving than the near edge

// Genie for a target below the window. Phase 1 bends the sides into a funnel that ends at the
// target, phase 2 slides the window down the funnel into the target.
// The target is passed as scalars (tx,ty,tw,th) and the result written into `out`, so the
// per-vertex hot path allocates nothing.
function genieDown(p, u, v, W, H, tx, ty, tw, th, out) {
    const a = clamp01(p / GENIE_SPLIT);
    const b = smooth(clamp01((p - GENIE_SPLIT) / (1 - GENIE_SPLIT)));
    const y = lerp(v * H, ty + v * th, b);
    // funnel: full window width at the window top, target width at the target top
    const c = ty > 0 ? smooth(clamp01(y / ty)) : 1;
    out.x = lerp(u * W, tx + u * tw, a * c);
    out.y = y;
}

// Suck / magic lamp for a target below the window: the edge nearest the target is pulled in
// first, the far edge follows, and x collapses faster than y for a strong curve.
function suckDown(p, u, v, W, H, tx, ty, tw, th, out) {
    const t = clamp01(p * (1 + SUCK_SPREAD) - SUCK_SPREAD * (1 - v));
    out.x = lerp(u * W, tx + u * tw, 1 - (1 - t) ** 3);
    out.y = lerp(v * H, ty + v * th, t * t);
}

// Which side of the window the target lies on: 'bottom' | 'top' | 'left' | 'right'.
export function targetSide(W, H, T) {
    const cx = T.x + T.width / 2, cy = T.y + T.height / 2;
    const gaps = [['bottom', cy - H], ['top', -cy], ['right', cx - W], ['left', -cx]];
    const [side, gap] = gaps.reduce((best, g) => (g[1] > best[1] ? g : best));
    return gap > 0 ? side : 'bottom';
}

// Rotate/flip the problem so the target is below, run fn, map the result back.
function oriented(fn, p, u, v, W, H, T, side, out) {
    switch (side) {
    case 'top':
        fn(p, u, 1 - v, W, H, T.x, H - T.y - T.height, T.width, T.height, out);
        out.y = H - out.y;
        break;
    case 'right': {
        fn(p, v, u, H, W, T.y, T.x, T.height, T.width, out);
        const x = out.x;
        out.x = out.y;
        out.y = x;
        break;
    }
    case 'left': {
        fn(p, v, 1 - u, H, W, T.y, W - T.x - T.width, T.height, T.width, out);
        const x = out.x;
        out.x = W - out.y;
        out.y = x;
        break;
    }
    default:
        fn(p, u, v, W, H, T.x, T.y, T.width, T.height, out);
    }
    return out;
}

// `out` is optional; pass a reused {x, y} to avoid allocating per call.
export function genieVertex(p, u, v, W, H, T, side = targetSide(W, H, T), out = {x: 0, y: 0}) {
    return oriented(genieDown, p, u, v, W, H, T, side, out);
}

export function suckVertex(p, u, v, W, H, T, side = targetSide(W, H, T), out = {x: 0, y: 0}) {
    return oriented(suckDown, p, u, v, W, H, T, side, out);
}
