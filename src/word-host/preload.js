'use strict';
/**
 * Preload of a Word window (`src/word-host/`): `window.clewWord`, for the host page only (the
 * yaqatw frame inside gets nothing: no preload runs in frames of this window). Every call is
 * checked again in the main process (`main.js`, Word windows).
 */
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'clew-word:') {
  contextBridge.exposeInMainWorld('clewWord', {
    /** `{ session, title, path, open }` of this window's document. */
    info: () => ipcRenderer.invoke('word:info'),
    /** Asks Word to do `op`; resolves with Word's answer. */
    call: (op, args) => ipcRenderer.invoke('word:call', String(op), args ?? {}),
    /** What happens in Word (`selection`) and to the session (`closed`). */
    onEvent: (cb) => {
      const listener = (_event, name, payload) => cb(name, payload);
      ipcRenderer.on('word:event', listener);
      return () => ipcRenderer.off('word:event', listener);
    },
  });
}
