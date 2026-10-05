// Run: node extension/clockpresets.test.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CLOCK_PRESETS, presetIndex} from './clockpresets.js';

// the schema default is the first preset, so a fresh install shows it selected
const schema = readFileSync(new URL('./schemas/org.gnome.shell.extensions.mydock.gschema.xml', import.meta.url), 'utf8');
const def = /name="time-format"[^>]*><default>'([^']*)'<\/default>/.exec(schema)[1];
assert.equal(presetIndex(def), 0);

CLOCK_PRESETS.forEach(([, f], i) => assert.equal(presetIndex(f), i));
assert.equal(presetIndex('%Y-%m-%d'), CLOCK_PRESETS.length); // custom
assert.equal(presetIndex(''), CLOCK_PRESETS.length);
assert.equal(new Set(CLOCK_PRESETS.map(([, f]) => f)).size, CLOCK_PRESETS.length); // no duplicates
console.log('clockpresets ok');
