'use strict';
/**
 * `getDisplayMedia()` for the bundled origins. On macOS the system picker is used where
 * Electron supports it; everywhere else (and as macOS's fallback) a small chooser built on
 * `desktopCapturer` lists screens and windows. Other origins are refused.
 */
const path = require('node:path');
const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');

const pending = new Map(); // picker webContents id → { sources, resolve }

ipcMain.handle('picker:sources', (event) => {
  const entry = pending.get(event.sender.id);
  if (!entry) return [];
  return entry.sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
  }));
});

ipcMain.on('picker:choose', (event, id) => {
  const entry = pending.get(event.sender.id);
  if (entry) entry.resolve(typeof id === 'string' ? id : null);
});

function choose(parent, sources) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent ?? undefined,
      modal: Boolean(parent),
      width: 760,
      height: 560,
      title: 'Choose what to share',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const id = win.webContents.id;
    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      pending.delete(id);
      if (!win.isDestroyed()) win.close();
      resolve(choice);
    };
    pending.set(id, { sources, resolve: finish });
    win.on('closed', () => finish(null));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, 'picker.html'));
  });
}

function install(ses, sites, getParentWindow) {
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const origin = sites.originOf(request.securityOrigin || request.frame?.url || '');
      if (!sites.isBundledOrigin(origin)) {
        console.warn(`[screen] denied screen sharing to ${origin}`);
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
        });
        const chosenId = await choose(getParentWindow(), sources);
        const source = sources.find((s) => s.id === chosenId);
        if (!source) {
          callback({});
          return;
        }
        const streams = { video: source };
        // System audio capture is only available on Windows.
        if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
        callback(streams);
      } catch (err) {
        console.error('[screen] picker failed:', err);
        callback({});
      }
    },
    { useSystemPicker: true },
  );
}

module.exports = { install };
