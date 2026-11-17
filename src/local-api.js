'use strict';
/**
 * The local API: an HTTP server on 127.0.0.1 for programs on this computer. Plain Node: no
 * Electron here; the app brings the question it asks the user (`approve`).
 *
 * Plain HTTP: the traffic never leaves the computer, and HTTPS would need a certificate that
 * every client trusts, that is, one in the system's trust store.
 *
 * Who may talk to it:
 * - `Host` must be `127.0.0.1:<port>` or `localhost:<port>`: a web page cannot reach it through
 *   a name of its own that resolves here (DNS rebinding).
 * - Web pages are refused: a request with an `Origin` (or a browser's `Sec-Fetch-Site` other than
 *   `none`) is answered 403 unless the origin is on `allowedOrigins`, empty by default. A program
 *   sends neither.
 * - Everything but `GET /v1/hello` and `POST /v1/pair` needs a token, `Authorization: Bearer …`,
 *   which a client gets once, by pairing: the user is asked, in the app, whether to allow it.
 *   Only a SHA-256 of each token is kept (`clients.json`).
 *
 * Routes (JSON in and out, errors as `{ error: code }`):
 * - `GET /v1/hello` → `{ app: 'clew-desktop', api: 1 }`
 * - `POST /v1/pair` `{ name }` → `{ id, token }` once the user allows it; 403 `refused`,
 *   408 `timeout` (two minutes), 409 `busy` while another pairing waits for an answer.
 * - `GET /v1/me` → `{ id, name, pairedAt }`
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = 1;
const DEFAULT_PORT = 47830;
const MAX_BODY = 16 * 1024;
const PAIR_TIMEOUT_MS = 120000;
const MAX_NAME = 60;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const hash = (token) => crypto.createHash('sha256').update(token, 'utf8').digest();

/**
 * The paired clients, kept in one JSON file: `{ clients: [{ id, name, hash, pairedAt }] }`, the
 * hash in base64url. An unreadable file counts as no clients: they pair again.
 */
function createClients(file) {
  let clients = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data?.clients)) clients = data.clients.filter((c) => c && c.id && c.hash);
  } catch {
    /* none yet */
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ clients }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const pub = ({ id, name, pairedAt }) => ({ id, name, pairedAt });

  return {
    file,
    /** A new client; the token is returned here and never kept. */
    add(name) {
      const token = crypto.randomBytes(32).toString('base64url');
      const client = {
        id: crypto.randomBytes(8).toString('hex'),
        name,
        hash: hash(token).toString('base64url'),
        pairedAt: new Date().toISOString(),
      };
      clients.push(client);
      save();
      return { id: client.id, token };
    },
    /** The client holding this token, or null. Compared in constant time. */
    find(token) {
      if (typeof token !== 'string' || !token) return null;
      const h = hash(token);
      let found = null;
      for (const c of clients) {
        const stored = Buffer.from(c.hash, 'base64url');
        if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) found = c;
      }
      return found ? pub(found) : null;
    },
    remove(id) {
      const before = clients.length;
      clients = clients.filter((c) => c.id !== id);
      if (clients.length !== before) save();
      return clients.length !== before;
    },
    list: () => clients.map(pub),
  };
}

/** A name to show the user: printable, one line, at most 60 characters. */
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      reject(new ApiError(415, 'json-only'));
      return;
    }
    if (Number(req.headers['content-length']) > MAX_BODY) {
      reject(new ApiError(413, 'too-large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Past the limit: answered at once, the rest drained unread.
      if (size > MAX_BODY) reject(new ApiError(413, 'too-large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'bad-json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {number} [opts.port]  0 for any free port (tests, the smoke run)
 * @param {ReturnType<typeof createClients>} opts.clients
 * @param {(ask: { name: string, signal: AbortSignal }) => Promise<boolean>} opts.approve
 *        asks the user; the signal fires when the client gave up or the wait timed out
 * @param {string[]} [opts.allowedOrigins]  web origins allowed to call (CORS); none by default
 * @param {number} [opts.pairTimeoutMs]
 */
function createLocalApi({ port = DEFAULT_PORT, clients, approve, allowedOrigins = [], pairTimeoutMs = PAIR_TIMEOUT_MS, log = console }) {
  const allowed = new Set(allowedOrigins);
  let listening = 0;
  let pairing = null;
  let lastError = null;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) log.warn(`[local-api] ${err.message}`);
      send(req, res, status, { error: err instanceof ApiError ? err.code : 'internal' });
    });
  });

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return {};
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }

  function send(req, res, status, body, extra = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...corsHeaders(req),
      ...extra,
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  function hostOk(host) {
    return host === `127.0.0.1:${listening}` || host === `localhost:${listening}`;
  }

  function fromAllowedCaller(req) {
    const origin = req.headers.origin;
    if (origin !== undefined) return allowed.has(origin);
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'none';
  }

  function authenticate(req) {
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    const client = m ? clients.find(m[1]) : null;
    if (!client) throw new ApiError(401, 'unauthorized');
    return client;
  }

  async function handle(req, res) {
    if (!hostOk(req.headers.host)) throw new ApiError(403, 'bad-host');
    if (!fromAllowedCaller(req)) throw new ApiError(403, 'bad-origin');
    const { pathname } = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'OPTIONS' && req.headers.origin) {
      const extra = {
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      };
      if (req.headers['access-control-request-private-network'] === 'true') {
        extra['access-control-allow-private-network'] = 'true';
      }
      send(req, res, 204, undefined, extra);
      return;
    }

    const route = ROUTES[pathname];
    if (!route) throw new ApiError(404, 'not-found');
    const fn = route[req.method];
    if (!fn) throw new ApiError(405, 'method-not-allowed');
    send(req, res, 200, await fn(req, res));
  }

  const ROUTES = {
    '/v1/hello': { GET: () => ({ app: 'clew-desktop', api: API }) },
    '/v1/me': { GET: (req) => authenticate(req) },
    '/v1/pair': { POST: pair },
  };

  async function pair(req, res) {
    const body = await readJson(req);
    const name = cleanName(body?.name);
    if (!name) throw new ApiError(400, 'bad-name');
    if (pairing) throw new ApiError(409, 'busy');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, pairTimeoutMs);
    const gone = () => controller.abort();
    res.on('close', gone);
    pairing = controller;
    try {
      const yes = await approve({ name, signal: controller.signal });
      if (timedOut) throw new ApiError(408, 'timeout');
      // Gave up waiting: no token nobody would hold.
      if (controller.signal.aborted) throw new ApiError(499, 'gone');
      if (!yes) throw new ApiError(403, 'refused');
      const client = clients.add(name);
      log.log(`[local-api] paired "${name}" (${client.id})`);
      return client;
    } finally {
      clearTimeout(timer);
      res.off('close', gone);
      pairing = null;
    }
  }

  return {
    server,
    clients,
    /** Resolves with the port; rejects when it is taken. */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          lastError = err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message;
          reject(err);
        };
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          listening = server.address().port;
          lastError = null;
          resolve(listening);
        });
      });
    },
    close() {
      pairing?.abort();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    status: () => ({ port: listening || port, listening: Boolean(listening), error: lastError }),
  };
}

module.exports = { createLocalApi, createClients, DEFAULT_PORT, API };
