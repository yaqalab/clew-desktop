'use strict';
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const sites = require('./sites');
const network = require('./network');
const policy = require('./policy');
const permissions = require('./permissions');
const screenPicker = require('./screen-picker');

const PARTITION = 'persist:alefa';
const SMOKE = process.argv.includes('--smoke');

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let appSession = null;

const preloadArg = `--alefa-desktop=${encodeURIComponent(
  JSON.stringify({ version: app.getVersion(), origins: sites.origins }),
)}`;

/** The webPreferences every app window and in-app popup gets. */
function webPreferences() {
  return {
    session: appSession,
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // The preload also runs in frames (it exposes nothing to non-bundled origins), so a
    // yaqatw frame inside Clew sees `window.alefaDesktop` too.
    nodeIntegrationInSubFrames: true,
    additionalArguments: [preloadArg],
  };
}

function childWindowOptions() {
  return { autoHideMenuBar: true, webPreferences: webPreferences() };
}

// ---------------------------------------------------------------------------------------------
// About

function aboutText() {
  const lines = [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    '',
  ];
  for (const site of sites.list) {
    const info = sites.buildInfo(site);
    if (sites.DEV) lines.push(`${site.name}: dev server ${site.devUrl}`);
    else if (!info) lines.push(`${site.name}: no build info`);
    else {
      lines.push(
        `${site.name} (${site.host})`,
        `  ${info.ref} @ ${info.commit.slice(0, 12)}${info.dirty ? ' (local changes)' : ''}`,
        `  built ${info.builtAt}`,
      );
    }
  }
  return lines.join('\n');
}

function showAbout() {
  const opts = { type: 'info', title: `About ${app.name}`, message: app.name, detail: aboutText() };
  return mainWindow ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
}

function fromBundledFrame(event) {
  return sites.isBundledOrigin(event.senderFrame?.origin);
}

ipcMain.handle('alefa:about', (event) => {
  if (!fromBundledFrame(event)) throw new Error('not allowed');
  return showAbout().then(() => undefined);
});

ipcMain.handle('alefa:build-info', (event) => {
  if (!fromBundledFrame(event)) throw new Error('not allowed');
  return Object.fromEntries(sites.list.map((s) => [s.name, sites.buildInfo(s)]));
});

// ---------------------------------------------------------------------------------------------
// Menu and window

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const about = { label: `About ${app.name}`, click: () => showAbout() };
  const template = [
    ...(isMac
      ? [{ label: app.name, submenu: [about, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
      : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: isMac ? [] : [about] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    title: app.name,
    show: false,
    webPreferences: webPreferences(),
  });
  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(sites.mainUrl);
  return mainWindow;
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'window' || contents.session !== appSession) return;
  // A window opened by another is an in-app popup.
  const isPopup = mainWindow !== null && contents !== mainWindow.webContents;
  policy.apply(contents, sites, childWindowOptions, isPopup);
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  appSession = session.fromPartition(PARTITION);
  const server = await network.install(appSession, sites);
  permissions.install(appSession, sites);
  screenPicker.install(appSession, sites, () => BrowserWindow.getFocusedWindow() ?? mainWindow);
  buildMenu();
  const win = createMainWindow();
  if (SMOKE) {
    require('./smoke')
      .run(win, appSession, server)
      .catch((err) => {
        console.error(err);
        app.exit(1);
      });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && app.isReady()) createMainWindow();
});
