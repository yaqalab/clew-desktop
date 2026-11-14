'use strict';
/**
 * The IPC behind `window.alefaDesktop.folder` (`preload.js`): only Clew's own origin may call
 * it — checked here, on every call, from the frame that sent it, whatever the preload exposed.
 */
const fs = require('node:fs');
const { ipcMain, shell } = require('electron');
const { createFolder } = require('./folder');

/**
 * @param {{ origin: string, root: string }} opts  the one origin allowed, and the folder's root
 * @returns the folder (for the smoke run)
 */
function install({ origin, root }) {
  const folder = createFolder(root);
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (event.senderFrame?.origin !== origin) throw new Error('not allowed');
      return fn(...args);
    });

  handle('folder:root', () => folder.root);
  handle('folder:list', (dir, opts) => folder.list(dir, opts));
  handle('folder:read', (rel) => folder.read(rel));
  handle('folder:write', (rel, bytes) => folder.write(rel, bytes));
  handle('folder:remove', (rel) => folder.remove(rel));
  handle('folder:reveal', async (rel = '') => {
    const abs = folder.locate(rel, { allowRoot: true });
    fs.mkdirSync(folder.root, { recursive: true });
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) shell.showItemInFolder(abs);
    else await shell.openPath(fs.existsSync(abs) ? abs : folder.root);
  });
  return folder;
}

module.exports = { install };
