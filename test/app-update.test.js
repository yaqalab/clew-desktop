'use strict';
// Updates of the app itself (`src/app-update.js`), against a fake electron-updater.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdater, shortError, newerThan, githubLatestRelease } = require('../src/app-update');

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

test('tell only (macOS): says a newer release is out, downloads and installs nothing', async () => {
  let latest = { version: '0.5.0', url: 'https://github.com/o/r/releases/tag/v0.5.0' };
  const up = createAppUpdater({
    enabled: true,
    onChange: () => {},
    currentVersion: '0.4.0',
    latestRelease: async () => latest,
    updater: {
      get checkForUpdates() {
        throw new Error('electron-updater touched');
      },
    },
  });
  const found = await up.check();
  assert.equal(found.tellOnly, true);
  assert.equal(found.status, 'available');
  assert.equal(found.version, '0.5.0');
  assert.equal(found.url, latest.url);
  assert.equal(up.ready(), false);
  assert.equal(up.install(), false);

  latest = { version: '0.4.0', url: 'x' };
  assert.equal((await up.check()).status, 'up-to-date');
});

test('tell only: a failed check is said, not thrown', async () => {
  const up = createAppUpdater({
    enabled: true,
    onChange: () => {},
    currentVersion: '0.4.0',
    latestRelease: async () => {
      throw new Error('could not read the latest release (403)');
    },
  });
  const s = await up.check();
  assert.equal(s.status, 'error');
  assert.match(s.error, /403/);
});

test('versions compare by number, ignoring v and a pre-release', () => {
  assert.equal(newerThan('0.10.0', '0.9.9'), true);
  assert.equal(newerThan('v0.4.1', '0.4.0'), true);
  assert.equal(newerThan('0.4.0', '0.4.0'), false);
  assert.equal(newerThan('0.4.0-beta.1', '0.4.0'), false);
  assert.equal(newerThan('0.3.9', '0.4.0'), false);
});

test("the latest release is read from GitHub's API", async () => {
  let asked = null;
  const fake = async (url) => {
    asked = url;
    return { ok: true, json: async () => ({ tag_name: 'v0.4.1', html_url: 'https://h/v0.4.1' }) };
  };
  assert.deepEqual(await githubLatestRelease('yaqalab/clew-desktop', fake), {
    version: '0.4.1',
    url: 'https://h/v0.4.1',
  });
  assert.equal(asked, 'https://api.github.com/repos/yaqalab/clew-desktop/releases/latest');
  const refused = async () => ({ ok: false, status: 404 });
  await assert.rejects(githubLatestRelease('o/r', refused), /404/);
});

test('error text keeps its first line', () => {
  assert.equal(shortError(new Error('net::ERR_INTERNET_DISCONNECTED\nmore')), 'net::ERR_INTERNET_DISCONNECTED');
});
