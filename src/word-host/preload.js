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
    /** The host page answers actions (Word's ribbon, the code picker) with `handler`. */
    onAction: (handler) => {
      ipcRenderer.on('word:action', async (_event, id, name, args) => {
        try {
          ipcRenderer.send('word:action-result', id, true, await handler(name, args));
        } catch (err) {
          ipcRenderer.send('word:action-result', id, false, String((err && err.message) || err));
        }
      });
      // The main process holds actions until the page listens (a hidden window still loading).
      ipcRenderer.send('word:host-ready');
    },
    /** The code picker: an action carried out by this document's Yaqatw. */
    action: (name, args) => ipcRenderer.invoke('word:picker-action', String(name), args ?? {}),
    /** The code picker closes itself. */
    close: () => ipcRenderer.send('word:picker-close'),
  });
}
