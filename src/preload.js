'use strict';
/**
 * `window.alefaDesktop`, exposed only to the bundled origins (also inside frames, so a yaqatw
 * frame in Clew gets it). Sandboxed: no Node here, just a narrow bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = '--alefa-desktop=';
const arg = process.argv.find((a) => a.startsWith(PREFIX));
const info = arg ? JSON.parse(decodeURIComponent(arg.slice(PREFIX.length))) : null;

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
    }),
  );
}
