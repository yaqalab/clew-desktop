'use strict';
/**
 * Updates of the app itself (the window, the tray, the local tools): `electron-updater`, from
 * this repository's GitHub releases (`build.publish` in package.json, which electron-builder
 * writes into the installed app as `resources/app-update.yml`).
 *
 * - A newer release is downloaded in the background (only the changed blocks when the old
 *   installer's `.blockmap` is there), checked against the SHA-512 in `latest.yml`, and kept
 *   until it is installed.
 * - **Restart to update** (tray, Help menu, Settings) lets the pages write out what they hold
 *   first, then runs the installer silently and starts the new version. Quitting instead installs
 *   it on the way out, without starting the app again.
 * - The installed app only; a development or smoke run never checks. `CLEW_APP_UPDATES=0` turns
 *   it off; `CLEW_APP_UPDATES_URL=<url>` reads `<url>/latest.yml` instead of GitHub (testing).
 *
 * The site updates (`site-updates.js`) are separate: Clew and yaqatw change far more often.
 */

/**
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {() => void} opts.onChange  the state changed (menu, tray, Settings)
 * @param {object} [opts.updater]  `autoUpdater` from electron-updater (injectable for tests)
 */
function createAppUpdater({ enabled, onChange, updater }) {
  const state = {
    enabled,
    status: 'idle', // idle | checking | downloading | ready | up-to-date | error
    version: null, // the version found
    percent: null,
    error: null,
    checkedAt: null,
  };
  let checking = null;
  let au = null;

  function set(patch) {
    Object.assign(state, patch);
    onChange();
  }

  function updaterOnce() {
    if (au) return au;
    au = updater ?? require('electron-updater').autoUpdater;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.allowPrerelease = false;
    au.disableWebInstaller = true;
    au.logger = {
      info: (m) => console.log(`[app-update] ${m}`),
      warn: (m) => console.warn(`[app-update] ${m}`),
      error: (m) => console.warn(`[app-update] ${m}`),
      debug: () => {},
    };
    if (process.env.CLEW_APP_UPDATES_URL) {
      au.setFeedURL({ provider: 'generic', url: process.env.CLEW_APP_UPDATES_URL });
    }
    au.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0, error: null }));
    au.on('update-not-available', () => {
      if (state.status !== 'ready') set({ status: 'up-to-date', error: null });
    });
    let lastPercent = -1;
    au.on('download-progress', (p) => {
      const percent = Math.floor(p.percent);
      if (percent === lastPercent) return;
      lastPercent = percent;
      set({ percent });
    });
    au.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100, error: null }));
    au.on('error', (err) => {
      if (state.status !== 'ready') set({ status: 'error', error: shortError(err) });
    });
    return au;
  }

  /** Checks for a newer release, and downloads it; a check asked for while one runs joins it. */
  function check() {
    if (!enabled || state.status === 'ready') return Promise.resolve(snapshot());
    if (!checking) {
      set({ status: 'checking', error: null });
      checking = updaterOnce()
        .checkForUpdates()
        .then((result) => (result?.downloadPromise ? result.downloadPromise : null))
        .catch((err) => {
          if (state.status !== 'ready') set({ status: 'error', error: shortError(err) });
        })
        .finally(() => {
          checking = null;
          set({ checkedAt: new Date().toISOString() });
        });
    }
    return checking.then(snapshot);
  }

  /** Runs the downloaded installer silently and starts the new version. Call once pages are settled. */
  function install() {
    if (state.status !== 'ready') return false;
    updaterOnce().quitAndInstall(true, true);
    return true;
  }

  function snapshot() {
    return { ...state };
  }

  /** A downloaded release is not installed on the way out (the app's data is being removed). */
  function skipInstallOnQuit() {
    if (au) au.autoInstallOnAppQuit = false;
  }

  return { check, install, snapshot, skipInstallOnQuit, ready: () => state.status === 'ready' };
}

/** The first line of an updater error, without the HTTP dump it carries. */
function shortError(err) {
  const text = String(err?.message ?? err);
  if (/\b404\b/.test(text)) return 'no release found';
  return text.split('\n')[0].slice(0, 200);
}

module.exports = { createAppUpdater, shortError };
