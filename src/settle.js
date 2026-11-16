'use strict';
/**
 * Waiting for a page to write out what it still holds, before the app quits, restarts or
 * reloads it.
 *
 * Clew's editors keep an edit for a moment before they write it, and the write is an encrypted
 * put that takes a moment more. Quitting used to end the page in the middle of that: the last
 * words typed were lost. So the main process asks first — `alefa:settle` with an id — and the
 * preload answers `alefa:settled` with the same id once every handler the page registered through
 * `window.alefaDesktop.onBeforeQuit` has finished (`preload.js`). A page that registered nothing
 * answers at once; one that does not answer in time (crashed, not loaded, an older preload) is
 * not waited for beyond `timeoutMs`.
 *
 * Plain Node: `ipcMain` and the web contents are handed in, so it runs under `node --test`.
 */

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @param {{ on(channel: string, fn: (event: unknown, id: number) => void): unknown }} ipcMain
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {(contents: Array<{ send(channel: string, id: number): void, isDestroyed?(): boolean, isLoadingMainFrame?(): boolean, isCrashed?(): boolean }>) => Promise<void>}
 */
function createSettler(ipcMain, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let next = 1;
  /** id → the function that ends the wait for it */
  const waiting = new Map();
  ipcMain.on('alefa:settled', (_event, id) => {
    waiting.get(id)?.();
  });

  function settleOne(contents) {
    return new Promise((resolve) => {
      // Nothing to ask: gone, crashed, or still loading (its page has nothing typed in it yet).
      if (!contents || contents.isDestroyed?.() || contents.isCrashed?.() || contents.isLoadingMainFrame?.()) {
        resolve();
        return;
      }
      const id = next++;
      const done = () => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiting.set(id, done);
      try {
        contents.send('alefa:settle', id);
      } catch {
        done();
      }
    });
  }

  /** Resolves once every page has answered, or its time is up. Never rejects. */
  return function settle(contents) {
    return Promise.all((contents || []).map(settleOne)).then(() => undefined);
  };
}

module.exports = { createSettler, DEFAULT_TIMEOUT_MS };
