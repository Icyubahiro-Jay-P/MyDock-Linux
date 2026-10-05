// Run: node extension/format.test.mjs
import assert from 'node:assert/strict';
import {signalLevel, formatTime} from './format.js';

assert.deepEqual([0, 19, 20, 39, 40, 49, 50, 79, 80, 100].map(signalLevel),
    ['none', 'none', 'weak', 'weak', 'ok', 'ok', 'good', 'good', 'excellent', 'excellent']);
assert.equal(formatTime(0), '00:00');
assert.equal(formatTime(-5e6), '00:00');
assert.equal(formatTime(65.9e6), '01:05');
assert.equal(formatTime(3600e6), '60:00');
console.log('format ok');
