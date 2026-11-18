'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppSettings, DEFAULTS } = require('../src/app-settings');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-app-settings-'));
  return path.join(dir, 'sub', 'desktop-settings.json');
}

test('no file: the defaults', () => {
  assert.deepEqual(createAppSettings(tempFile()).get(), DEFAULTS);
});

test('set keeps known keys of the right type, and what else the file holds', () => {
  const file = tempFile();
  const s = createAppSettings(file);
  assert.equal(s.set({ devTools: true }).devTools, true);
  assert.equal(createAppSettings(file).get().devTools, true);
  s.set({ devTools: 'yes', other: 1 });
  assert.equal(s.get().devTools, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).other, undefined);
  fs.writeFileSync(file, JSON.stringify({ devTools: true, later: 'kept' }));
  s.set({ devTools: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { devTools: false, later: 'kept' });
});

test('a broken file is the defaults, and set repairs it', () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const s = createAppSettings(file);
  assert.deepEqual(s.get(), DEFAULTS);
  assert.equal(s.set({ devTools: true }).devTools, true);
});
