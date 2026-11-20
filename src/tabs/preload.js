'use strict';
/* The tab strip's bridge: what it shows comes in, which tab was chosen or closed goes out. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'clewTabs',
  Object.freeze({
    onState: (fn) => {
      if (typeof fn === 'function') ipcRenderer.on('tabs:state', (_event, state) => fn(state));
    },
    activate: (id) => ipcRenderer.send('tabs:activate', Number(id)),
    close: (id) => ipcRenderer.send('tabs:close', Number(id)),
    /** Puts tab `id` at position `index` (from 0) on the strip. */
    move: (id, index) => ipcRenderer.send('tabs:move', Number(id), Number(index)),
    ready: () => ipcRenderer.send('tabs:ready'),
  }),
);
