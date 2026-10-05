// Run: node extension/shell-range.test.mjs
// The supported GNOME Shell range is written in several places; this fails when they disagree.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const meta = JSON.parse(read('./metadata.json'));
const versions = meta['shell-version'].map(Number);
const min = Math.min(...versions);
const max = Math.max(...versions);

assert.deepEqual(versions, Array.from({length: max - min + 1}, (_, i) => min + i),
    'metadata.json shell-version must be a continuous, sorted range');

const stub = read('../install-stub.sh');
assert.match(stub, new RegExp(`^MIN_SHELL=${min} MAX_SHELL=${max}$`, 'm'), 'install-stub.sh MIN_SHELL / MAX_SHELL');
assert.match(stub, new RegExp(`GNOME Shell ${min}-${max}\\b`), 'install-stub.sh header comment');

const build = read('../build.sh');
assert.match(build, new RegExp(`gnome-shell \\(>= ${min}\\), gnome-shell \\(<< ${max + 1}\\)`), 'build.sh .deb Depends');
const shim = /"shell-version": \[([^\]]*)\]/.exec(build)?.[1].match(/\d+/g).map(Number);
assert.deepEqual(shim, versions, 'build.sh migration shim shell-version');

assert.ok(Number.isInteger(meta.version) && meta.version > 0, 'metadata.json version is a positive integer');
assert.match(meta['version-name'], /^\d+\.\d+\.\d+$/, 'metadata.json version-name is x.y.z');
console.log('shell-range ok');
