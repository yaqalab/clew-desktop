'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, Menu, dialog, ipcMain, net, powerMonitor, protocol, session, shell } = require('electron');
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
const databases = require('./db');
const localApi = require('./local-api');
const { createWordPlugin } = require('./word-plugin');
const { createWordBridge } = require('./word-bridge');
const { createAppSettings } = require('./app-settings');

const PARTITION = 'persist:alefa';
// The host page of Word windows (src/word-host/), on an origin of its own.
const WORD_SCHEME = 'clew-word';
protocol.registerSchemesAsPrivileged([{ scheme: WORD_SCHEME, privileges: { standard: true, secure: true } }]);
const SMOKE = process.argv.includes('--smoke');
// Started at login: the tray only, no window until asked for.
const HIDDEN = process.argv.includes('--hidden');
// The tools (tray, audio server) stay out of the smoke run unless asked for: it would bind the
// audio server's port, which a running Clew or the standalone tools may hold. CLEW_TOOLS=0 keeps
// them out of any run (a second Clew for tests, beside the one in use).
const WITH_TOOLS = (!SMOKE || process.env.CLEW_SMOKE_TOOLS === '1') && process.env.CLEW_TOOLS !== '0';
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
/** The sites' encrypted databases (`src/db`), when they work here. */
const DB = databases.probe();
let db = null;
/** The local API for programs on this computer (`src/local-api.js`). */
let api = null;
/** Yaqatw for Word, the Word template the app installs (`src/word-plugin.js`); Windows only. */
let wordPlugin = null;

/** The app's own preferences (`app-settings.js`); made once the profile folder is known. */
let appSettings = null;
const settingsNow = () => appSettings?.get() ?? require('./app-settings').DEFAULTS;

/** DevTools in the View menu: always in a development run, else when Settings › General allows. */
function devToolsAllowed() {
  return !app.isPackaged || settingsNow().devTools;
}

/** Settings › General's switch: the menu follows, and turning it off closes any open DevTools. */
function setDevTools(on) {
  const next = appSettings.set({ devTools: Boolean(on) });
  if (!devToolsAllowed()) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents.isDevToolsOpened()) w.webContents.closeDevTools();
    }
  }
  buildMenu();
  return appSnapshot(next);
}

/** What Settings › General shows of the app's own preferences. */
function appSnapshot(s = settingsNow()) {
  return { devTools: s.devTools, devToolsAlways: !app.isPackaged };
}

// ---------------------------------------------------------------------------------------------
// Clew's folder (`folder-ipc.js`, `folder-location.js`): where it is, a cloud drive syncing it,
// moving it.

/** Clew's folder (`folder-ipc.js`), once the app is ready. */
let folder = null;
const folderLocation = require('./folder-location');

function defaultFolderRoot() {
  return path.join(app.getPath('documents'), 'Clew');
}

function folderRoot() {
  if (process.env.CLEW_FOLDER_ROOT) return process.env.CLEW_FOLDER_ROOT;
  if (SMOKE) return path.join(require('node:os').tmpdir(), `clew-smoke-folder-${process.pid}`);
  return settingsNow().folderRoot || defaultFolderRoot();
}

/** What Settings › General shows. */
function folderSnapshot() {
  const root = folder?.root ?? folderRoot();
  return {
    root,
    synced: folderLocation.syncedBy(root),
    fixed: Boolean(process.env.CLEW_FOLDER_ROOT) || SMOKE,
    isDefault: folderLocation.samePath(root, defaultFolderRoot()),
  };
}

function folderDialog(opts) {
  const parent = BrowserWindow.getFocusedWindow() ?? (mainWindow?.isVisible() ? mainWindow : null);
  const all = { title: app.name, noLink: true, ...opts };
  return parent ? dialog.showMessageBox(parent, all) : dialog.showMessageBox(all);
}

/** Settings › General › Move…: picks a place, says what will happen, moves, reloads Clew. */
async function moveClewFolder() {
  const snap = folderSnapshot();
  if (snap.fixed) throw new Error('The folder is set by CLEW_FOLDER_ROOT in this run.');
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const picked = await dialog.showOpenDialog(parent, {
    title: 'Choose where Clew’s folder goes',
    buttonLabel: 'Move here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return folderSnapshot();
  let target;
  try {
    target = await folderLocation.moveTarget(snap.root, picked.filePaths[0]);
  } catch (err) {
    await folderDialog({ type: 'warning', message: 'Clew’s folder cannot go there.', detail: err.message });
    return folderSnapshot();
  }
  const syncedThere = folderLocation.syncedBy(target);
  const { response } = await folderDialog({
    type: 'question',
    message: 'Move Clew’s folder?',
    detail:
      `From ${snap.root}\nTo ${target}\n\nEverything in it is copied, checked, then removed from the old place. ` +
      'Clew’s window reloads afterwards.' +
      (syncedThere ? `\n\nThe new place is in ${syncedThere} too: the files’ names and sizes will be seen there.` : ''),
    buttons: ['Move', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return folderSnapshot();
  try {
    await settle(appContents());
    const result = await folder.moveTo(target);
    appSettings.set({
      folderRoot: folderLocation.samePath(target, defaultFolderRoot()) ? '' : target,
      folderWarned: syncedThere ? target : '',
    });
    if (mainWindow) reloadSettled(mainWindow);
    await folderDialog({
      type: 'info',
      message: 'Clew’s folder was moved.',
      detail:
        `${result.files} file${result.files === 1 ? '' : 's'} now in ${target}.` +
        (result.leftBehind ? `\n\nThe old folder could not be removed: ${result.leftBehind}. Remove it yourself once Clew is closed.` : ''),
    });
  } catch (err) {
    await folderDialog({ type: 'warning', message: 'Clew’s folder was not moved.', detail: `Nothing was removed. ${err.message}` });
  }
  tools?.send('tools:folder', folderSnapshot());
  return folderSnapshot();
}

/**
 * Once per place: Clew's folder is in a cloud drive. Said when Clew's window first shows, only if
 * the folder exists (Clew made its copy there), never in a smoke run or with CLEW_FOLDER_ROOT.
 */
async function warnSyncedFolder() {
  const snap = folderSnapshot();
  if (snap.fixed || !snap.synced || !fs.existsSync(snap.root)) return;
  if (folderLocation.samePath(settingsNow().folderWarned || '/', snap.root)) return;
  appSettings.set({ folderWarned: snap.root });
  const { response } = await folderDialog({
    type: 'info',
    message: `Clew’s folder is in ${snap.synced}.`,
    detail:
      `Clew keeps an encrypted copy of each vault in ${snap.root}. What the files hold stays encrypted, ` +
      `but ${snap.synced} sees their names, sizes and times, and keeps its own history of them.\n\n` +
      'You can move the folder now, or later in Settings › General.',
    buttons: ['Move it…', 'Keep it there'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) await moveClewFolder();
}

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
  JSON.stringify({ version: app.getVersion(), origins: sites.origins, folderOrigin: sites.main.origin, db: DB }),
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
/** name 竊・build info of a newer build, downloaded and used from the next start. */
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

/** What Settings 窶ｺ General shows. */
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

/** Help 窶ｺ Check for updates: Settings 窶ｺ General shows the check and its result. */
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
  leaveApp(() => {
    if (!appUpdater.install()) app.quit();
  });
}

// ---------------------------------------------------------------------------------------------
// About

function aboutText() {
  const lines = [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} ﾂｷ Chromium ${process.versions.chrome}`,
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
// Local API

/** `CLEW_LOCAL_API_PORT`, or the fixed port programs expect. */
function localApiPort() {
  const n = Number(process.env.CLEW_LOCAL_API_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : localApi.DEFAULT_PORT;
}

/**
 * A program on this computer asks to pair. The question closes by itself when the program gives
 * up or the wait times out (`signal`). The name is the program's own: shown, never trusted.
 */
async function approveLocalClient({ name, signal }) {
  // The program asking is usually in front (Word) and Clew behind, or in the tray, and Windows
  // keeps a program behind from coming forward. The one in front allows it first (the Word
  // template calls AllowSetForegroundWindow with the pid from /v1/hello); then a window of
  // Clew's takes the front and holds the question: Clew's own window when it is open, else a
  // tiny always-on-top one.
  const shown = mainWindow?.isVisible() && !mainWindow.isMinimized();
  const holder = shown
    ? null
    : new BrowserWindow({
        width: 1,
        height: 1,
        frame: false,
        transparent: true,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        title: app.name,
      });
  const parent = holder ?? mainWindow;
  if (holder) {
    holder.center();
    holder.show();
  }
  parent.focus();
  parent.flashFrame(true);
  const opts = {
    type: 'question',
    title: app.name,
    message: `Allow 窶・{name}窶・to connect to ${app.name}?`,
    detail:
      'A program on this computer is asking to connect. Allow it only if you have just set up ' +
      'a program you trust and it told you to confirm here.',
    buttons: ['Allow', 'Don窶冲 allow'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    signal,
  };
  try {
    const { response } = await dialog.showMessageBox(parent, opts);
    const yes = response === 0 && !signal.aborted;
    // Settings lists the connected programs: the new one is added once this has returned.
    if (yes) setTimeout(wordChanged, 100);
    return yes;
  } finally {
    if (holder) holder.destroy();
    else if (!mainWindow?.isDestroyed()) mainWindow.flashFrame(false);
  }
}

async function startLocalApi() {
  const dir = SMOKE
    ? path.join(require('node:os').tmpdir(), `clew-smoke-local-api-${process.pid}`)
    : path.join(app.getPath('userData'), 'local-api');
  api = localApi.createLocalApi({
    port: SMOKE ? 0 : localApiPort(),
    clients: localApi.createClients(path.join(dir, 'clients.json')),
    approve: approveLocalClient,
    routes: wordBridge.routes,
  });
  try {
    const port = await api.listen();
    console.log(`[local-api] on http://127.0.0.1:${port}`);
  } catch {
    console.warn(`[local-api] not started: ${api.status().error}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Word windows: yaqatw working on a Word document, through Yaqatw for Word (src/word-bridge.js,
// src/word-host/). One window per document; closing it ends the session, and a document closed
// in Word says so in its window.

const WORD_HOST_DIR = path.join(__dirname, 'word-host');
const WORD_HOST_FILES = {
  'index.html': 'text/html',
  'host.js': 'text/javascript',
  'figures.js': 'text/javascript',
  'host.css': 'text/css',
  'colors.js': 'text/javascript',
  'picker.html': 'text/html',
  'picker.js': 'text/javascript',
  'picker.css': 'text/css',
  'insert.html': 'text/html',
  'insert.js': 'text/javascript',
};
const WORD_HOST_URL = `${WORD_SCHEME}://bridge/index.html`;
/** session id 竊・its window; webContents id 竊・session id. */
const wordWindows = new Map();
const wordSessionByContents = new Map();
/** session id 竊・its code picker; webContents id 竊・session id. */
const pickerWindows = new Map();
const pickerSessionByContents = new Map();
/** Actions sent to a host page, waiting for its answer: id 竊・{ resolve, reject, timer, contentsId }. */
const wordActions = new Map();
let nextWordAction = 1;
const WORD_ACTION_MS = 60000;
// Refreshing or unlinking every citation of a long document takes longer.
const WORD_LONG_ACTIONS = new Set(['refreshCitations', 'unlinkCitations']);
const WORD_LONG_ACTION_MS = 300000;

const wordBridge = createWordBridge({
  onOpen: (s, again, { show } = {}) => openWordWindow(s, show !== false),
  onClose: (s, by) => {
    if (by === 'word') wordWindows.get(s.id)?.webContents.send('word:event', 'closed', null);
    pickerWindows.get(s.id)?.close();
  },
  onEvent: (id, event, payload) => wordWindows.get(id)?.webContents.send('word:event', event, payload),
  onAction: (s, action, args) => wordAction(s, action, args),
  onStall: () => restartWordTick(),
});

// Word's tick restarted from here, as a click in Word would (Bridge.BridgeKeepTicking): Word keeps
// one OnTime timer and something can take it, and with nobody clicking in Word nothing there sets
// it again. Through COM, in the running Word; a Word in a dialog does not answer, and the attempt
// gives up. Windows only, never in a smoke run (it would reach a Word the user has open).
const WORD_TICK_SCRIPT =
  "$w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); [void]$w.Run('BridgeKeepTicking')";
let restartingTick = false;
function restartWordTick() {
  if (process.platform !== 'win32' || SMOKE || restartingTick) return;
  restartingTick = true;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WORD_TICK_SCRIPT],
    { timeout: 15000, windowsHide: true },
    (err) => {
      restartingTick = false;
      console.log(`[word] Word had stopped asking for work: tick ${err ? `not restarted (${String(err.message).split('\n')[0]})` : 'restarted'}`);
    },
  );
}

/**
 * A ribbon action (Yaqatw for Word): shown here (the window, the code picker), or carried out by
 * yaqatw in the document's window (its host page answers, host.js `actions`).
 */
function wordAction(s, action, args) {
  if (action === 'showWindow') {
    openWordWindow(s, true);
    return null;
  }
  if (action === 'openPicker') {
    openPicker(s, ['new', 'insert'].includes(args.mode) ? args.mode : 'find', args.source);
    return null;
  }
  return hostAction(s.id, action, args);
}

/** Asks the host page of a session's window to carry out an action; resolves with its answer. */
async function hostAction(sessionId, action, args) {
  const win = wordWindows.get(sessionId);
  if (!win || win.isDestroyed()) throw new Error('This document has no Yaqatw window.');
  // A window just opened (hidden, for this very action) is still loading: a message sent now
  // would be lost. Its page says when it listens.
  await Promise.race([
    hostPageReady(win),
    new Promise((_, reject) => setTimeout(() => reject(new Error('The Yaqatw window did not load.')), 30000)),
  ]);
  if (win.isDestroyed()) throw new Error('The Yaqatw window was closed.');
  const id = nextWordAction++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wordActions.delete(id);
      reject(new Error('Yaqatw did not answer in time.'));
    }, WORD_LONG_ACTIONS.has(action) ? WORD_LONG_ACTION_MS : WORD_ACTION_MS);
    wordActions.set(id, { resolve, reject, timer, contentsId: win.webContents.id });
    win.webContents.send('word:action', id, action, args);
  });
}

/** Resolves once the window's host page listens for actions (word:host-ready). */
const hostPagesReady = new WeakMap();
function hostPageReady(win) {
  let entry = hostPagesReady.get(win);
  if (!entry) {
    entry = {};
    entry.promise = new Promise((resolve) => (entry.resolve = resolve));
    hostPagesReady.set(win, entry);
  }
  return entry.promise;
}

ipcMain.on('word:host-ready', (event) => {
  if (!isWordHostPage(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  hostPageReady(win);
  hostPagesReady.get(win).resolve();
});

ipcMain.on('word:action-result', (event, id, ok, value) => {
  const pending = wordActions.get(id);
  // Only the page it was asked of answers it.
  if (!pending || pending.contentsId !== event.sender.id || !isWordHostPage(event)) return;
  wordActions.delete(id);
  clearTimeout(pending.timer);
  if (ok) pending.resolve(value);
  else pending.reject(new Error(String(value)));
});

function serveWordHost(ses) {
  ses.protocol.handle(WORD_SCHEME, (request) => {
    const url = new URL(request.url);
    const name = url.pathname.replace(/^\//, '') || 'index.html';
    if (url.host !== 'bridge' || !Object.hasOwn(WORD_HOST_FILES, name)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(WORD_HOST_DIR, name)), {
      headers: { 'content-type': `${WORD_HOST_FILES[name]}; charset=utf-8`, 'cache-control': 'no-store' },
    });
  });
}

/**
 * The Word window of a session: shown, or (`show` false, for the ribbon's actions) loaded hidden,
 * yaqatw running in it all the same, until it is asked to show.
 */
function openWordWindow(s, show = true) {
  const known = wordWindows.get(s.id);
  if (known && !known.isDestroyed()) {
    if (!show) return;
    if (known.isMinimized()) known.restore();
    known.show();
    known.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: `Yaqatw 窶・${s.title}`,
    autoHideMenuBar: true,
    show,
    webPreferences: {
      session: appSession,
      preload: path.join(WORD_HOST_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInSubFrames: false,
      // A hidden window keeps yaqatw working at full speed for the ribbon.
      backgroundThrottling: false,
    },
  });
  const contentsId = win.webContents.id;
  wordWindows.set(s.id, win);
  wordSessionByContents.set(contentsId, s.id);
  // The host page stays put; yaqatw navigates inside its frame.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('page-title-updated', (event) => event.preventDefault());
  // CLEW_WORD_DEBUG=1: the window's console (yaqatw's included) in the app's log.
  if (process.env.CLEW_WORD_DEBUG === '1') {
    win.webContents.on('console-message', (event) => {
      console.log(`[word ${s.id.slice(0, 6)}] ${event.level ?? ''} ${event.message ?? ''}`);
    });
  }
  win.on('closed', () => {
    wordWindows.delete(s.id);
    wordSessionByContents.delete(contentsId);
    for (const [id, pending] of wordActions) {
      if (pending.contentsId !== contentsId) continue;
      wordActions.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error('The Yaqatw window was closed.'));
    }
    pickerWindows.get(s.id)?.close();
    wordBridge.close(s.id);
  });
  win.loadURL(WORD_HOST_URL);
  if (show) win.focus();
}

const PICKER_TITLES = { new: 'New code', find: 'Apply a code', insert: 'Insert' };
const INSERT_SOURCES = new Set(['all', 'highlights', 'artifacts', 'notes', 'tables', 'figures']);

/**
 * The small window of a session, in front, one per document: the code picker (Find code窶ｦ / New
 * code窶ｦ) or the insert window (a quote, an artifact窶ｦ found and inserted, `source` what it
 * searches first).
 */
function openPicker(s, mode, source) {
  const known = pickerWindows.get(s.id);
  if (known && !known.isDestroyed()) known.destroy();
  const win = new BrowserWindow({
    width: mode === 'insert' ? 560 : 440,
    height: 520,
    minWidth: 320,
    minHeight: 300,
    title: `${PICKER_TITLES[mode]} 窶・${s.title}`,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      session: appSession,
      preload: path.join(WORD_HOST_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contentsId = win.webContents.id;
  pickerWindows.set(s.id, win);
  pickerSessionByContents.set(contentsId, s.id);
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => {
    if (pickerWindows.get(s.id) === win) pickerWindows.delete(s.id);
    pickerSessionByContents.delete(contentsId);
  });
  win.loadURL(
    mode === 'insert'
      ? `${WORD_SCHEME}://bridge/insert.html?source=${INSERT_SOURCES.has(source) ? source : 'all'}`
      : `${WORD_SCHEME}://bridge/picker.html?mode=${mode}`,
  );
  win.focus();
}

/** From the main frame of one of this scheme's pages. */
function fromWordScheme(event, page) {
  if (event.senderFrame !== event.sender.mainFrame) return false;
  const url = String(event.senderFrame?.url || '');
  return url.startsWith(`${WORD_SCHEME}://bridge/${page}`);
}

function isWordHostPage(event) {
  return fromWordScheme(event, 'index.html') && wordSessionByContents.has(event.sender.id);
}

/** The session of a Word window's host page, or null for anyone else. */
function wordSessionOf(event) {
  return isWordHostPage(event) ? wordSessionByContents.get(event.sender.id) : null;
}

/** The session of a code picker or insert window, or null for anyone else. */
function pickerSessionOf(event) {
  if (!fromWordScheme(event, 'picker.html') && !fromWordScheme(event, 'insert.html')) return null;
  return pickerSessionByContents.get(event.sender.id) ?? null;
}

ipcMain.handle('word:info', (event) => {
  const id = wordSessionOf(event) ?? pickerSessionOf(event);
  if (!id) throw new Error('not allowed');
  const s = wordBridge.get(id);
  return { session: id, title: s?.title ?? '', path: s?.path ?? '', open: Boolean(s) };
});

ipcMain.handle('word:call', (event, op, args) => {
  const id = wordSessionOf(event);
  if (!id) throw new Error('not allowed');
  if (typeof op !== 'string' || !/^[A-Za-z]{1,40}$/.test(op)) throw new Error('not allowed');
  return wordBridge.call(id, op, args && typeof args === 'object' && !Array.isArray(args) ? args : {});
});

/** The small windows' few actions: the codes, apply one, a new one; find and insert; the full window. */
const PICKER_ACTIONS = new Set(['codes', 'applyCode', 'newCode', 'searchCites', 'insertCite', 'showWindow']);

ipcMain.handle('word:picker-action', async (event, action, args) => {
  const id = pickerSessionOf(event);
  if (!id || !PICKER_ACTIONS.has(action)) throw new Error('not allowed');
  const s = wordBridge.get(id);
  if (!s) throw new Error('The Word document was closed.');
  return wordAction(s, action, args && typeof args === 'object' && !Array.isArray(args) ? args : {});
});

ipcMain.on('word:picker-close', (event) => {
  const id = pickerSessionOf(event);
  if (id) pickerWindows.get(id)?.close();
});

// ---------------------------------------------------------------------------------------------
// Yaqatw for Word (`src/word-plugin.js`): Windows, never in a smoke run.

function startWordPlugin() {
  if (process.platform !== 'win32' || SMOKE || !api) return;
  wordPlugin = createWordPlugin({
    template: app.isPackaged
      ? path.join(process.resourcesPath, 'word-plugin', 'yaqatw.dotm')
      : path.join(__dirname, '..', 'word-plugin', 'dist', 'yaqatw.dotm'),
    startupDir: process.env.CLEW_WORD_STARTUP_DIR || path.join(app.getPath('appData'), 'Microsoft', 'Word', 'STARTUP'),
    clients: api.clients,
    port: () => api.status().port,
    defaultPort: localApi.DEFAULT_PORT,
  });
  wordPlugin.refresh().then(() => buildMenu());
}

/** Over the window in use (Settings, when asked from there), else Clew's. */
function wordDialog(opts) {
  const parent = BrowserWindow.getFocusedWindow() ?? (mainWindow?.isVisible() ? mainWindow : null);
  const all = { title: app.name, noLink: true, ...opts };
  return parent ? dialog.showMessageBox(parent, all) : dialog.showMessageBox(all);
}

/** What Settings 窶ｺ General shows: the template, and the programs connected to the local API. */
function wordSnapshot() {
  return {
    plugin: wordPlugin?.status() ?? { available: false, installed: false, connected: false },
    clients: api ? api.clients.list() : [],
  };
}

function wordChanged() {
  buildMenu();
  tools?.send('tools:word', wordSnapshot());
}

/** Disconnects a program; the template's own connection goes with Remove instead. */
function forgetLocalClient(id) {
  const client = api?.clients.list().find((c) => c.id === id);
  if (!client || client.kind === 'word-template') throw new Error('not allowed');
  api.clients.remove(id);
  wordChanged();
  return wordSnapshot();
}

async function installWordPlugin() {
  try {
    await wordPlugin.install();
    await wordDialog({
      type: 'info',
      message: 'Yaqatw for Word is installed.',
      detail: 'Word shows the Yaqatw tab the next time it starts. If Word is open, close it and open it again.',
    });
  } catch (err) {
    await wordDialog({ type: 'warning', message: 'Yaqatw for Word could not be installed.', detail: err.message });
  }
  wordChanged();
  return wordSnapshot();
}

async function removeWordPlugin() {
  const { response } = await wordDialog({
    type: 'question',
    message: 'Remove Yaqatw for Word?',
    detail: 'Word will no longer show the Yaqatw tab. Your documents and their marks stay as they are.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return wordSnapshot();
  try {
    await wordPlugin.remove();
  } catch (err) {
    await wordDialog({ type: 'warning', message: 'Yaqatw for Word could not be removed.', detail: err.message });
  }
  wordChanged();
  return wordSnapshot();
}

/** File 窶ｺ Install / Remove Yaqatw for Word, when this build carries the template. */
function wordPluginItems() {
  const s = wordPlugin?.status();
  if (!s?.available && !s?.installed) return [];
  return [
    s.installed
      ? { label: 'Remove Yaqatw for Word窶ｦ', click: () => removeWordPlugin() }
      : { label: 'Install Yaqatw for Word窶ｦ', click: () => installWordPlugin() },
    { type: 'separator' },
  ];
}

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

const REPO_URL = 'https://github.com/yaqalab/clew-desktop';

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const about = { label: `About ${app.name}`, click: () => showAbout() };
  // Where each platform's own apps keep it: the app menu on macOS, File on Windows and Linux.
  const settings = { label: 'Settings窶ｦ', accelerator: 'CmdOrCtrl+,', enabled: Boolean(tools), click: () => tools?.openSettings() };
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              about,
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [
              settings,
              { type: 'separator' },
              ...wordPluginItems(),
              // Windows says "Exit". Closing the window only hides it in the tray.
              { label: process.platform === 'win32' ? 'Exit' : 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
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
        // On a shared computer DevTools would show an open vault's data: off unless allowed.
        ...(devToolsAllowed() ? [{ role: 'toggleDevTools' }] : []),
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
        // Always there: in a run where updates are off, Settings 窶ｺ General says so.
        { label: 'Check for updates窶ｦ', enabled: Boolean(tools), click: () => checkFromMenu() },
        { label: 'Report a problem窶ｦ', click: () => shell.openExternal(`${REPO_URL}/issues`) },
        // The profile: the pages' storage, settings, the tools' files, the logs.
        { label: 'Open the data folder', click: () => shell.openPath(app.getPath('userData')) },
        ...(isMac ? [] : [{ type: 'separator' }, about]),
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
  // Once the user sees Clew: a word about its folder, if a cloud drive syncs it.
  if (!SMOKE) mainWindow.once('show', () => setTimeout(() => warnSyncedFolder().catch(() => {}), 3000));
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
  // Windows shutting down, restarting or signing out: held back while the pages write out what
  // they hold (the quit below), then let go. Windows lists Clew as "preventing shutdown" for those
  // few seconds. `session-end` comes when the system no longer waits: whatever can still be done.
  mainWindow.on('query-session-end', (event) => endingSession(event));
  mainWindow.on('session-end', () => {
    if (!readyToQuit) quitApp();
  });
  mainWindow.loadURL(sites.mainUrl);
  return mainWindow;
}

app.on('web-contents-created', (_event, contents) => {
  // However DevTools were opened, they stay closed unless allowed.
  contents.on('devtools-opened', () => {
    if (!devToolsAllowed()) contents.closeDevTools();
  });
  if (contents.session === appSession) {
    contents.on('will-prevent-unload', (event) => askBeforeUnload(contents, event));
  }
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

/** The system is ending the session: delays it, and quits the way the menu does. */
function endingSession(event) {
  if (readyToQuit) return;
  event.preventDefault();
  quitApp();
}

/**
 * A page that asks before it is left (`beforeunload`): Electron would cancel the close, reload or
 * quit without a word. The user decides instead.
 */
function askBeforeUnload(contents, event) {
  const win = BrowserWindow.fromWebContents(contents);
  const opts = {
    type: 'question',
    title: app.name,
    message: 'Leave this page?',
    detail: 'It says some of your changes may not be saved yet.',
    buttons: ['Leave', 'Stay'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const response = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
  if (response === 0) {
    event.preventDefault();
    return;
  }
  // Staying cancels a quit under way (nothing was stopped yet): the next Exit starts over.
  unloadRefused?.();
}

app.on('second-instance', () => showMainWindow());

// Before the app goes, however it was asked to (the menu, the tray, Restart to update, the
// system): the pages write out what they still hold 窶・an edit inside its save delay was lost
// otherwise. Then the windows close; a page may still refuse (`askBeforeUnload`), which cancels
// the quit with everything still running. Only once they are all gone do the Word sessions, the
// local API, the databases and the audio server stop.
let readyToQuit = false;
let leaving = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (readyToQuit) return;
  event.preventDefault();
  if (leaving) return;
  leaving = true;
  leaveApp(() => app.quit());
});

/** Settles the pages, closes the windows, stops the services, then `done`; or gives up on Stay. */
function leaveApp(done) {
  settle(appContents())
    .then(() => closeWindows())
    .then((closed) => {
      if (!closed) {
        leaving = false;
        quitting = false;
        return;
      }
      return stopServices().finally(() => {
        readyToQuit = true;
        done();
      });
    });
}

/** Called when the user keeps a page that refused to unload, during `closeWindows`. */
let unloadRefused = null;

/** Closes every window; false when a page was kept (`askBeforeUnload`, Stay). */
function closeWindows() {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (!wins.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = wins.length;
    let over = false;
    const finish = (closed) => {
      if (over) return;
      over = true;
      unloadRefused = null;
      clearTimeout(timer);
      resolve(closed);
    };
    // A page that hangs in its beforeunload: the rest of the quit goes on without it.
    const timer = setTimeout(() => finish(true), 15000);
    unloadRefused = () => finish(false);
    for (const w of wins) {
      w.once('closed', () => {
        if (--left === 0) finish(true);
      });
      w.close();
    }
  });
}

function stopServices() {
  return Promise.resolve()
    .then(() => wordBridge.closeAll())
    .then(() => api?.close())
    .then(() => db?.stop())
    .then(() => (tools ? tools.stop() : undefined))
    .catch(() => undefined);
}

app.whenReady().then(async () => {
  appSettings = createAppSettings(path.join(app.getPath('userData'), 'desktop-settings.json'));
  appSession = session.fromPartition(PARTITION);
  serveWordHost(appSession);
  if (SITE_UPDATES) activateSiteUpdates();
  const server = await network.install(appSession, sites);
  permissions.install(appSession, sites);
  screenPicker.install(appSession, sites, () => BrowserWindow.getFocusedWindow() ?? mainWindow);
  // Documents/Clew, for Clew's copy of each vault (`folder.js`), or where Settings moved it; a
  // throwaway one in a smoke run.
  folder = require('./folder-ipc').install({ origin: sites.main.origin, root: folderRoot() });
  // <profile>/db, one folder per site; a throwaway one in a smoke run.
  if (DB) {
    db = databases.install({
      root: SMOKE ? path.join(require('node:os').tmpdir(), `clew-smoke-db-${process.pid}`) : path.join(app.getPath('userData'), 'db'),
      origins: sites.origins,
    });
  }
  await startLocalApi();
  startWordPlugin();
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
      word: {
        snapshot: wordSnapshot,
        install: () => (wordPlugin ? installWordPlugin() : wordSnapshot()),
        remove: () => (wordPlugin ? removeWordPlugin() : wordSnapshot()),
        forgetClient: forgetLocalClient,
      },
      appPrefs: {
        snapshot: () => appSnapshot(),
        setDevTools,
      },
      folder: {
        snapshot: folderSnapshot,
        move: moveClewFolder,
        open: () => {
          fs.mkdirSync(folder.root, { recursive: true });
          return shell.openPath(folder.root);
        },
      },
    });
    tools.start();
  }
  buildMenu();
  startUpdates();
  // macOS and Linux shutting down (Windows: the main window's query-session-end).
  if (process.platform !== 'win32') powerMonitor.on('shutdown', (event) => endingSession(event));
  const win = createMainWindow();
  win.hiddenAtStart = HIDDEN;
  if (SMOKE) {
    require('./smoke')
      .run(win, appSession, server, tools, folder, db, api)
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
