'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { plan, backupEntries, backupReadme, HELPER } = require('../src/wipe');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-wipe-'));
  const profile = path.join(root, 'Clew');
  const put = (rel, text) => {
    const p = path.join(profile, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  put('Partitions/alefa/IndexedDB/https_clew.alefa.net_0.indexeddb.leveldb/000003.log', 'vault records');
  put('Partitions/alefa/Cache/Cache_Data/f_000001', 'cached');
  put('Partitions/alefa/Code Cache/js/abc', 'code');
  put('site-updates/clew/index.html', 'site');
  put('dictation/server.exe', 'program');
  put('desktop-settings.json', '{}');
  const folder = path.join(root, 'Documents', 'Clew');
  fs.mkdirSync(path.join(folder, 'Vault'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Vault', 'record.bin'), 'encrypted');
  return { root, profile, folder };
}

test('plan: each place with its size, missing ones too', async () => {
  const t = tree();
  const items = await plan({ profile: t.profile, folder: t.folder, updaterCache: path.join(t.root, 'nope') });
  assert.deepEqual(
    items.map((i) => [i.id, i.exists, i.bytes]),
    [
      ['profile', true, 13 + 6 + 4 + 4 + 7 + 2],
      ['folder', true, 9],
      ['updates', false, 0],
    ],
  );
});

test('backupEntries: the profile without caches and downloads, and the folder', async () => {
  const t = tree();
  const { entries, skipped } = await backupEntries({ profile: t.profile, folder: t.folder });
  const files = entries.filter((e) => e.path).map((e) => e.name).sort();
  assert.deepEqual(files, [
    'Clew folder/Vault/record.bin',
    'profile/Partitions/alefa/IndexedDB/https_clew.alefa.net_0.indexeddb.leveldb/000003.log',
    'profile/desktop-settings.json',
  ]);
  assert.ok(entries.some((e) => e.name === 'profile/'));
  assert.deepEqual(skipped, []);
  const none = await backupEntries({ profile: t.profile, folder: null });
  assert.ok(!none.entries.some((e) => e.name.startsWith('Clew folder')));
  assert.match(backupReadme({ profile: t.profile, folder: t.folder, made: 'now', appVersion: '1.0.0' }), /Clew folder\//);
});

test('the helper waits for the app to go, deletes, and logs', { timeout: 60000 }, async () => {
  const t = tree();
  const helper = path.join(t.root, 'helper.js');
  fs.writeFileSync(helper, HELPER);
  // The "app": a process that lives two seconds.
  const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  const job = path.join(t.root, 'job.json');
  const log = path.join(t.root, 'log.json');
  fs.writeFileSync(job, JSON.stringify({ pid: app.pid, paths: [t.profile, t.folder], log, notify: false }));
  const started = Date.now();
  execFileSync(process.execPath, [helper, job]);
  assert.ok(Date.now() - started >= 2000, 'did not wait for the app');
  assert.equal(fs.existsSync(t.profile), false);
  assert.equal(fs.existsSync(t.folder), false);
  const written = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(written.results.map((r) => r.removed), [true, true]);
  assert.equal(fs.existsSync(job), false, 'the job file stays');
});
