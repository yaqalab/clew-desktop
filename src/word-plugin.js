'use strict';
/**
 * Yaqatw for Word: the Word template built from `word-plugin/`, installed and connected by the
 * app itself. Plain Node: no Electron here. Windows only.
 *
 * - install: copies the template into Word's Startup folder (Word loads it at its next start,
 *   macros on: a trusted location), registers it with the local API as a client of kind
 *   `word-template` and hands it its token through the registry key the template reads
 *   (`HKCU\Software\VB and VBA Program Settings\yaqatw\Clew`, `Token`, plus `Port` when not
 *   the default). Installing is the user's consent: no pairing question.
 * - refresh, at start: an installed template older than the app's own is replaced, and one whose
 *   client is gone is given a new token. While Word holds the installed one (Word is running),
 *   the update waits: status says `waiting`, and the copy is tried again every minute until Word
 *   lets go (`onChange` then says so).
 * - remove: the file, the registry key and the client.
 *
 * Writing the registry goes through `reg.exe`, so the token is on a command line for a moment:
 * visible to the user's own processes only, which can read the registry key anyway.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const KIND = 'word-template';
const NAME = 'Yaqatw for Word';
const FILE = 'yaqatw.dotm';
const REG_ROOT = 'HKCU\\Software\\VB and VBA Program Settings\\yaqatw';
const REG_KEY = `${REG_ROOT}\\Clew`;

class WordPluginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** The registry, through reg.exe. */
const windowsRegistry = {
  set: (name, value) => run(['add', REG_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']),
  unset: (name) => run(['delete', REG_KEY, '/v', name, '/f']).catch(() => undefined),
  removeAll: () => run(['delete', REG_ROOT, '/f']).catch(() => undefined),
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Word holding the file open shows as one of these. */
const busy = (err) => ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code);

/**
 * @param {object} opts
 * @param {string} opts.template   the app's copy of yaqatw.dotm
 * @param {string} opts.startupDir Word's Startup folder
 * @param {object} opts.clients    the local API's clients (`createClients`)
 * @param {() => number} opts.port the local API's port
 * @param {number} opts.defaultPort the port the template uses when told nothing
 * @param {typeof windowsRegistry} [opts.registry]
 * @param {() => void} [opts.onChange] a waiting update was installed
 * @param {number} [opts.retryMs] how often a waiting update is tried again
 */
function createWordPlugin({
  template,
  startupDir,
  clients,
  port,
  defaultPort,
  registry = windowsRegistry,
  log = console,
  onChange = () => {},
  retryMs = 60000,
}) {
  const installed = () => path.join(startupDir, FILE);
  /** An update Word kept out (it holds the installed template), tried again by `retry`. */
  let waiting = false;
  let retry = null;

  function status() {
    return {
      available: fs.existsSync(template),
      installed: fs.existsSync(installed()),
      connected: clients.list().some((c) => c.kind === KIND),
      waiting,
    };
  }

  function stopWaiting() {
    waiting = false;
    clearTimeout(retry);
    retry = null;
  }

  /**
   * The installed template made the same as the app's, if it differs. Word holding it: the
   * update waits, tried again every `retryMs`. True when the copy was made.
   */
  function update() {
    if (!fs.existsSync(template) || !fs.existsSync(installed())) {
      stopWaiting();
      return false;
    }
    if (sha256(template) === sha256(installed())) {
      stopWaiting();
      return false;
    }
    try {
      copy();
    } catch (err) {
      log.warn(`[word-plugin] template not updated: ${err.message}`);
      if (err.code !== 'word-busy') return false;
      waiting = true;
      clearTimeout(retry);
      retry = setTimeout(() => {
        retry = null;
        if (update()) onChange();
      }, retryMs);
      retry.unref?.();
      return false;
    }
    stopWaiting();
    log.log('[word-plugin] template updated');
    return true;
  }

  function copy() {
    fs.mkdirSync(startupDir, { recursive: true });
    try {
      fs.copyFileSync(template, installed());
    } catch (err) {
      if (busy(err)) throw new WordPluginError('word-busy', 'Word is using the template: close Word, then try again.');
      throw err;
    }
  }

  /** Where the template finds the API: nothing for the default port. */
  async function syncPort() {
    if (port() === defaultPort) await registry.unset('Port');
    else await registry.set('Port', String(port()));
  }

  /** A new token for the template; the old one stops working. */
  async function connect() {
    clients.removeKind(KIND);
    const { token } = clients.add(NAME, { kind: KIND });
    await registry.set('Token', token);
    await syncPort();
  }

  return {
    status,
    async install() {
      if (!fs.existsSync(template)) throw new WordPluginError('no-template', 'This build of the app has no Word template.');
      copy();
      stopWaiting();
      await connect();
      return status();
    },
    async remove() {
      stopWaiting();
      try {
        fs.rmSync(installed(), { force: true });
      } catch (err) {
        if (busy(err)) throw new WordPluginError('word-busy', 'Word is using the template: close Word, then try again.');
        throw err;
      }
      clients.removeKind(KIND);
      await registry.removeAll();
      return status();
    },
    /** At start: brings an installed template up to date and connected. Never throws. */
    async refresh() {
      try {
        const s = status();
        // Removed from outside the app (uninstalled, deleted by hand): its connection goes too.
        if (!s.installed) {
          stopWaiting();
          if (clients.list().some((c) => c.kind === KIND)) {
            clients.removeKind(KIND);
            log.log('[word-plugin] template gone: its connection removed');
          }
          return status();
        }
        if (!s.available) return s;
        update();
        if (!s.connected) await connect();
        else await syncPort();
        return status();
      } catch (err) {
        log.warn(`[word-plugin] ${err.message}`);
        return status();
      }
    },
    /** No more tries of a waiting update (the app quits). */
    stop: stopWaiting,
  };
}

module.exports = { createWordPlugin, WordPluginError, KIND, NAME };
