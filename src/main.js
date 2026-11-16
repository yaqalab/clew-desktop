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
const { createSettler } = require('./settle');
const { Tools } = require('./tools');
const { createAppUpdater } = require('./app-update');

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

// Updates of the app itself (src/app-update.js): the installed app only.
const APP_UPDATES = app.isPackaged && !SMOKE && process.env.CLEW_APP_UPDATES !== '0';

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let appSession = null;
let tools = null;
let quitting = false;

/** Asks pages to write out what they still hold, and waits for it (`settle.js`). */
const settle = createSettler(ipcMain);

/** The app's own pages: the main window and its in-app popups, not the Settings window. */
function appContents() {
  return BrowserWindow.getAllWindows()
    .map((w) => w.webContents)
    .filter((c) => c && !c.isDestroyed() && c.session === appSession);
}

/** Reloads a window once its page has written out what it holds. */
function reloadSettled(win, ignoreCache = false) {
  const contents = win?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const reload = () => {
    if (contents.isDestroyed()) return;
    if (ignoreCache) contents.reloadIgnoringCache();
    else contents.reload();
  };
  if (contents.session === appSession) settle([contents]).then(reload);
  else reload();
}

const preloadArg = `--alefa-desktop=${encodeURIComponent(
  JSON.stringify({ version: app.getVersion(), origins: sites.origins, folderOrigin: sites.main.origin }),
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
/** name → build info of a newer build, downloaded and used from the next start. */
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

/** The last check: when, whether one is running, and per site `{ status, id?, minDesktop?, error? }`. */
const lastCheck = { at: null, results: {} };
let checking = null;

const appUpdater = createAppUpdater({ enabled: APP_UPDATES, onChange: () => updatesChanged() });

/** What Settings › General shows. */
function updatesSnapshot() {
  return {
    enabled: SITE_UPDATES,
    app: { current: app.getVersion(), ...appUpdater.snapshot() },
    checking: Boolean(checking),
    checkedAt: lastCheck.at,
    intervalHours: desktopConfig.siteUpdates.intervalHours || 4,
    sites: sites.list.map((site) => {
      const info = sites.buildInfo(site);
      const next = waiting.get(site.name);
      return {
        name: site.name,
        host: site.host,
        commit: info?.commit ?? null,
        committedAt: info?.committedAt ?? null,
        builtAt: info?.builtAt ?? null,
        from: site.root.startsWith(siteUpdatesDir()) ? 'update' : 'installer',
        waiting: next ? { commit: next.commit, committedAt: next.committedAt } : null,
        last: lastCheck.results[site.name] ?? null,
      };
    }),
  };
}

function updatesChanged() {
  buildMenu();
  tools?.updateTray();
  tools?.send('tools:updates', updatesSnapshot());
}

/** Checks every site; a check asked for while one runs joins it. */
function checkSiteUpdates() {
  if (!SITE_UPDATES) return Promise.resolve();
  if (!checking) {
    checking = runSiteUpdateCheck().finally(() => {
      checking = null;
      updatesChanged();
    });
    updatesChanged();
  }
  return checking;
}

async function runSiteUpdateCheck() {
  // The live sites, through the default session: it is not diverted to the bundled files.
  const base = process.env.CLEW_SITE_UPDATES_BASE;
  for (const site of sites.list) {
    let result;
    try {
      const current = waiting.get(site.name) ?? sites.buildInfo(site);
      const r = await siteUpdates.check(siteUpdatesDir(), site.name, {
        at: base ? `${base}/${site.name}/desktop` : `${site.origin}/desktop`,
        appVersion: app.getVersion(),
        current,
        fetchImpl: (url, opts) => net.fetch(url, opts),
      });
      result = { status: r.status, id: r.build?.id, minDesktop: r.build?.minDesktop };
      if (r.status === 'ready') {
        waiting.set(site.name, r.info);
        console.log(`[updates] ${site.name}: ${r.build.id} downloaded, used from the next start`);
      } else if (r.status === 'needs-app') {
        console.log(`[updates] ${site.name}: ${r.build.id} needs Clew Desktop ${r.build.minDesktop}`);
      }
    } catch (err) {
      result = { status: 'error', error: err.message };
      console.warn(`[updates] ${site.name}: ${err.message}`);
    }
    lastCheck.results[site.name] = result;
  }
  lastCheck.at = new Date().toISOString();
}

/** The sites and the app itself, side by side. */
function checkAllUpdates() {
  return Promise.all([checkSiteUpdates(), appUpdater.check()]).then(updatesSnapshot);
}

function startUpdates() {
  const hours = desktopConfig.siteUpdates.intervalHours || 4;
  if (SITE_UPDATES) setTimeout(checkSiteUpdates, 15000);
  if (APP_UPDATES) setTimeout(() => appUpdater.check(), 30000);
  setInterval(checkAllUpdates, hours * 3600 * 1000);
}

/** "Restart to update", in the Help menu and the tray, once an update is waiting. */
function restartItems() {
  if (!waiting.size && !appUpdater.ready()) return [];
  return [{ label: 'Restart to update', click: () => restartApp() }, { type: 'separator' }];
}

/** Help › Check for updates: Settings › General shows the check and its result. */
function checkFromMenu() {
  tools?.openSettings('general');
  checkAllUpdates();
}

function restartApp() {
  if (appUpdater.ready()) {
    installAppUpdate();
    return;
  }
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
  quitApp();
}

/**
 * A downloaded release of the app: the pages write out what they hold and the tools stop, as on
 * any quit, and only then does the installer run (it closes whatever is still open). The new
 * version starts by itself and picks up the site updates already downloaded.
 */
function installAppUpdate() {
  if (leaving) return;
  leaving = true;
  quitting = true;
  settle(appContents())
    .then(() => (tools ? tools.stop() : undefined))
    .catch(() => undefined)
    .finally(() => {
      readyToQuit = true;
      if (!appUpdater.install()) app.quit();
    });
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

/**
 * Ctrl+wheel and a trackpad's pinch, from the preload (`src/preload.js`) once the page let the
 * wheel go: one menu step (0.5 of Chromium's zoom level, about 10 %), inside Chrome's own range.
 * Not Electron's `zoom-changed`: that is raised even for a wheel the page took for itself (over
 * Clew's editor text, which zooms only the text), and twice for one notch elsewhere (measured
 * on Electron 45.3.2).
 */
ipcMain.on('alefa:wheel-zoom', (event, direction) => {
  if (!fromBundledFrame(event) || (direction !== 1 && direction !== -1)) return;
  const contents = event.sender;
  const level = contents.getZoomLevel() + direction * 0.5;
  contents.setZoomLevel(Math.min(5, Math.max(-3, level)));
});

ipcMain.handle('alefa:build-info', (event) => {
  if (!fromBundledFrame(event)) throw new Error('not allowed');
  return Object.fromEntries(sites.list.map((s) => [s.name, sites.buildInfo(s)]));
});

// ---------------------------------------------------------------------------------------------
// Menu and window

/** The same three zooms on the keys the shown rows cannot list: Shift's +, the keypad's. */
function hiddenZoomKeys() {
  const hidden = { visible: false, acceleratorWorksWhenHidden: true };
  return [
    { role: 'zoomIn', accelerator: 'CommandOrControl+Plus', ...hidden },
    { role: 'zoomIn', accelerator: 'CommandOrControl+numadd', ...hidden },
    { role: 'zoomOut', accelerator: 'CommandOrControl+numsub', ...hidden },
    { role: 'resetZoom', accelerator: 'CommandOrControl+num0', ...hidden },
  ];
}

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
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: Boolean(tools), click: () => tools?.openSettings() },
              { type: 'separator' },
              { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
            ],
          },
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Not the stock roles: those reload at once, in the middle of a save.
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_item, win) => reloadSettled(win) },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_item, win) => reloadSettled(win, true),
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Electron's own Zoom In listens for Ctrl+Shift+= ("Plus") only. Ctrl+= first, as in
        // Chrome; the other presses people use follow, unseen. A press the page took for itself
        // (Clew's editors zoom their own text) never reaches these.
        { role: 'resetZoom' },
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        { role: 'zoomOut' },
        ...hiddenZoomKeys(),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...restartItems(),
        ...(SITE_UPDATES || APP_UPDATES ? [{ label: 'Check for updates…', click: () => checkFromMenu() }] : []),
        ...(isMac ? [] : [about]),
      ],
    },
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

// Before the app goes, however it was asked to (the menu, the tray, Restart to update, the
// system): the pages write out what they still hold — an edit inside its save delay was lost
// otherwise — and the audio server is asked to stop (it would end with its stdin anyway).
let readyToQuit = false;
let leaving = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (readyToQuit) return;
  event.preventDefault();
  if (leaving) return;
  leaving = true;
  settle(appContents())
    .then(() => (tools ? tools.stop() : undefined))
    .catch(() => undefined)
    .finally(() => {
      readyToQuit = true;
      app.quit();
    });
});

app.whenReady().then(async () => {
  appSession = session.fromPartition(PARTITION);
  if (SITE_UPDATES) activateSiteUpdates();
  const server = await network.install(appSession, sites);
  permissions.install(appSession, sites);
  screenPicker.install(appSession, sites, () => BrowserWindow.getFocusedWindow() ?? mainWindow);
  // Documents/Clew, for Clew's copy of each vault (`folder.js`); a throwaway one in a smoke run.
  const folder = require('./folder-ipc').install({
    origin: sites.main.origin,
    root:
      process.env.CLEW_FOLDER_ROOT ||
      (SMOKE
        ? path.join(require('node:os').tmpdir(), `clew-smoke-folder-${process.pid}`)
        : path.join(app.getPath('documents'), 'Clew')),
  });
  if (WITH_TOOLS) {
    tools = new Tools({
      openApp: showMainWindow,
      quitApp,
      firstRunLoginItem: app.isPackaged && !SMOKE,
      appItems: restartItems,
      parentWindow: () => (mainWindow?.isVisible() && !mainWindow.isMinimized() ? mainWindow : null),
      updates: {
        snapshot: updatesSnapshot,
        check: checkAllUpdates,
        restart: restartApp,
      },
    });
    tools.start();
  }
  buildMenu();
  startUpdates();
  const win = createMainWindow();
  win.hiddenAtStart = HIDDEN;
  if (SMOKE) {
    require('./smoke')
      .run(win, appSession, server, tools, folder)
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
