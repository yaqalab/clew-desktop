'use strict';
/**
 * Word sessions: the link between a Clew window working on a Word document and Yaqatw for Word
 * (the template) in that Word. Plain Node: no Electron here.
 *
 * The template opens a session for its document and then keeps asking for work: the app cannot
 * call into Word, so Word calls out. Through the local API, for the template's client only:
 *
 * - `POST /v1/word/open { title, path, session?, show? }` → `{ session }`. With the `session`
 *   of an open one (the same document again), that session is shown again instead. `show: false`
 *   opens it without showing its window (for the ribbon's actions).
 * - `POST /v1/word/action { session, action, args }` → `{ ok, value }` or `{ ok: false, error }`:
 *   something the ribbon asks of yaqatw in that document's window (`onAction`). Its answer can
 *   take operations in Word first: the template carries them out while it waits.
 * - `POST /v1/word/next { session, waitMs?, result? }` → `{ op }`, `{ op: null }` or
 *   `{ closed: true }`. `result` answers the operation handed out before
 *   (`{ id, ok, value }` or `{ id, ok: false, error }`); then the next one comes back at once,
 *   or within `waitMs` (at most 1 s), or `op: null`. One operation at a time:
 *   `{ id, op, args }`.
 * - `POST /v1/word/event { session, event, payload }`: what happened in Word (the selection).
 * - `POST /v1/word/close { session }`: the document is closing.
 *
 * On the app's side `call(session, op, args)` resolves with what Word answered, or fails with
 * a code: `word-busy` (Word did not ask for work for `busyMs`: a dialog is open in Word),
 * `word-timeout` (taken, not answered in `runMs`), `word-error` (Word failed it), `closed`,
 * `no-session`.
 */
const crypto = require('node:crypto');
const { ApiError } = require('./local-api');
const { KIND } = require('./word-plugin');

const MAX_SESSIONS = 20;
const MAX_WAIT_MS = 1000;
const MAX_RESULT = 16 * 1024 * 1024;
// Word picks up work when it is idle; a visible Word, busy with its own background work (layout,
// proofing) or a dialog, can be late by several seconds: give it time before calling it busy.
const BUSY_MS = 30000;
const RUN_MS = 60000;
// Work waiting this long while Word has not asked for any: Word's tick may have stopped (Word
// keeps one OnTime timer, and something can take it); `onStall` can restart it.
const STALL_MS = 4000;
// Restarts tried without Word asking in between, before the bridge stops trying (until it asks).
const MAX_STALLS = 3;

const MESSAGES = {
  'word-busy': 'Word did not answer for 30 seconds: if a dialog is open in Word, close it, then try again.',
  'word-timeout': 'Word did not finish in time.',
  closed: 'The Word document was closed.',
  'no-session': 'This window is no longer connected to a Word document.',
};

function failure(code, detail) {
  const err = new Error(`${code}: ${detail ?? MESSAGES[code] ?? code}`);
  err.code = code;
  return err;
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @param {object} [opts]
 * @param {(s: { id, title, path }, again: boolean) => void} [opts.onOpen]  a session opened
 *        (or asked to be shown again)
 * @param {(s: { id, title, path }, by: 'word' | 'app') => void} [opts.onClose]
 * @param {(id: string, event: string, payload: unknown) => void} [opts.onEvent]
 * @param {(s: { id, title, path }, action: string, args: object) => Promise<unknown>} [opts.onAction]
 *        carries out a ribbon action; what it resolves with goes back to Word
 * @param {(s: { id, title, path }) => void} [opts.onStall] work has waited `stallMs` and Word
 *        has not asked for any meanwhile (again, at growing intervals, until Word asks or the
 *        work fails as busy)
 */
function createWordBridge({
  onOpen = () => {},
  onClose = () => {},
  onEvent = () => {},
  onAction = async () => {
    throw new Error('No actions here.');
  },
  onStall = () => {},
  busyMs = BUSY_MS,
  runMs = RUN_MS,
  stallMs = STALL_MS,
} = {}) {
  const sessions = new Map();
  let nextOp = 1;

  const pub = (s) => ({ id: s.id, title: s.title, path: s.path });

  function settle(s, id, fn) {
    const p = s.pending.get(id);
    if (!p) return;
    s.pending.delete(id);
    fn(p);
  }

  /** Hands the next operation to a waiting `next`, if Word is free. */
  function deliver(s) {
    if (!s.waiter || s.running || !s.queue.length) return;
    const item = s.queue.shift();
    s.running = {
      id: item.id,
      timer: setTimeout(() => {
        s.running = null;
        settle(s, item.id, (p) => p.reject(failure('word-timeout')));
        watch(s);
      }, runMs),
    };
    const { resolve, timer } = s.waiter;
    clearTimeout(timer);
    s.waiter = null;
    resolve({ op: item });
    watch(s);
  }

  /**
   * Work is waiting and Word, free, has not asked for any in `busyMs`: it is busy (a dialog is
   * open). While Word works on an operation the clock does not run: `runMs` covers that one.
   */
  function watch(s) {
    clearTimeout(s.watch);
    clearTimeout(s.stall);
    if (!s.queue.length || s.running) return;
    s.watch = setTimeout(() => {
      clearTimeout(s.stall);
      const queued = s.queue.splice(0);
      for (const item of queued) settle(s, item.id, (p) => p.reject(failure('word-busy')));
    }, busyMs);
    // Word asks every second while its tick runs: silence with work waiting is a stopped tick.
    // At most MAX_STALLS restarts without Word asking in between: a Word that quit (or is
    // quitting) does not answer, and reaching into it again and again can keep it running.
    const check = (delay) => {
      s.stall = setTimeout(() => {
        if (!sessions.has(s.id) || !s.queue.length || s.running) return;
        if (Date.now() - s.lastAsk >= stallMs && (s.stalls || 0) < MAX_STALLS) {
          s.stalls = (s.stalls || 0) + 1;
          onStall(pub(s));
        }
        check(delay * 2);
      }, delay);
    };
    check(stallMs);
  }

  function close(id, by = 'app') {
    const s = sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    clearTimeout(s.watch);
    clearTimeout(s.stall);
    if (s.running) clearTimeout(s.running.timer);
    if (s.waiter) {
      clearTimeout(s.waiter.timer);
      s.waiter.resolve({ closed: true });
    }
    for (const p of s.pending.values()) p.reject(failure('closed'));
    s.pending.clear();
    onClose(pub(s), by);
    return true;
  }

  function own(body, client) {
    const s = sessions.get(text(body?.session, 64));
    return s && s.clientId === client.id ? s : null;
  }

  const routes = {
    '/v1/word/open': {
      kind: KIND,
      handler({ body, client }) {
        const again = own(body, client);
        if (again) {
          onOpen(pub(again), true, { show: body?.show !== false });
          return { session: again.id };
        }
        if (sessions.size >= MAX_SESSIONS) throw new ApiError(429, 'too-many-sessions');
        const s = {
          id: crypto.randomBytes(12).toString('hex'),
          clientId: client.id,
          title: text(body?.title, 260) || 'Document',
          path: text(body?.path, 2048),
          queue: [],
          pending: new Map(),
          running: null,
          waiter: null,
          watch: null,
          stall: null,
          lastAsk: Date.now(),
        };
        sessions.set(s.id, s);
        onOpen(pub(s), false, { show: body?.show !== false });
        return { session: s.id };
      },
    },

    '/v1/word/next': {
      kind: KIND,
      maxBody: MAX_RESULT,
      handler({ body, client, res }) {
        const s = own(body, client);
        if (!s) return { closed: true };
        s.lastAsk = Date.now();
        // Word answers: its tick runs, so later stalls may be restarted again.
        s.stalls = 0;
        const r = body.result;
        if (r && typeof r === 'object' && s.running && r.id === s.running.id) {
          clearTimeout(s.running.timer);
          s.running = null;
          settle(s, r.id, (p) =>
            r.ok ? p.resolve(r.value ?? null) : p.reject(failure('word-error', text(r.error, 500) || 'Word could not do it.')),
          );
        }
        watch(s);
        if (s.waiter) {
          // Only one asks at a time; an older ask gives way.
          clearTimeout(s.waiter.timer);
          s.waiter.resolve({ op: null });
          s.waiter = null;
        }
        const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(body.waitMs) || 0));
        return new Promise((resolve) => {
          const waiter = { resolve, timer: null };
          waiter.timer = setTimeout(() => {
            if (s.waiter === waiter) s.waiter = null;
            resolve({ op: null });
          }, waitMs);
          s.waiter = waiter;
          res.on('close', () => {
            if (s.waiter !== waiter) return;
            clearTimeout(waiter.timer);
            s.waiter = null;
          });
          deliver(s);
        });
      },
    },

    '/v1/word/action': {
      kind: KIND,
      maxBody: 256 * 1024,
      async handler({ body, client }) {
        const s = own(body, client);
        if (!s) return { ok: false, error: MESSAGES.closed };
        const action = text(body?.action, 40);
        if (!/^[A-Za-z]{1,40}$/.test(action)) throw new ApiError(400, 'bad-action');
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
        try {
          return { ok: true, value: (await onAction(pub(s), action, args)) ?? null };
        } catch (err) {
          return { ok: false, error: String(err?.message || err).slice(0, 500) };
        }
      },
    },

    '/v1/word/event': {
      kind: KIND,
      handler({ body, client }) {
        const s = own(body, client);
        const event = text(body?.event, 40);
        if (s && event) onEvent(s.id, event, body.payload ?? null);
        return { ok: Boolean(s) };
      },
    },

    '/v1/word/close': {
      kind: KIND,
      handler({ body, client }) {
        const s = own(body, client);
        return { ok: s ? close(s.id, 'word') : false };
      },
    },
  };

  return {
    routes,
    /** Asks Word to do `op`; resolves with Word's answer. */
    call(id, op, args = {}) {
      const s = sessions.get(id);
      if (!s) return Promise.reject(failure('no-session'));
      const item = { id: String(nextOp++), op, args };
      const promise = new Promise((resolve, reject) => s.pending.set(item.id, { resolve, reject }));
      s.queue.push(item);
      watch(s);
      deliver(s);
      return promise;
    },
    close,
    closeAll: () => [...sessions.keys()].forEach((id) => close(id, 'app')),
    get: (id) => (sessions.has(id) ? pub(sessions.get(id)) : null),
    list: () => [...sessions.values()].map(pub),
  };
}

module.exports = { createWordBridge };
