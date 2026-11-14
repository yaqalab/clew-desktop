'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const tlsLib = require('node:tls');
const { createSiteServer } = require('../src/local-server');
const tls = require('../src/tls');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>clew</h1>');
  fs.writeFileSync(path.join(root, 'about.html'), 'about');
  return root;
}

async function setup() {
  const root = fixture();
  const site = { name: 'clew', host: 'clew.alefa.net', origin: 'https://clew.alefa.net', root, devUrl: null };
  const sites = {
    list: [site],
    byHost: (h) => (String(h).toLowerCase() === site.host ? site : null),
  };
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const { key, cert } = await tls.loadOrCreate(certDir, [site.host]);
  const server = createSiteServer({ sites, key, cert, log: { error() {} } });
  const port = await server.listen();
  return { server, port, cert, certDir };
}

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT through the proxy, then a GET over TLS that trusts only the app's certificate. */
async function viaTunnel(port, cert, host, pathname) {
  const { status, socket } = await request(port, { method: 'CONNECT', path: `${host}:443` });
  if (status !== 200) return { status };
  const secure = tlsLib.connect({ socket, servername: host, ca: cert });
  await new Promise((r, j) => secure.once('secureConnect', r).once('error', j));
  return new Promise((resolve, reject) => {
    const req = http.request({
      createConnection: () => secure,
      host,
      path: pathname,
      headers: { host },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        secure.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves a bundled host over CONNECT + TLS with its own certificate', async () => {
  const { server, port, cert } = await setup();
  try {
    const r = await viaTunnel(port, cert, 'clew.alefa.net', '/about');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'about');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    const redirect = await viaTunnel(port, cert, 'clew.alefa.net', '/about.html');
    assert.equal(redirect.status, 308);
    assert.equal(server.stats.local, 2);
  } finally {
    server.close();
  }
});

test('refuses CONNECT to any other host or port', async () => {
  const { server, port } = await setup();
  try {
    assert.equal((await request(port, { method: 'CONNECT', path: 'example.com:443' })).status, 403);
    assert.equal((await request(port, { method: 'CONNECT', path: 'clew.alefa.net:8443' })).status, 403);
  } finally {
    server.close();
  }
});

test('plain http for a bundled host is redirected to https (308)', async () => {
  const { server, port } = await setup();
  try {
    const r = await request(port, { path: 'http://clew.alefa.net/about?x=1', headers: { host: 'clew.alefa.net' } });
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, 'https://clew.alefa.net/about?x=1');
    const other = await request(port, { path: 'http://example.com/', headers: { host: 'example.com' } });
    assert.equal(other.status, 403);
  } finally {
    server.close();
  }
});

test('the PAC script routes only the bundled hosts', async () => {
  const { server, port } = await setup();
  try {
    server.setPacFallback('PROXY corp:3128; DIRECT');
    const { body } = await request(port, { path: '/proxy.pac' });
    const FindProxyForURL = new Function(`${body}; return FindProxyForURL;`)();
    assert.equal(FindProxyForURL('https://clew.alefa.net/', 'clew.alefa.net'), `PROXY 127.0.0.1:${port}`);
    assert.equal(FindProxyForURL('https://CLEW.alefa.net/', 'CLEW.alefa.net'), `PROXY 127.0.0.1:${port}`);
    assert.equal(FindProxyForURL('https://alefa.net/', 'alefa.net'), 'PROXY corp:3128; DIRECT');
    assert.equal(FindProxyForURL('https://evil-clew.alefa.net/', 'evil-clew.alefa.net'), 'PROXY corp:3128; DIRECT');
  } finally {
    server.close();
  }
});

test('the certificate is reused, and renewed when the host list changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const a = await tls.loadOrCreate(dir, ['clew.alefa.net', 'yaqatw.alefa.net']);
  const b = await tls.loadOrCreate(dir, ['yaqatw.alefa.net', 'clew.alefa.net']);
  assert.equal(a.cert, b.cert);
  const c = await tls.loadOrCreate(dir, ['clew.alefa.net']);
  assert.notEqual(a.cert, c.cert);
  const x509 = new (require('node:crypto').X509Certificate)(a.cert);
  assert.match(x509.subjectAltName, /DNS:clew\.alefa\.net/);
  assert.match(x509.subjectAltName, /DNS:yaqatw\.alefa\.net/);
});
