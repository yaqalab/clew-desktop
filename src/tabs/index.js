'use strict';
/**
 * Tabs in the main window (Windows for now): each tab is a whole Clew page in a view of its own,
 * so a manuscript and a transcript can be seen side by side in time, one click apart.
 *
 * - The window's own page is the tab strip (`strip.html`), in a session of its own with nothing
 *   in it; each Clew page is a `WebContentsView` laid over it, in the app's session. With one tab
 *   the strip is out of sight and Clew fills the window, as before.
 * - The tabs are stacked and the active one is raised. Chromium then counts the others hidden,
 *   as a browser's background tabs are, and the active one visible. That needs the process
 *   switch below (`disableNativeOcclusion`): without it Windows' occlusion tracking left the
 *   active tab "hidden" in about one switch out of two, and a hidden Clew page ends its session.
 * - Clew asks for a tab (`tabs:open`): Shift with a click, or a project another tab shows. A
 *   project is shown in one tab only; going to it brings that tab to the front. Clew keeps the
 *   rest of the rules (one vault in every tab, Lock locks them all): `docs/47` in Clew.
 * - Closing the window first closes every tab the way a page closes (its `beforeunload` asked),
 *   because a view's page is otherwise destroyed with its window without being asked.
 */
const path = require('node:path');
const { app, ipcMain, nativeTheme, session, WebContentsView } = require('electron');
const { isRoute, labelFor, projectOf } = require('./routes');

const STRIP_HEIGHT = 34;
const STRIP_PARTITION = 'clew-tabs';

/** Off on other systems for now, or with `CLEW_TABS=0`; `CLEW_TABS=1` turns it on anywhere. */
function tabsWanted() {
  if (process.env.CLEW_TABS === '0') return false;
  if (process.env.CLEW_TABS === '1') return true;
  return process.platform === 'win32';
}

/** Before the app is ready: the stacked views report visible and hidden as browser tabs do. */
function disableNativeOcclusion() {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

const labelOf = (tab) => labelFor(tab.title, tab.url, app.name);

/**
 * @param {object} opts
 * @param {import('electron').BrowserWindow} opts.win the main window, made with `stripPreferences()`
 * @param {() => object} opts.webPreferences what every Clew page gets
 * @param {string} opts.mainUrl Clew's address
 * @param {(contents: import('electron').WebContents) => void} [opts.onTabCreated]
 */
function createTabs({ win, webPreferences, mainUrl, onTabCreated }) {
  /** @type {{ id: number, view: WebContentsView, url: string, title: string }[]} */
  const tabs = [];
  let active = null;
  let seq = 0;
  let creating = false;
  let closingAll = null;
  const strip = win.webContents;

  const alive = (tab) => !tab.view.webContents.isDestroyed();
  const byContents = (contents) => tabs.find((t) => t.view.webContents === contents) ?? null;

  function layout() {
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const top = tabs.length > 1 ? STRIP_HEIGHT : 0;
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  function pushState() {
    if (win.isDestroyed()) return;
    if (active) win.setTitle(active.title || app.name);
    if (strip.isDestroyed()) return;
    strip.send('tabs:state', {
      tabs: tabs.map((t) => ({ id: t.id, label: labelOf(t), active: t === active })),
      closable: tabs.length > 1,
    });
  }

  function activate(tab, { focus = true } = {}) {
    if (!tab || !alive(tab) || win.isDestroyed()) return;
    active = tab;
    // Raised: the last child is drawn on top. The others count as hidden, as background tabs.
    win.contentView.addChildView(tab.view);
    layout();
    if (focus) tab.view.webContents.focus();
    pushState();
  }

  function remove(tab) {
    const at = tabs.indexOf(tab);
    if (at < 0) return;
    tabs.splice(at, 1);
    if (!win.isDestroyed()) win.contentView.removeChildView(tab.view);
    if (active === tab) active = null;
    if (!active && tabs.length) activate(tabs[Math.min(at, tabs.length - 1)]);
    else layout();
    pushState();
  }

  function add(url, { activate: show = true } = {}) {
    creating = true;
    let view;
    try {
      view = new WebContentsView({ webPreferences: webPreferences() });
    } finally {
      creating = false;
    }
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff');
    const tab = { id: ++seq, view, url, title: '' };
    tabs.push(tab);
    const contents = view.webContents;
    contents.on('page-title-updated', (_event, title) => {
      tab.title = title;
      pushState();
    });
    contents.on('did-navigate', (_event, next) => {
      tab.url = next;
      pushState();
    });
    contents.on('did-navigate-in-page', (_event, next, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = next;
      pushState();
    });
    contents.on('destroyed', () => remove(tab));
    // Ctrl+Tab and Ctrl+Shift+Tab, Ctrl+PageDown and Ctrl+PageUp, as in a browser.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
      const step = input.key === 'Tab' ? (input.shift ? -1 : 1) : input.key === 'PageDown' ? 1 : input.key === 'PageUp' ? -1 : 0;
      if (!step || tabs.length < 2) return;
      event.preventDefault();
      cycle(step);
    });
    onTabCreated?.(contents);
    win.contentView.addChildView(view);
    if (show) activate(tab);
    else if (active) activate(active, { focus: false });
    layout();
    contents.loadURL(url).catch(() => {});
    pushState();
    return tab;
  }

  function cycle(step) {
    if (tabs.length < 2) return;
    const at = Math.max(0, tabs.indexOf(active));
    activate(tabs[(at + step + tabs.length) % tabs.length]);
  }

  /**
   * Closes one tab the way a page closes: what it holds is written out first (`settle`), and a
   * page that asks before it is left asks. Resolves false when it stays (the person chose Stay).
   */
  function closeTab(tab, settle) {
    if (!tab || !alive(tab)) return Promise.resolve(true);
    const contents = tab.view.webContents;
    return Promise.resolve(settle ? settle([contents]) : undefined).then(
      () =>
        new Promise((resolve) => {
          if (contents.isDestroyed()) return resolve(true);
          const onDestroyed = () => {
            contents.off('will-prevent-unload', onRefused);
            resolve(true);
          };
          // Heard after the app's own handler, which asks the person: still prevented means Stay.
          const onRefused = (event) => {
            setImmediate(() => {
              if (contents.isDestroyed()) return;
              if (!event.defaultPrevented) {
                contents.off('destroyed', onDestroyed);
                contents.off('will-prevent-unload', onRefused);
                resolve(false);
              }
            });
          };
          contents.once('destroyed', onDestroyed);
          contents.on('will-prevent-unload', onRefused);
          contents.close({ waitForBeforeUnload: true });
        }),
    );
  }

  /** Closes every tab but the first (`keepFirst`) or all of them; false when one stayed. */
  async function closeTabs({ keepFirst = false, settle } = {}) {
    const going = keepFirst ? tabs.slice(1) : tabs.slice();
    let all = true;
    for (const tab of going) {
      if (!(await closeTab(tab, settle))) all = false;
    }
    return all;
  }

  // --- From the strip ------------------------------------------------------------------------

  const fromStrip = (event) => event.sender === strip;
  const onActivate = (event, id) => {
    if (!fromStrip(event)) return;
    activate(tabs.find((t) => t.id === id));
  };
  const onClose = (event, id) => {
    if (!fromStrip(event) || tabs.length < 2) return;
    void closeTab(tabs.find((t) => t.id === id), api.settle);
  };
  const onReady = (event) => {
    if (fromStrip(event)) pushState();
  };
  ipcMain.on('tabs:activate', onActivate);
  ipcMain.on('tabs:close', onClose);
  ipcMain.on('tabs:ready', onReady);

  // The strip is a fixed local page: it goes nowhere and opens nothing.
  strip.on('will-navigate', (event) => event.preventDefault());
  strip.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The window's title is the active tab's, not the strip's.
  win.on('page-title-updated', (event) => event.preventDefault());
  for (const name of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    win.on(name, layout);
  }
  win.on('focus', () => {
    if (active && alive(active)) active.view.webContents.focus();
  });

  // Closing the window: the tabs go first, each asked as a page is. Not when the window only
  // hides (the tray): another handler has prevented the close already.
  win.on('close', (event) => {
    if (event.defaultPrevented || tabs.length === 0) return;
    event.preventDefault();
    if (closingAll) return;
    closingAll = closeTabs({ settle: api.settle }).then((all) => {
      closingAll = null;
      if (all && !win.isDestroyed()) win.close();
    });
  });
  win.on('closed', () => {
    ipcMain.off('tabs:activate', onActivate);
    ipcMain.off('tabs:close', onClose);
    ipcMain.off('tabs:ready', onReady);
    for (const tab of tabs.slice()) if (alive(tab)) tab.view.webContents.close();
  });

  const api = {
    /** Set by the app: writes out what pages hold before they close (`settle.js`). */
    settle: null,

    /** Loads the strip and opens Clew in the first tab. */
    start() {
      strip.loadFile(path.join(__dirname, 'strip.html')).catch(() => {});
      add(mainUrl);
    },

    /** The first tab's page: the one the app treats as "Clew" (shown, reloaded, wiped). */
    main: () => tabs.find(alive)?.view.webContents ?? null,
    /** The tab in front. */
    active: () => (active && alive(active) ? active.view.webContents : null),
    /** Every tab's page. */
    contents: () => tabs.filter(alive).map((t) => t.view.webContents),
    /** Whether `contents` is a tab's page, or the one being made now. */
    owns: (contents) => creating || Boolean(byContents(contents)),

    /**
     * Clew asks to go to `hash`: to the tab already showing that project (brought to the front
     * and taken there), else a new tab when `newTab`, else nowhere (`"here"`).
     */
    open(sender, hash, newTab) {
      if (!isRoute(hash)) return 'here';
      const project = projectOf(new URL(hash, mainUrl).toString());
      if (project) {
        const showing = tabs.find((t) => alive(t) && projectOf(t.url) === project);
        if (showing) {
          if (showing.view.webContents === sender) return 'here';
          activate(showing);
          if (new URL(showing.url).hash !== hash) {
            showing.view.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
          }
          return 'shown';
        }
      }
      if (!newTab) return 'here';
      add(new URL(hash, mainUrl).toString());
      return 'opened';
    },

    /** Closes every tab but the first; false when one stayed. */
    closeExtra: () => closeTabs({ keepFirst: true, settle: api.settle }),
  };
  return api;
}

/** The main window's own webPreferences when it holds tabs: the strip's, in a session of its own. */
function stripPreferences() {
  return {
    session: session.fromPartition(STRIP_PARTITION),
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
}

/** Clew's `alefaDesktop.tabs.open` (the page's preload) arrives here. */
function installIpc(getTabs) {
  ipcMain.handle('tabs:open', (event, hash, opts) => {
    const tabs = getTabs();
    if (!tabs) return 'here';
    return tabs.open(event.sender, hash, Boolean(opts?.newTab));
  });
}

module.exports = { createTabs, disableNativeOcclusion, installIpc, projectOf, stripPreferences, tabsWanted, STRIP_HEIGHT };
