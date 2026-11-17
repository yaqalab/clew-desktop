'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createLocalApi, createClients } = require('../src/local-api');

const quiet = { log() {}, warn() {} };

/** A server on a free port; `answer` decides each pairing (the user's click). */
async function fresh(t, { answer = async () => true, allowedOrigins, pairTimeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-local-api-test-'));
  const clients = createClients(path.join(dir, 'clients.json'));
  const asked = [];
  const api = createLocalApi({
    port: 0,
    clients,
    allowedOrigins,
    pairTimeoutMs,
    log: quiet,
    approve: (ask) => {
      asked.push(ask);
      return answer(ask);
    },
  });
  const port = await api.listen();
  t.after(async () => {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { api, port, clients, asked, dir };
}

/** A raw request, so Host and the browser headers can be anything. */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const json = (value) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

const pairReq = (name = 'Test client') => ({ path: '/v1/pair', ...json({ name }) });

test('hello needs nothing and says what it is', async (t) => {
  const { port } = await fresh(t);
  const r = await request(port, { path: '/v1/hello' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { app: 'clew-desktop', api: 1, pid: process.pid });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('localhost:<port> is accepted as Host; any other name is refused', async (t) => {
  const { port } = await fresh(t);
  assert.equal((await request(port, { path: '/v1/hello', headers: { host: `localhost:${port}` } })).status, 200);
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
    const r = await request(port, { path: '/v1/hello', headers: { host } });
    assert.equal(r.status, 403, host);
    assert.equal(r.body.error, 'bad-host');
  }
});

test('web pages are refused, by Origin or by Sec-Fetch-Site', async (t) => {
  const { port, asked } = await fresh(t);
  const fromPage = [
    { origin: 'https://example.com' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of fromPage) {
    const r = await request(port, { path: '/v1/hello', headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal(r.body.error, 'bad-origin');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const p = await request(port, { ...pairReq(), headers: { ...pairReq().headers, ...headers } });
    assert.equal(p.status, 403);
  }
  assert.equal(asked.length, 0, 'a page made the app ask the user');
  // Typed in the address bar.
  assert.equal((await request(port, { path: '/v1/hello', headers: { 'sec-fetch-site': 'none' } })).status, 200);
});

test('an allowed origin gets CORS, its preflight and the private-network answer', async (t) => {
  const origin = 'https://yaqatw.alefa.net';
  const { port } = await fresh(t, { allowedOrigins: [origin] });
  const pre = await request(port, {
    method: 'OPTIONS',
    path: '/v1/me',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
      'access-control-request-private-network': 'true',
    },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], origin);
  assert.equal(pre.headers['access-control-allow-private-network'], 'true');
  assert.match(pre.headers['access-control-allow-headers'], /authorization/);
  const r = await request(port, { path: '/v1/hello', headers: { origin } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], origin);
  assert.equal(r.headers.vary, 'Origin');
});

test('pairing: the user allows, the token works, only its hash is kept', async (t) => {
  const { port, asked, clients } = await fresh(t);
  const p = await request(port, pairReq('  Word   plugin '));
  assert.equal(p.status, 200);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'Word plugin');
  assert.match(p.body.token, /^[A-Za-z0-9_-]{43}$/);
  const me = await request(port, { path: '/v1/me', headers: { authorization: `Bearer ${p.body.token}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.id, p.body.id);
  assert.equal(me.body.name, 'Word plugin');
  assert.ok(me.body.pairedAt);
  assert.equal(me.body.hash, undefined);
  const file = fs.readFileSync(clients.file, 'utf8');
  assert.equal(file.includes(p.body.token), false);
  // Read again from the file, as at the next start.
  assert.equal(createClients(clients.file).find(p.body.token)?.id, p.body.id);
});

test('pairing: refused, timed out, or the client gave up: no client is added', async (t) => {
  const refused = await fresh(t, { answer: async () => false });
  const r = await request(refused.port, pairReq());
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'refused');
  assert.equal(refused.clients.list().length, 0);

  // Never answered: the wait ends, and the question is told to go away.
  const never = (ask) => new Promise((resolve) => ask.signal.addEventListener('abort', () => resolve(true)));
  const slow = await fresh(t, { answer: never, pairTimeoutMs: 100 });
  const s = await request(slow.port, pairReq());
  assert.equal(s.status, 408);
  assert.equal(slow.asked[0].signal.aborted, true);
  assert.equal(slow.clients.list().length, 0);

  const gone = await fresh(t, { answer: never });
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gone.port,
      method: 'POST',
      path: '/v1/pair',
      headers: { host: `127.0.0.1:${gone.port}`, 'content-type': 'application/json' },
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ name: 'Leaves early' }));
    const tick = setInterval(() => {
      if (gone.asked.length) {
        clearInterval(tick);
        req.destroy();
      }
    }, 10);
  });
  for (let i = 0; i < 50 && !gone.asked[0].signal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(gone.asked[0].signal.aborted, true);
  assert.equal(gone.clients.list().length, 0);
});

test('one pairing question at a time', async (t) => {
  let release;
  const { port, asked } = await fresh(t, { answer: () => new Promise((r) => (release = r)) });
  const first = request(port, pairReq('First'));
  for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 10));
  const second = await request(port, pairReq('Second'));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy');
  release(true);
  assert.equal((await first).status, 200);
  assert.equal(asked.length, 1);
});

test('names the user would see are checked', async (t) => {
  const { port, asked } = await fresh(t);
  for (const name of ['', '   ', 'x'.repeat(61), 'a\u0000b', 'right‮left', 42, null]) {
    const r = await request(port, { path: '/v1/pair', ...json({ name }) });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.body.error, 'bad-name');
  }
  assert.equal(asked.length, 0);
});

test('tokens: missing, malformed, unknown or removed are refused', async (t) => {
  const { port, clients } = await fresh(t);
  const { body } = await request(port, pairReq());
  for (const authorization of [undefined, 'Bearer', `Basic ${body.token}`, 'Bearer not-a-token', `Bearer ${body.token}x`]) {
    const headers = authorization ? { authorization } : {};
    const r = await request(port, { path: '/v1/me', headers });
    assert.equal(r.status, 401, String(authorization));
  }
  assert.equal(clients.remove(body.id), true);
  const r = await request(port, { path: '/v1/me', headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(r.status, 401);
});

test('bodies: JSON only, 16 KiB at most; unknown paths and methods', async (t) => {
  const { port, asked } = await fresh(t);
  const text = await request(port, { method: 'POST', path: '/v1/pair', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' });
  assert.equal(text.status, 415);
  const big = await request(port, { path: '/v1/pair', ...json({ name: 'x', pad: 'y'.repeat(20000) }) });
  assert.equal(big.status, 413);
  const bad = await request(port, { method: 'POST', path: '/v1/pair', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal((await request(port, { path: '/v1/nothing' })).status, 404);
  assert.equal((await request(port, { method: 'POST', path: '/v1/hello', ...json({}) })).status, 405);
  assert.equal((await request(port, { path: '/v1/pair' })).status, 405);
  assert.equal(asked.length, 0);
});

test('a taken port is reported, not thrown at start', async (t) => {
  const { port, dir } = await fresh(t);
  const other = createLocalApi({ port, clients: createClients(path.join(dir, 'other.json')), approve: async () => false, log: quiet });
  await assert.rejects(other.listen(), { code: 'EADDRINUSE' });
  assert.deepEqual(other.status(), { port, listening: false, error: `port ${port} is in use` });
});

test('an unreadable clients file counts as no clients', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-local-api-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clients.json');
  fs.writeFileSync(file, '{ not json');
  const clients = createClients(file);
  assert.deepEqual(clients.list(), []);
  const { token } = clients.add('After');
  assert.equal(createClients(file).find(token).name, 'After');
});
