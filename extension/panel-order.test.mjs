// Run: node extension/panel-order.test.mjs
import assert from 'node:assert/strict';
import {entryRole, mergeOrder} from './panel-order.js';

assert.equal(entryRole('right:appindicator-:1.80/org/ayatana'), 'appindicator-:1.80/org/ayatana');

// apply: Wi-Fi was never saved; it stays right after the stat it sits next to, not after the clock
assert.deepEqual(
    mergeOrder(['right:mydock-stat-cpu', 'right:mydock-control-center', 'right:dateMenu'],
        ['right:mydock-stat-cpu', 'right:mydock-wifi', 'right:mydock-control-center', 'right:dateMenu']),
    ['right:mydock-stat-cpu', 'right:mydock-wifi', 'right:mydock-control-center', 'right:dateMenu']);
// apply: an unseen item at the very start goes first; the saved box wins for a known role
assert.deepEqual(mergeOrder(['left:b', 'right:c'], ['right:x', 'right:b', 'right:c']),
    ['right:x', 'left:b', 'right:c']);
// save: a stat that is switched off keeps its slot between its saved neighbours
assert.deepEqual(mergeOrder(['right:a', 'right:c'], ['right:a', 'right:off', 'right:c']),
    ['right:a', 'right:off', 'right:c']);
assert.deepEqual(mergeOrder([], ['right:a']), ['right:a']);
console.log('panel-order ok');
