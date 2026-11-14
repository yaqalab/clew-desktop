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
    }),
  );
}
