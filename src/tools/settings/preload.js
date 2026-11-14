'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('tools', {
  call: (cmd, args) => ipcRenderer.invoke('tools:call', cmd, args),
  snapshot: () => ipcRenderer.invoke('tools:snapshot'),
  log: () => ipcRenderer.invoke('tools:log'),
  copy: (text) => ipcRenderer.invoke('tools:copy', text),
  openPath: (p) => ipcRenderer.invoke('tools:open-path', p),
  pickFolder: (title) => ipcRenderer.invoke('tools:pick-folder', title),
  pickFile: (title) => ipcRenderer.invoke('tools:pick-file', title),
  loginItem: () => ipcRenderer.invoke('tools:login-item'),
  setLoginItem: (on) => ipcRenderer.invoke('tools:set-login-item', on),
  openApp: () => ipcRenderer.invoke('tools:open-app'),
  installDictation: () => ipcRenderer.invoke('tools:install-dictation'),
  uninstallDictation: () => ipcRenderer.invoke('tools:uninstall-dictation'),
  updates: () => ipcRenderer.invoke('tools:updates'),
  checkUpdates: () => ipcRenderer.invoke('tools:check-updates'),
  restartToUpdate: () => ipcRenderer.invoke('tools:restart-to-update'),
  onUpdates: on('tools:updates'),
  onStatus: on('tools:status'),
  onLog: on('tools:log'),
  onTab: on('tools:tab'),
});
