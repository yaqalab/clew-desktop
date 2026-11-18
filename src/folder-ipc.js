'use strict';
/**
 * The IPC behind `window.alefaDesktop.folder` (`preload.js`): only Clew's own origin may call
 * it — checked here, on every call, from the frame that sent it, whatever the preload exposed.
 *
 * The folder can move (Settings › General, `folder-location.js`): while it does, calls wait, and
 * afterwards they reach the new place.
 */
const fs = require('node:fs');
const { ipcMain, shell } = require('electron');
const { createFolder } = require('./folder');
const { moveFolder } = require('./folder-location');

/**
 * @param {{ origin: string, root: string }} opts  the one origin allowed, and the folder's root
 * @returns the folder: its `root` and operations (for the smoke run), and `moveTo`
 */
function install({ origin, root }) {
  let folder = createFolder(root);
  /** Set while the folder moves: calls wait for it. */
  let moving = null;
  /** Calls under way, so a move waits for them. */
  let busy = 0;
  let idle = null;

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.senderFrame?.origin !== origin) throw new Error('not allowed');
      while (moving) await moving.catch(() => {});
      busy++;
      try {
        return await fn(...args);
      } finally {
        busy--;
        if (!busy && idle) idle();
      }
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

  /** Moves every file to `target` (checked by the caller), then serves from there. */
  async function moveTo(target) {
    if (moving) throw new Error('The folder is already moving.');
    let done;
    moving = new Promise((resolve, reject) => (done = { resolve, reject }));
    try {
      if (busy) await new Promise((resolve) => (idle = resolve));
      idle = null;
      const result = await moveFolder(folder.root, target);
      folder = createFolder(target);
      done.resolve();
      return result;
    } catch (err) {
      done.reject(err);
      throw err;
    } finally {
      moving = null;
    }
  }

  return {
    get root() {
      return folder.root;
    },
    list: (...a) => folder.list(...a),
    read: (...a) => folder.read(...a),
    write: (...a) => folder.write(...a),
    remove: (...a) => folder.remove(...a),
    locate: (...a) => folder.locate(...a),
    moveTo,
  };
}

module.exports = { install };
