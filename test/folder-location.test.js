'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncedBy, moveTarget, moveFolder, MoveError } = require('../src/folder-location');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clew-folder-loc-'));

test('syncedBy: OneDrive from the environment, any case', () => {
  const env = { OneDrive: 'C:\\Users\\a\\OneDrive' };
  assert.equal(syncedBy('C:\\Users\\a\\onedrive\\Documents\\Clew', { env, platform: 'win32' }), 'OneDrive');
  assert.equal(syncedBy('C:\\Users\\a\\Documents\\Clew', { env, platform: 'win32' }), null);
  const business = { OneDriveCommercial: 'C:\\Users\\a\\OneDrive - Lab' };
  assert.equal(syncedBy('C:\\Users\\a\\OneDrive - Lab\\Documents\\Clew', { env: business, platform: 'win32' }), 'OneDrive');
});

test('syncedBy: folder names, when the environment says nothing', () => {
  const o = { env: {}, platform: 'linux', home: '/home/a' };
  assert.equal(syncedBy('/home/a/Dropbox/Clew', o), 'Dropbox');
  assert.equal(syncedBy('/home/a/Google Drive/My Drive/Clew', o), 'Google Drive');
  assert.equal(syncedBy('/home/a/Documents/Clew', o), null);
  assert.equal(syncedBy('/home/a/dropboxes/Clew', o), null);
});

test('syncedBy: iCloud Drive on macOS, itself or Desktop & Documents', () => {
  const home = '/Users/a';
  const icloud = (yes) => ({ env: {}, platform: 'darwin', home, exists: () => yes });
  assert.equal(syncedBy('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Clew', icloud(false)), 'iCloud Drive');
  assert.equal(syncedBy('/Users/a/Documents/Clew', icloud(true)), 'iCloud Drive');
  assert.equal(syncedBy('/Users/a/Documents/Clew', icloud(false)), null);
});

test('moveTarget: an empty folder itself, else Clew inside it; refuses loops and full folders', async () => {
  const root = tmp();
  const from = path.join(root, 'Documents', 'Clew');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'a.bin'), 'x');
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  assert.equal(await moveTarget(from, empty), empty);
  assert.equal(await moveTarget(from, path.join(root, 'new')), path.join(root, 'new'));
  const full = path.join(root, 'full');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'other.txt'), 'y');
  assert.equal(await moveTarget(from, full), path.join(full, 'Clew'));
  await assert.rejects(moveTarget(from, from), MoveError);
  await assert.rejects(moveTarget(from, path.join(root, 'Documents')), MoveError); // → Documents/Clew: the same
  await assert.rejects(moveTarget(from, path.join(from, 'sub')), MoveError);
  fs.mkdirSync(path.join(full, 'Clew'));
  fs.writeFileSync(path.join(full, 'Clew', 'z'), 'z');
  await assert.rejects(moveTarget(from, full), /already holds files/);
  await assert.rejects(moveTarget(from, 'relative/path'), MoveError);
});

test('moveFolder: everything arrives, then the old folder goes', async () => {
  const root = tmp();
  const from = path.join(root, 'old');
  fs.mkdirSync(path.join(from, 'v1', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(from, 'v1', 'record'), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(from, 'v1', 'blobs', 'b'), Buffer.alloc(5, 2));
  const to = path.join(root, 'new', 'Clew');
  const r = await moveFolder(from, to);
  assert.deepEqual(r, { files: 2, bytes: 1005, leftBehind: null });
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.readFileSync(path.join(to, 'v1', 'record')).length, 1000);
  assert.equal(fs.readFileSync(path.join(to, 'v1', 'blobs', 'b')).length, 5);
});

test('moveFolder: a folder never made moves as an empty one', async () => {
  const root = tmp();
  const r = await moveFolder(path.join(root, 'never'), path.join(root, 'new'));
  assert.equal(r.files, 0);
  assert.ok(fs.existsSync(path.join(root, 'new')));
});

test('moveFolder: a copy that fails leaves the old folder and removes the new one', async () => {
  const root = tmp();
  const from = path.join(root, 'old');
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'a'), 'a');
  const to = path.join(root, 'new');
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'a'), 'already'); // errorOnExist
  await assert.rejects(moveFolder(from, to));
  assert.equal(fs.readFileSync(path.join(from, 'a'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(to, 'a'), 'utf8'), 'already'); // not made by the move: kept
});
