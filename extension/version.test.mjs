// Run: node extension/version.test.mjs
import assert from 'node:assert/strict';
import {compareVersions as cmp} from './version.js';

assert.ok(cmp('1.0.1', '1.0.0') > 0);
assert.ok(cmp('1.10.0', '1.9.9') > 0);
assert.ok(cmp('v2.0.0', '1.99.99') > 0);
assert.ok(cmp('1.0.0', '1.0.1') < 0);
assert.equal(cmp('v1.2', '1.2.0'), 0);
assert.equal(cmp('1.2.3-beta', '1.2.3'), 0);
assert.equal(cmp('garbage', '0.0.0'), 0);
console.log('version: ok');
