'use strict';
/**
 * `window.alefaDesktop`, exposed only to the bundled origins (also inside frames, so a yaqatw
 * frame in Clew gets it). Sandboxed: no Node here, just a narrow bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = '--alefa-desktop=';
const arg = process.argv.find((a) => a.startsWith(PREFIX));
const info = arg ? JSON.parse(decodeURIComponent(arg.slice(PREFIX.length))) : null;

/**
 * One folder on this computer (`Documents/Clew`), for Clew only: it keeps an encrypted copy of
 * each vault there (Clew's `docs/44`). Paths are relative to that folder and `/`-separated.
 */
const folder = Object.freeze({
  /** Where the folder is, as a person would find it. */
  root: () => ipcRenderer.invoke('folder:root'),
  /** `[{ path, dir, size, modified }]` under `dir`; every file below it unless `{ recursive: false }`. */
  list: (dir, opts) => ipcRenderer.invoke('folder:list', dir, opts),
  read: (path) => ipcRenderer.invoke('folder:read', path),
  /** Whole or not at all; makes the folders on the way. */
  write: (path, bytes) => ipcRenderer.invoke('folder:write', path, bytes),
  remove: (path) => ipcRenderer.invoke('folder:remove', path),
  /** Shows the file or folder in the system's file manager. */
  reveal: (path) => ipcRenderer.invoke('folder:reveal', path),
});

/**
 * The site's encrypted databases (SQLCipher), for any bundled site; there only when the
 * database works. A site has its own folder of databases; the page names a database and brings
 * its key (32 bytes) to open it.
 *
 * Errors start with their code, `wrong-key: wrong key`, because only an error's message
 * reaches the page (the bridge drops other properties); `db.codeOf(err)` gives the code:
 * `locked`, `wrong-key`, `bad-name`, `bad-key`, `bad-args`, `in-use`, `refused`, `sqlite`,
 * `crashed`.
 */
async function dbCall(op, ...args) {
  const answer = await ipcRenderer.invoke('db:call', op, ...args);
  if (answer.ok) return answer.value;
  throw new Error(`${answer.code}: ${answer.message}`);
}

/** The handle `open` gives: the database's statements, until `close()`. */
function dbHandle(name) {
  return Object.freeze({
    name,
    /** One statement that gives rows: `[{ column: value }]`. */
    query: (sql, params) => dbCall('query', name, sql, params),
    /** One statement that changes things: `{ changes, lastInsertRowid }`. */
    run: (sql, params) => dbCall('run', name, sql, params),
    /** `[{ sql, params }]` in one transaction, all or nothing: each gives `{ rows }` or `{ changes, lastInsertRowid }`. */
    batch: (items) => dbCall('batch', name, items),
    /** Re-encrypts the database with a new key. */
    rekey: (key) => dbCall('rekey', name, key),
    close: () => dbCall('close', name),
  });
}

const db = Object.freeze({
  /** `{ api, engine, sqlite, cipher }` */
  info: () => dbCall('info'),
  /** The site's databases: `[{ name, size, modified, open }]`. */
  list: () => dbCall('list'),
  /** Opens (or, the first time, creates) a database with its key; gives a handle. */
  open: async (name, key) => {
    await dbCall('open', name, key);
    return dbHandle(name);
  },
  /** Deletes a database; it must be closed. */
  remove: (name) => dbCall('remove', name),
  /** The code an error from here starts with (`'wrong-key'`), or null for any other error. */
  codeOf: (err) => /^([a-z-]+): /.exec(String(err?.message ?? ''))?.[1] ?? null,
});

/**
 * What the page asked to finish before the app quits, restarts or reloads it: Clew writes out
 * the edits it still holds (`src/settle.js`). The main process sends `alefa:settle`; the answer
 * goes back once every handler has finished, whatever it did. With no handler — yaqatw, a
 * sign-in popup, an older Clew — the answer is immediate.
 */
const beforeQuit = new Set();
ipcRenderer.on('alefa:settle', (_event, id) => {
  Promise.allSettled([...beforeQuit].map((fn) => Promise.resolve().then(fn))).then(() =>
    ipcRenderer.send('alefa:settled', id),
  );
});

if (info && info.origins.includes(location.origin)) {
  contextBridge.exposeInMainWorld(
    'alefaDesktop',
    Object.freeze({
      isDesktop: true,
      version: info.version,
      platform: process.platform,
      /** Commit and build time of each bundled site. */
      buildInfo: () => ipcRenderer.invoke('alefa:build-info'),
      /** Opens the About dialog. */
      about: () => ipcRenderer.invoke('alefa:about'),
      /**
       * Registers work to finish before the app quits, restarts or reloads the page: `fn` may
       * return a promise, which is waited for (a few seconds at most).
       */
      onBeforeQuit: (fn) => {
        if (typeof fn === 'function') beforeQuit.add(fn);
      },
      ...(location.origin === info.folderOrigin ? { folder } : {}),
      ...(info.db ? { db } : {}),
    }),
  );

  /*
   * Ctrl+wheel zooms the page, as in a browser (Electron leaves it to the app). Heard last, on
   * the window, so a wheel the page took for itself is left alone: over Clew's editor text it
   * zooms only the text. A mouse sends about 100 per notch, a trackpad's pinch many small
   * amounts, so they are added up and a step is asked for at each half notch.
   */
  let wheelSum = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      wheelSum += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (Math.abs(wheelSum) < 50) return;
      ipcRenderer.send('alefa:wheel-zoom', wheelSum < 0 ? 1 : -1);
      wheelSum = 0;
    },
    { passive: true },
  );
}
