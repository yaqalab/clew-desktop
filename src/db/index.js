'use strict';
/**
 * The main-process side of `window.alefaDesktop.db` (`preload.js`): checks who calls, keeps
 * which windows opened which database, and passes the work to the database process
 * (`worker.js`, started on the first call).
 *
 * The calling frame's origin picks the site's folder, on every call; a page gives only a
 * database name. A page may use a database only after it opened it with its key: the same
 * window, until it closes it, navigates away or goes. When the last window that opened a
 * database lets go of it, the database is closed and its key forgotten.
 */
const path = require('node:path');
const { ipcMain, utilityProcess } = require('electron');

/**
 * Whether the database works here: the driver loads and its cipher library is there (an
 * in-memory database cannot take a key, so that part is not tried). Pages get
 * `alefaDesktop.db` only if it does.
 */
function probe() {
  try {
    const Database = require('better-sqlite3-multiple-ciphers');
    const db = new Database(':memory:');
    try {
      db.prepare('select sqlite3mc_version() v').get();
    } finally {
      db.close();
    }
    return true;
  } catch (err) {
    console.warn(`[db] not available: ${err.message}`);
    return false;
  }
}

const fail = (code, message) => ({ ok: false, code, message });

/**
 * @param {{ root: string, origins: string[] }} opts  the `db` folder, and the origins allowed
 */
function install({ root, origins }) {
  const allowed = new Set(origins);
  let child = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map();
  /** `host/name` → ids of the web contents that opened it */
  const holders = new Map();
  const watched = new Set();

  function start() {
    child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [root], {
      serviceName: 'Clew databases',
      stdio: 'inherit',
    });
    const proc = child;
    ready = new Promise((resolve) => proc.once('spawn', resolve));
    proc.on('message', ({ id, ...answer }) => {
      const done = pending.get(id);
      if (!done) return;
      pending.delete(id);
      done(answer);
    });
    proc.on('exit', (code) => {
      if (child !== proc) return;
      child = null;
      // The databases closed with it: every window has to open them again.
      holders.clear();
      for (const done of pending.values()) done(fail('crashed', `the database process ended (${code})`));
      pending.clear();
      if (code !== 0) console.warn(`[db] the database process ended (${code})`);
    });
  }

  async function call(op, ...args) {
    if (!child) start();
    await ready;
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.postMessage({ id, op, args });
    });
  }

  const keyOf = (host, name) => `${host}/${name}`;

  function release(wcId, host, name) {
    const k = keyOf(host, name);
    const set = holders.get(k);
    if (!set || !set.delete(wcId)) return Promise.resolve();
    if (set.size) return Promise.resolve();
    holders.delete(k);
    return call('close', host, name);
  }

  function releaseAll(wcId) {
    for (const [k, set] of [...holders]) {
      if (!set.has(wcId)) continue;
      const i = k.indexOf('/');
      release(wcId, k.slice(0, i), k.slice(i + 1)).catch(() => undefined);
    }
  }

  function hold(contents, host, name) {
    const k = keyOf(host, name);
    if (!holders.has(k)) holders.set(k, new Set());
    holders.get(k).add(contents.id);
    if (watched.has(contents.id)) return;
    watched.add(contents.id);
    const id = contents.id;
    contents.on('destroyed', () => {
      watched.delete(id);
      releaseAll(id);
    });
    // A reload or another page: the new page opens again, with its key.
    contents.on('did-navigate', () => releaseAll(id));
  }

  ipcMain.handle('db:call', async (event, op, ...args) => {
    const origin = event.senderFrame?.origin;
    if (!allowed.has(origin)) return fail('not-allowed', 'not allowed');
    const host = new URL(origin).host;
    const contents = event.sender;
    const [name, ...rest] = args;
    switch (op) {
      case 'info':
        return call('info');
      case 'list':
        return call('list', host);
      case 'open': {
        const answer = await call('open', host, name, rest[0]);
        if (answer.ok) hold(contents, host, name);
        return answer;
      }
      case 'remove':
        return call('remove', host, name);
      case 'close':
        await release(contents.id, host, name);
        return { ok: true };
      case 'query':
      case 'run':
      case 'batch':
      case 'rekey':
        if (!holders.get(keyOf(host, name))?.has(contents.id)) return fail('locked', 'the database is not open');
        return call(op, host, name, ...rest);
      default:
        return fail('bad-args', `unknown: ${op}`);
    }
  });

  /** Before quitting: every database closed (its WAL written back), then the process ends. */
  async function stop() {
    if (!child) return;
    const proc = child;
    await Promise.race([call('closeAll'), new Promise((r) => setTimeout(r, 3000))]);
    holders.clear();
    child = null;
    proc.kill();
  }

  return { root, stop, call };
}

module.exports = { probe, install };
