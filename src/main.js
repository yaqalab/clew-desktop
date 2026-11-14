'use strict';
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, net, session } = require('electron');
const desktopConfig = require('../desktop.config.json');
const sites = require('./sites');
const siteUpdates = require('./site-updates');
const network = require('./network');
const policy = require('./policy');
const permissions = require('./permissions');
const screenPicker = require('./screen-picker');
const { Tools } = require('./tools');

const PARTITION = 'persist:alefa';
const SMOKE = process.argv.includes('--smoke');
// Started at login: the tray only, no window until asked for.
const HIDDEN = process.argv.includes('--hidden');
// The tools (tray, audio server) stay out of the smoke run unless asked for: it would bind the
// audio server's port, which a running Clew or the standalone tools may hold.
const WITH_TOOLS = !SMOKE || process.env.CLEW_SMOKE_TOOLS === '1';
// Newer builds of the sites (src/site-updates.js): the installed app only, never dev or smoke
// runs, unless CLEW_SITE_UPDATES=1 asks for them.
const SITE_UPDATES =
  !SMOKE && !sites.DEV && !process.env.CLEW_DESKTOP_SITES && (app.isPackaged || process.env.CLEW_SITE_UPDATES === '1');

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let appSession = null;
let tools = null;
let quitting = false;

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
// Site updates

const siteUpdatesDir = () => path.join(app.getPath('userData'), 'site-updates');
/** name → build info of a newer build, downloaded and used from the next start. */
const waiting = new Map();

/** At start, before anything is served: a newer downloaded build replaces the installer's. */
function activateSiteUpdates() {
  for (const site of sites.list) {
    try {
      const active = siteUpdates.activate(siteUpdatesDir(), site.name, sites.buildInfo(site), app.getVersion());
      if (active) {
        site.root = active.root;
        console.log(`[updates] ${site.name}: using ${active.id} (downloaded update)`);
      }
    } catch (err) {
      console.warn(`[updates] ${site.name}: ${err.message}`);
    }
  }
}

async function checkSiteUpdates() {
  // The live sites, through the default session: it is not diverted to the bundled files.
  const base = process.env.CLEW_SITE_UPDATES_BASE;
  let found = false;
  for (const site of sites.list) {
    try {
      const current = waiting.get(site.name) ?? sites.buildInfo(site);
      const r = await siteUpdates.check(siteUpdatesDir(), site.name, {
        at: base ? `${base}/${site.name}/desktop` : `${site.origin}/desktop`,
        appVersion: app.getVersion(),
        current,
        fetchImpl: (url, opts) => net.fetch(url, opts),
      });
      if (r.status === 'ready') {
        waiting.set(site.name, r.info);
        found = true;
        console.log(`[updates] ${site.name}: ${r.build.id} downloaded, used from the next start`);
      } else if (r.status === 'needs-app') {
        console.log(`[updates] ${site.name}: ${r.build.id} needs Clew Desktop ${r.build.minDesktop}`);
      }
    } catch (err) {
      console.warn(`[updates] ${site.name}: ${err.message}`);
    }
  }
  if (found) {
    buildMenu();
    tools?.updateTray();
  }
}

function startSiteUpdates() {
  const hours = desktopConfig.siteUpdates.intervalHours || 4;
  setTimeout(checkSiteUpdates, 15000);
  setInterval(checkSiteUpdates, hours * 3600 * 1000);
}

/** "Restart to update", in the Help menu and the tray, once an update is waiting. */
function restartItems() {
  if (!waiting.size) return [];
  return [{ label: 'Restart to update', click: () => restartApp() }, { type: 'separator' }];
}

function restartApp() {
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
  quitApp();
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
        `  built ${info.builtAt}${site.root.startsWith(siteUpdatesDir()) ? ' (update)' : ' (installer)'}`,
      );
    }
    const next = waiting.get(site.name);
    if (next) lines.push(`  update ready: ${next.commit.slice(0, 12)}, used from the next start`);
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
      : [
          {
            label: 'File',
            submenu: [
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: Boolean(tools), click: () => tools?.openSettings() },
              { type: 'separator' },
              { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
            ],
          },
        ]),
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
    { role: 'help', submenu: [...restartItems(), ...(isMac ? [] : [about])] },
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
    if (!SMOKE && !mainWindow.hiddenAtStart) mainWindow.show();
  });
  // With the tray, closing the window hides it: Clew stays as it was, and the tools keep running.
  mainWindow.on('close', (event) => {
    if (tools && !quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
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

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow.hiddenAtStart = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.webContents.isLoading()) mainWindow.show();
  else mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

app.on('second-instance', () => showMainWindow());

// The audio server is asked to stop before the app goes (it would end with its stdin anyway).
let toolsStopped = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (!tools || toolsStopped) return;
  event.preventDefault();
  tools.stop().finally(() => {
    toolsStopped = true;
    app.quit();
  });
});

app.whenReady().then(async () => {
  appSession = session.fromPartition(PARTITION);
  if (SITE_UPDATES) activateSiteUpdates();
  const server = await network.install(appSession, sites);
  permissions.install(appSession, sites);
  screenPicker.install(appSession, sites, () => BrowserWindow.getFocusedWindow() ?? mainWindow);
  if (WITH_TOOLS) {
    tools = new Tools({
      openApp: showMainWindow,
      quitApp,
      firstRunLoginItem: app.isPackaged && !SMOKE,
      appItems: restartItems,
    });
    tools.start();
  }
  buildMenu();
  if (SITE_UPDATES) startSiteUpdates();
  const win = createMainWindow();
  win.hiddenAtStart = HIDDEN;
  if (SMOKE) {
    require('./smoke')
      .run(win, appSession, server, tools)
      .catch((err) => {
        console.error(err);
        app.exit(1);
      });
  }
});

app.on('window-all-closed', () => {
  // With the tray the app keeps running; without it (the smoke run), closing ends it.
  if (!tools && process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (app.isReady()) showMainWindow();
});
