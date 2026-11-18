'use strict';
/**
 * Clew's local tools inside the desktop app: the audio server (audio folders for Clew), and
 * dictation and analysis beside it. One tray icon, one settings window, one installer.
 *
 * The audio server runs hidden (`clew-audio-server --control`, src/tools/engine.js) with the
 * same settings file as the standalone tools (`clew-audio-server/settings.json` in the user's
 * config folder), so folders, the secret Clew already knows and the keys carry over. Clew in the
 * window talks to it at http://127.0.0.1:47821 exactly as the website does.
 */
const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} = require('electron');
const { ToolsEngine } = require('./engine');
const dictation = require('./dictation-install');

const EXE = process.platform === 'win32' ? 'clew-audio-server.exe' : 'clew-audio-server';
const LOG_LINES = 300;

function toolsDir() {
  if (process.env.CLEW_TOOLS_DIR) return path.resolve(process.env.CLEW_TOOLS_DIR);
  if (app.isPackaged) return path.join(process.resourcesPath, 'tools');
  return path.join(__dirname, '..', '..', 'tools-dist');
}

function toolsInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(toolsDir(), 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Linux has no login-item API in Electron: an XDG autostart entry does the same.
const linuxAutostart = () => path.join(app.getPath('appData'), 'autostart', 'clew-desktop.desktop');

function loginItem() {
  if (process.platform === 'linux') return fs.existsSync(linuxAutostart());
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function setLoginItem(on) {
  if (process.platform === 'linux') {
    const file = linuxAutostart();
    if (!on) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(
        file,
        `[Desktop Entry]\nType=Application\nName=Clew\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`,
      );
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}

class Tools {
  /**
   * @param {object} opts
   * @param {() => void} opts.openApp   shows Clew's window
   * @param {() => void} opts.quitApp   quits everything
   * @param {boolean} [opts.firstRunLoginItem]  on the first run, start at login (the installed
   *        app only: a development or test run must never register itself with the system)
   * @param {() => object[]} [opts.appItems]  menu items of the app's own (e.g. "Restart to
   *        update"), shown in the tray above Quit
   * @param {{ snapshot: () => object, check: () => Promise<object>, restart: () => void }} [opts.updates]
   *        the site updates (src/site-updates.js) that Settings › General shows and checks
   * @param {{ snapshot: () => object, install: () => Promise<object>, remove: () => Promise<object>,
   *          forgetClient: (id: string) => object }} [opts.word]  Yaqatw for Word and the programs
   *        connected to the local API, that Settings › General shows (main.js)
   * @param {{ snapshot: () => object, setDevTools: (on: boolean) => object }} [opts.appPrefs]  the
   *        app's own preferences that Settings › General shows (main.js, `app-settings.js`)
   * @param {{ snapshot: () => object, move: () => Promise<object>, open: () => Promise<string> }} [opts.folder]
   *        Clew's folder: where it is, moving it (main.js, `folder-location.js`)
   * @param {{ plan: () => Promise<object>, run: (opts: object) => Promise<object> }} [opts.wipe]
   *        Remove all Clew data from this computer, with a backup first if asked (main.js, `wipe.js`)
   * @param {() => BrowserWindow | null} [opts.parentWindow]  the window Settings opens as a modal
   *        over, when there is one on screen (from the tray with Clew hidden, it opens on its own)
   */
  constructor({
    openApp,
    quitApp,
    firstRunLoginItem = false,
    appItems = () => [],
    updates = null,
    word = null,
    appPrefs = null,
    folder = null,
    wipe = null,
    parentWindow = () => null,
  }) {
    this.wipe = wipe;
    this.openApp = openApp;
    this.appPrefs = appPrefs;
    this.folder = folder;
    this.parentWindow = parentWindow;
    this.quitApp = quitApp;
    this.appItems = appItems;
    this.updates = updates;
    this.word = word;
    this.firstRunLoginItem = firstRunLoginItem;
    this.tray = null;
    this.settingsWin = null;
    this.logLines = [];
    this.dictationDir = path.join(app.getPath('userData'), 'dictation');
    this.installing = null;
    /** A newer dictation the latest release offers, or null (`checkDictationUpdate`). */
    this.dictationUpdate = null;
    this.prefsFile = path.join(app.getPath('userData'), 'tools.json');
  }

  log(line) {
    this.logLines.push(`${new Date().toLocaleTimeString()}  ${line}`);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
    this.send('tools:log', line);
  }

  prefs() {
    try {
      return JSON.parse(fs.readFileSync(this.prefsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  savePrefs(p) {
    fs.mkdirSync(path.dirname(this.prefsFile), { recursive: true });
    fs.writeFileSync(this.prefsFile, `${JSON.stringify(p, null, 2)}\n`);
  }

  sttProgram() {
    return process.env.CLEW_STT_PROGRAM || dictation.installed(this.dictationDir)?.program || '';
  }

  start() {
    // A first run starts with the system, as the standalone tools' installer does; the tray
    // menu and the settings window turn it off.
    const prefs = this.prefs();
    if (this.firstRunLoginItem && !prefs.firstRunDone) {
      try {
        setLoginItem(true);
      } catch (err) {
        this.log(`could not register the start at login: ${err.message}`);
      }
      this.savePrefs({ ...prefs, firstRunDone: true });
    }

    const args = [];
    const stt = this.sttProgram();
    if (stt) args.push('--stt-program', stt);
    if (process.env.CLEW_TOOLS_CONFIG) args.push('--config', process.env.CLEW_TOOLS_CONFIG);
    this.engine = new ToolsEngine({ exe: path.join(toolsDir(), EXE), args, log: (l) => this.log(l) });
    const changed = () => {
      this.updateTray();
      this.send('tools:status', this.snapshot());
    };
    this.engine.on('status', changed);
    this.engine.on('state', changed);
    this.engine.on('hello', (h) => this.log(`audio server ${h.version} started (settings: ${h.settingsFile})`));
    this.engine.start();
    this.createTray();
    this.registerIpc();
    nativeTheme.on('updated', () => this.tray?.setImage(this.icon()));
  }

  stop() {
    return this.engine ? this.engine.stop() : Promise.resolve();
  }

  snapshot() {
    return {
      state: this.engine?.state ?? 'stopped',
      problem: this.engine?.problem ?? '',
      status: this.engine?.status ?? null,
      version: this.engine?.info?.version ?? toolsInfo()?.version ?? '',
      settingsFile: this.engine?.info?.settingsFile ?? '',
      dictationProgram: this.sttProgram(),
      dictationUpdate: this.dictationUpdate ?? null,
      installing: this.installing,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Tray

  icon() {
    const dark = nativeTheme.shouldUseDarkColors;
    if (process.platform === 'win32') {
      return nativeImage.createFromPath(path.join(__dirname, 'assets', dark ? 'tray-dark.ico' : 'tray.ico'));
    }
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    return img.resize({ width: process.platform === 'darwin' ? 18 : 22 });
  }

  createTray() {
    this.tray = new Tray(this.icon());
    this.tray.on('click', () => this.openApp());
    this.updateTray();
  }

  tooltip() {
    const s = this.engine?.status;
    if (this.engine?.state !== 'running' || !s) {
      return `Clew — audio server ${this.engine?.state ?? 'stopped'}${this.engine?.problem ? `: ${this.engine.problem}` : ''}`;
    }
    const parts = [];
    parts.push(s.server.running ? `audio server on ${s.server.port}` : `audio server stopped${s.server.problem ? ` (${s.server.problem})` : ''}`);
    if (s.server.converting) parts.push(`converting ${s.server.converting}`);
    if (s.dictation.wanted) parts.push(`dictation ${s.dictation.state}`);
    if (s.analysis.wanted) parts.push(`analysis ${s.analysis.state}`);
    return `Clew — ${parts.join(' · ')}`.slice(0, 127);
  }

  async copy(cmd, field, label) {
    try {
      const r = await this.engine.call(cmd);
      clipboard.writeText(r[field]);
      this.log(`${label} copied`);
    } catch (err) {
      dialog.showErrorBox('Clew', `Could not copy the ${label}: ${err.message}`);
    }
  }

  async setFolderEnabled(index, enabled) {
    const s = await this.engine.call('settings.get');
    s.folders[index].enabled = enabled;
    await this.engine.call('settings.apply', { settings: { folders: s.folders } });
  }

  async updateTray() {
    if (!this.tray) return;
    this.tray.setToolTip(this.tooltip());
    const running = this.engine?.state === 'running';
    const s = this.engine?.status;
    let folders = [];
    if (running) {
      try {
        folders = (await this.engine.call('settings.get')).folders;
      } catch {
        /* the menu goes without */
      }
    }
    const act = (fn) => () => fn().catch((err) => dialog.showErrorBox('Clew', err.message));
    const template = [
      { label: 'Open Clew', click: () => this.openApp() },
      { label: 'Settings…', click: () => this.openSettings() },
      { type: 'separator' },
      { label: 'Copy the secret', enabled: running, click: () => this.copy('secret.get', 'secret', 'secret') },
      {
        label: 'Copy the address',
        enabled: Boolean(s),
        click: () => clipboard.writeText(`http://127.0.0.1:${s.server.port}`),
      },
      {
        label: 'Audio folders',
        enabled: folders.length > 0,
        submenu: folders.length
          ? folders.map((f, i) => ({
              label: path.basename(f.path) || f.path,
              type: 'checkbox',
              checked: f.enabled,
              click: act(() => this.setFolderEnabled(i, !f.enabled)),
            }))
          : [{ label: 'none', enabled: false }],
      },
      {
        label: 'Open the audio folder',
        enabled: Boolean(s?.server.folders.length),
        click: () => shell.openPath(s.server.folders[0]),
      },
      {
        label: s?.server.running ? 'Stop the audio server' : 'Start the audio server',
        enabled: running,
        click: act(() => this.engine.call(s?.server.running ? 'server.stop' : 'server.start')),
      },
      { type: 'separator' },
      {
        label: s?.dictation.wanted ? 'Stop dictation' : 'Start dictation',
        enabled: running && Boolean(this.sttProgram()),
        click: act(() => this.engine.call(s?.dictation.wanted ? 'dictation.stop' : 'dictation.start')),
      },
      { label: 'Copy the dictation key', enabled: running, click: () => this.copy('sttKey.get', 'key', 'dictation key') },
      {
        label: s?.analysis.wanted ? 'Stop analysis' : 'Start analysis',
        enabled: running,
        click: act(() => this.engine.call(s?.analysis.wanted ? 'analysis.stop' : 'analysis.start')),
      },
      {
        label: 'Copy the analysis key',
        enabled: running,
        click: () => this.copy('analysisKey.get', 'key', 'analysis key'),
      },
      { type: 'separator' },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: loginItem(),
        click: (item) => {
          setLoginItem(item.checked);
          this.send('tools:status', this.snapshot());
        },
      },
      ...this.appItems(),
      { label: 'Quit Clew', click: () => this.quitApp() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  // ------------------------------------------------------------------------------------------
  // Settings window

  openSettings(tab) {
    if (this.settingsWin && !this.settingsWin.isDestroyed()) {
      if (tab) this.send('tools:tab', tab);
      this.settingsWin.show();
      this.settingsWin.focus();
      return;
    }
    const parent = this.parentWindow() ?? undefined;
    this.settingsWin = new BrowserWindow({
      parent,
      modal: Boolean(parent),
      minimizable: !parent,
      width: 860,
      height: 680,
      minWidth: 640,
      minHeight: 480,
      title: 'Clew — Settings',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'settings', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const win = this.settingsWin;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (this.settingsWin === win) this.settingsWin = null;
    });
    win.loadFile(path.join(__dirname, 'settings', 'index.html'), tab ? { hash: tab } : undefined);
  }

  send(channel, payload) {
    const win = this.settingsWin;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  registerIpc() {
    const fromSettings = (event) => this.settingsWin && event.sender === this.settingsWin.webContents;
    const handle = (channel, fn) =>
      ipcMain.handle(channel, (event, ...args) => {
        if (!fromSettings(event)) throw new Error('not allowed');
        return fn(...args);
      });

    handle('tools:call', (cmd, args) => {
      if (typeof cmd !== 'string' || cmd === 'quit') throw new Error('not allowed');
      return this.engine.call(cmd, args && typeof args === 'object' ? args : {});
    });
    handle('tools:snapshot', () => this.snapshot());
    handle('tools:log', () => this.logLines);
    handle('tools:copy', (text) => clipboard.writeText(String(text)));
    handle('tools:open-path', (p) => shell.openPath(String(p)));
    handle('tools:pick-folder', async (title) => {
      const r = await dialog.showOpenDialog(this.settingsWin, { title, properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    handle('tools:pick-file', async (title) => {
      const r = await dialog.showOpenDialog(this.settingsWin, { title, properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0];
    });
    handle('tools:updates', () => this.updates?.snapshot() ?? null);
    handle('tools:check-updates', () => this.updates?.check() ?? null);
    handle('tools:restart-to-update', () => this.updates?.restart());
    handle('tools:word', () => this.word?.snapshot() ?? null);
    handle('tools:word-install', () => this.word?.install() ?? null);
    handle('tools:word-remove', () => this.word?.remove() ?? null);
    handle('tools:forget-client', (id) => this.word?.forgetClient(String(id)) ?? null);
    handle('tools:wipe-plan', () => this.wipe?.plan() ?? null);
    handle('tools:wipe-run', (opts) => this.wipe?.run(opts && typeof opts === 'object' ? opts : {}) ?? null);
    handle('tools:folder', () => this.folder?.snapshot() ?? null);
    handle('tools:folder-move', () => this.folder?.move() ?? null);
    handle('tools:folder-open', () => this.folder?.open() ?? null);
    handle('tools:app-prefs', () => this.appPrefs?.snapshot() ?? null);
    handle('tools:set-dev-tools', (on) => this.appPrefs?.setDevTools(Boolean(on)) ?? null);
    handle('tools:login-item', () => loginItem());
    handle('tools:set-login-item', (on) => {
      setLoginItem(Boolean(on));
      this.updateTray();
      return loginItem();
    });
    handle('tools:open-app', () => this.openApp());
    handle('tools:install-dictation', () => this.installDictation());
    handle('tools:check-dictation-update', () => this.checkDictationUpdate());
    handle('tools:uninstall-dictation', async () => {
      await this.engine.call('dictation.stop').catch(() => {});
      dictation.uninstall(this.dictationDir);
      this.send('tools:status', this.snapshot());
    });
  }

  async installDictation() {
    if (this.installing) return;
    this.installing = { phase: 'checking' };
    this.send('tools:status', this.snapshot());
    // An update replaces the program that may be running: stopped first (Windows keeps a running
    // program's folder), started again after if it was on.
    const updating = Boolean(dictation.installed(this.dictationDir));
    const wasOn = updating && Boolean(this.engine?.status?.dictation?.wanted);
    try {
      if (updating) await this.engine.call('dictation.stop').catch(() => {});
      const got = await dictation.install(this.dictationDir, {
        onProgress: (p) => {
          this.installing = p;
          this.send('tools:status', this.snapshot());
        },
      });
      this.log(`dictation ${got.version} installed`);
      this.dictationUpdate = null;
      await this.engine.call('dictation.setProgram', { path: got.program });
      if (wasOn) await this.engine.call('dictation.start').catch(() => {});
    } catch (err) {
      this.log(`dictation could not be installed: ${err.message}`);
      if (wasOn) await this.engine.call('dictation.start').catch(() => {});
      throw err;
    } finally {
      this.installing = null;
      this.send('tools:status', this.snapshot());
      this.updateTray();
    }
  }

  /**
   * Whether the latest clew-tools release has a newer dictation than the one installed (Clew
   * docs/32 §3: clew-tools 1.4 added the words a training cut is placed by). Quiet when it
   * cannot tell; asked when the settings window opens.
   */
  async checkDictationUpdate() {
    this.dictationUpdate = await dictation.updateAvailable(this.dictationDir);
    if (this.dictationUpdate) this.log(`dictation ${this.dictationUpdate} is available`);
    this.send('tools:status', this.snapshot());
    return this.dictationUpdate;
  }
}

module.exports = { Tools, toolsDir, toolsInfo, setLoginItem };
