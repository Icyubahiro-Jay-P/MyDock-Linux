// Run: node extension/deform-math.test.mjs
import assert from 'node:assert/strict';
import {genieVertex, suckVertex, targetSide} from './deform-math.js';

const W = 800, H = 600;
const EPS = 1e-6;
const grid = [];
for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++)
        grid.push([i / 10, j / 10]);
}

// distance from a point to a rect (0 inside)
const dist = (pt, T) => Math.hypot(
    Math.max(T.x - pt.x, 0, pt.x - T.x - T.width),
    Math.max(T.y - pt.y, 0, pt.y - T.y - T.height));

const targets = {
    bottom: {x: 350, y: 900, width: 60, height: 60},
    top: {x: 100, y: -300, width: 60, height: 60},
    left: {x: -400, y: 200, width: 60, height: 60},
    right: {x: 1200, y: 500, width: 48, height: 48},
    overlap: {x: 380, y: 560, width: 60, height: 60}, // window covers the dock
};

for (const [name, fn] of [['genie', genieVertex], ['suck', suckVertex]]) {
    for (const [where, T] of Object.entries(targets)) {
        for (const [u, v] of grid) {
            const id = fn(0, u, v, W, H, T);
            assert.ok(Math.abs(id.x - u * W) < EPS && Math.abs(id.y - v * H) < EPS, `${name}/${where} p=0 identity`);
            assert.ok(dist(fn(1, u, v, W, H, T), T) < EPS, `${name}/${where} p=1 inside target`);
            let prev = Infinity;
            for (let s = 0; s <= 100; s++) {
                const d = dist(fn(s / 100, u, v, W, H, T), T);
                assert.ok(d <= prev + EPS, `${name}/${where} monotonic at p=${s / 100} u=${u} v=${v}`);
                prev = d;
            }
        }
    }
}

// the out-param path returns the same object and the same values as a fresh call
const out = {x: 0, y: 0};
for (const [where, T] of Object.entries(targets)) {
    const side = targetSide(W, H, T);
    for (const fn of [genieVertex, suckVertex]) {
        const want = fn(0.6, 0.3, 0.7, W, H, T);
        assert.equal(fn(0.6, 0.3, 0.7, W, H, T, side, out), out, `${where} out reused`);
        assert.ok(Math.abs(out.x - want.x) < EPS && Math.abs(out.y - want.y) < EPS, `${where} out values`);
    }
}

// mid-animation the bottom row is pinched far narrower than the top row
for (const [name, fn] of [['genie', genieVertex], ['suck', suckVertex]]) {
    const T = targets.bottom;
    const rowWidth = v => fn(0.5, 1, v, W, H, T).x - fn(0.5, 0, v, W, H, T).x;
    assert.ok(rowWidth(1) < 0.35 * rowWidth(0), `${name} bottom narrower: ${rowWidth(1)} vs ${rowWidth(0)}`);
}

assert.equal(targetSide(W, H, targets.bottom), 'bottom');
assert.equal(targetSide(W, H, targets.top), 'top');
assert.equal(targetSide(W, H, targets.left), 'left');
assert.equal(targetSide(W, H, targets.right), 'right');
assert.equal(targetSide(W, H, targets.overlap), 'bottom');
console.log('deform-math: ok');
