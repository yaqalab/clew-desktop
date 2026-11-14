'use strict';
// The folder Clew keeps its vault copies in (`src/folder.js`): inside its root and nowhere else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFolder } = require('../src/folder');

const fresh = () => createFolder(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-')), 'Clew'));

test('writes, lists, reads and removes, relative to the root', async () => {
  const folder = fresh();
  assert.deepEqual(await folder.list(''), [], 'a root not made yet is empty');
  await folder.write('Fieldwork/vault.json', new TextEncoder().encode('{}'));
  await folder.write('Fieldwork/research/memo/a.bin', new Uint8Array([1, 2, 3]));

  const all = (await folder.list('Fieldwork')).map((i) => i.path).sort();
  assert.deepEqual(all, ['research/memo/a.bin', 'vault.json']);
  const top = await folder.list('', { recursive: false });
  assert.deepEqual(top.map((i) => [i.path, i.dir]), [['Fieldwork', true]]);
  assert.deepEqual([...(await folder.read('Fieldwork/research/memo/a.bin'))], [1, 2, 3]);

  // Removing the last file in a folder removes the folders it leaves empty, not the root.
  await folder.remove('Fieldwork/research/memo/a.bin');
  assert.equal(fs.existsSync(path.join(folder.root, 'Fieldwork', 'research')), false);
  assert.equal(fs.existsSync(path.join(folder.root, 'Fieldwork', 'vault.json')), true);
  await folder.remove('Fieldwork/research/memo/a.bin'); // already gone: fine
  await assert.rejects(folder.read('Fieldwork/nothing.bin'), /ENOENT/);
});

test('replaces a file whole and leaves no temporary file behind', async () => {
  const folder = fresh();
  await folder.write('v/x.bin', new Uint8Array([1]));
  await folder.write('v/x.bin', new Uint8Array([2, 2]));
  assert.deepEqual([...(await folder.read('v/x.bin'))], [2, 2]);
  assert.deepEqual(fs.readdirSync(path.join(folder.root, 'v')), ['x.bin']);
});

test('refuses every way out of the root', async () => {
  const folder = fresh();
  const bytes = new Uint8Array([1]);
  for (const bad of ['../x.bin', 'a/../../x.bin', '/etc/x', 'C:/x.bin', 'a\\..\\x.bin', '', 'a/./b', 'x\0y']) {
    await assert.rejects(folder.write(bad, bytes), /not|outside|no file/, bad);
  }
  await assert.rejects(folder.list('../'), /not allowed/);
  await assert.rejects(folder.write('big.bin', new Uint8Array(65 * 1024 * 1024)), /too large/);
  await assert.rejects(folder.write('x.bin', 'text'), /not bytes/);
});

test('does not follow a link out of the root', async (t) => {
  const folder = fresh();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.mkdirSync(folder.root, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(folder.root, 'link'), 'junction');
  } catch {
    t.skip('this system will not make the link');
    return;
  }
  await assert.rejects(folder.write('link/x.bin', new Uint8Array([1])), /outside/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(await folder.list(''), [], 'the link itself is not listed');
});
