'use strict';
// Quitting waits for the pages to write out what they hold (`src/settle.js`), and never for long.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSettler } = require('../src/settle');

/** A page whose preload answers `alefa:settle` after `after` ms, or never. */
function page(ipcMain, { after = 0, answers = true } = {}) {
  const asked = [];
  return {
    asked,
    send(channel, id) {
      asked.push([channel, id]);
      if (answers) setTimeout(() => ipcMain.emit('alefa:settled', {}, id), after);
    },
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
  };
}

test('waits for every page to answer', async () => {
  const ipcMain = new EventEmitter();
  const settle = createSettler(ipcMain, { timeoutMs: 1000 });
  const quick = page(ipcMain, { after: 5 });
  const slow = page(ipcMain, { after: 40 });
  const started = Date.now();
  await settle([quick, slow]);
  assert.ok(Date.now() - started >= 35, 'the slower page was waited for');
  assert.equal(quick.asked.length, 1);
  assert.equal(slow.asked[0][0], 'alefa:settle');
  assert.notEqual(quick.asked[0][1], slow.asked[0][1], 'each page has its own id');
});

test('does not wait past the timeout for a page that never answers', async () => {
  const ipcMain = new EventEmitter();
  const settle = createSettler(ipcMain, { timeoutMs: 30 });
  const started = Date.now();
  await settle([page(ipcMain, { answers: false })]);
  const took = Date.now() - started;
  assert.ok(took >= 25 && took < 500, `gave up after the timeout (${took} ms)`);
});

test('does not ask a page that is gone, crashed or still loading', async () => {
  const ipcMain = new EventEmitter();
  const settle = createSettler(ipcMain, { timeoutMs: 1000 });
  const gone = { ...page(ipcMain), isDestroyed: () => true };
  const loading = { ...page(ipcMain), isLoadingMainFrame: () => true };
  const crashed = { ...page(ipcMain), isCrashed: () => true };
  const started = Date.now();
  await settle([gone, loading, crashed, null]);
  assert.ok(Date.now() - started < 200);
  assert.deepEqual([gone.asked, loading.asked, crashed.asked], [[], [], []]);
});

test('a page that cannot be reached is not waited for', async () => {
  const ipcMain = new EventEmitter();
  const settle = createSettler(ipcMain, { timeoutMs: 1000 });
  const broken = {
    send() {
      throw new Error('Object has been destroyed');
    },
  };
  const started = Date.now();
  await settle([broken]);
  assert.ok(Date.now() - started < 200);
});

test('an answer nobody is waiting for is ignored', async () => {
  const ipcMain = new EventEmitter();
  const settle = createSettler(ipcMain, { timeoutMs: 50 });
  ipcMain.emit('alefa:settled', {}, 999);
  await settle([]);
});
