// Run: node extension/calendar.test.mjs
import assert from 'node:assert/strict';
import {monthGrid, weekdayOrder} from './calendar-math.js';

assert.deepEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6]);
assert.deepEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0]);
assert.deepEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5]);

// October 2026 starts on a Thursday and has 31 days
let g = monthGrid(2026, 10, 0);
assert.equal(g.length, 31);
assert.deepEqual(g[0], {day: 1, col: 4, row: 0});
assert.deepEqual(g[30], {day: 31, col: 6, row: 4});
g = monthGrid(2026, 10, 1); // Monday first
assert.deepEqual(g[0], {day: 1, col: 3, row: 0});
assert.deepEqual(g[4], {day: 5, col: 0, row: 1});

// leap years
assert.equal(monthGrid(2024, 2).length, 29);
assert.equal(monthGrid(2100, 2).length, 28);
assert.equal(monthGrid(2000, 2).length, 29);

// February 2026 starts on a Sunday: column 0 when Sunday is first, column 6 when Monday is
assert.deepEqual(monthGrid(2026, 2, 0)[0], {day: 1, col: 0, row: 0});
assert.deepEqual(monthGrid(2026, 2, 1)[0], {day: 1, col: 6, row: 0});

// every month, every week start: days fill consecutive cells and fit in 6 rows
for (let ws = 0; ws < 7; ws++) {
    for (let m = 1; m <= 12; m++) {
        const cells = monthGrid(2026, m, ws);
        const lead = cells[0].row * 7 + cells[0].col;
        assert.ok(lead < 7);
        cells.forEach((c, i) => assert.equal(c.row * 7 + c.col, lead + i));
        assert.ok(cells.at(-1).row <= 5);
    }
}

console.log('calendar: all passed');
