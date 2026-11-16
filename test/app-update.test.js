'use strict';
// Updates of the app itself (`src/app-update.js`), against a fake electron-updater.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdater, shortError } = require('../src/app-update');

/** An autoUpdater double: `checkForUpdates` plays the events electron-updater would. */
function fakeUpdater(script) {
  const u = new EventEmitter();
  u.checks = 0;
  u.installed = null;
  u.setFeedURL = (feed) => (u.feed = feed);
  u.checkForUpdates = async () => {
    u.checks += 1;
    return script(u);
  };
  u.quitAndInstall = (silent, runAfter) => (u.installed = { silent, runAfter });
  return u;
}

const newer = (u) => {
  u.emit('update-available', { version: '0.3.0' });
  const downloadPromise = (async () => {
    u.emit('download-progress', { percent: 41.7 });
    u.emit('update-downloaded', { version: '0.3.0' });
  })();
  return { updateInfo: { version: '0.3.0' }, downloadPromise };
};

test('finds, downloads and installs a newer release', async () => {
  const seen = [];
  const updater = fakeUpdater(newer);
  const up = createAppUpdater({ enabled: true, updater, onChange: () => seen.push(up.snapshot().status) });
  assert.equal(updater.autoDownload, undefined, 'configured lazily, on the first check');

  const snap = await up.check();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(snap.status, 'ready');
  assert.equal(snap.version, '0.3.0');
  assert.ok(snap.checkedAt);
  assert.ok(seen.includes('downloading'));
  assert.equal(up.ready(), true);

  await up.check();
  assert.equal(updater.checks, 1, 'nothing more to check once one is ready');
  assert.equal(up.install(), true);
  assert.deepEqual(updater.installed, { silent: true, runAfter: true });
});

test('up to date, and concurrent checks share one', async () => {
  const updater = fakeUpdater((u) => {
    u.emit('update-not-available', {});
    return { updateInfo: { version: '0.2.0' } };
  });
  const up = createAppUpdater({ enabled: true, updater, onChange: () => {} });
  const [a, b] = await Promise.all([up.check(), up.check()]);
  assert.equal(updater.checks, 1);
  assert.equal(a.status, 'up-to-date');
  assert.equal(b.status, 'up-to-date');
  assert.equal(up.install(), false, 'nothing to install');
  assert.equal(updater.installed, null);
});

test('a failed check is shown, short, and the next check tries again', async () => {
  let fail = true;
  const updater = fakeUpdater((u) => {
    if (fail) throw new Error('HttpError: 404 \n"method: GET url: https://github.com/…/latest.yml"\nheaders…');
    u.emit('update-not-available', {});
    return {};
  });
  const up = createAppUpdater({ enabled: true, updater, onChange: () => {} });
  const first = await up.check();
  assert.equal(first.status, 'error');
  assert.equal(first.error, 'no release found');
  fail = false;
  assert.equal((await up.check()).status, 'up-to-date');
});

test('off: never touches the updater', async () => {
  const up = createAppUpdater({
    enabled: false,
    onChange: () => {},
    updater: {
      get checkForUpdates() {
        throw new Error('touched');
      },
    },
  });
  assert.equal((await up.check()).status, 'idle');
  assert.equal(up.install(), false);
});

test('error text keeps its first line', () => {
  assert.equal(shortError(new Error('net::ERR_INTERNET_DISCONNECTED\nmore')), 'net::ERR_INTERNET_DISCONNECTED');
});
