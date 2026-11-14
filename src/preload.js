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
      ...(location.origin === info.folderOrigin ? { folder } : {}),
    }),
  );
}
