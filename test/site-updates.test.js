'use strict';
// Site updates against a local stand-in for a site's /desktop/ folder, laid out the way the
// apps' scripts/desktop-package.mjs writes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const updates = require('../src/site-updates');
const { TAR } = require('../src/fetch-package');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** One deployed build: `{ files: { name → bytes } }`, cut in parts of `partSize` bytes. */
function deploy(name, { commit, committedAt, minDesktop = '0.1.0', body = 'hello', partSize = 1 << 20, over = {}, info = {} }) {
  const out = tmp('out-');
  fs.writeFileSync(path.join(out, 'index.html'), body);
  // Something that does not compress, so a small part size gives several parts.
  fs.writeFileSync(path.join(out, 'noise.bin'), crypto.randomBytes(3000));
  const build = { ref: 'main', commit, committedAt, builtAt: committedAt, minDesktop };
  fs.writeFileSync(path.join(out, '.build-info.json'), JSON.stringify({ name, ...build, source: 'cloudflare', ...info }));
  const archive = path.join(tmp('work-'), 'site.tar.gz');
  execFileSync(TAR, ['-czf', archive, '-C', out, '.']);
  const bytes = fs.readFileSync(archive);
  const files = {};
  const parts = [];
  for (let at = 0; at < bytes.length; at += partSize) {
    const chunk = bytes.subarray(at, at + partSize);
    const file = `${name}-site-${commit.slice(0, 12)}.part${parts.length + 1}`;
    files[file] = chunk;
    parts.push({ file, size: chunk.length, sha256: sha256(chunk) });
  }
  files['version.json'] = JSON.stringify({ site: name, ...build, size: bytes.length, sha256: sha256(bytes), parts, ...over });
  return { files, parts };
}

/** Serves `/desktop/<file>` from `site.files`, which a test may replace; `?…` is ignored. */
async function host(site) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const body = url.startsWith('/desktop/') ? site.files?.[url.slice('/desktop/'.length)] : undefined;
    res.writeHead(body === undefined ? 404 : 200);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, at: `http://127.0.0.1:${server.address().port}/desktop` };
}

const sha = (c) => c.repeat(40);
const opts = (at, current, appVersion = '0.1.0') => ({ at, appVersion, current });
const bundled = { name: 'clew', commit: sha('a'), committedAt: '2026-11-01T10:00:00Z', builtAt: '2026-11-01T11:00:00Z' };
const newer = { commit: sha('b'), committedAt: '2026-11-02T10:00:00Z' };

test('downloads a newer build in parts and switches to it at the next start', async () => {
  const dir = tmp('upd-');
  const site = deploy('clew', { ...newer, body: 'v2', partSize: 1000 });
  assert.ok(site.parts.length >= 3, `${site.parts.length} parts`);
  const { server, at } = await host(site);
  try {
    const r = await updates.check(dir, 'clew', opts(at, bundled));
    assert.equal(r.status, 'ready');
    assert.equal(r.info.commit, sha('b'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'clew')).sort(), ['bbbbbbbbbbbb', 'current.json']);
    // Already waiting: nothing downloaded again.
    assert.equal((await updates.check(dir, 'clew', opts(at, r.info))).status, 'current');

    const active = updates.activate(dir, 'clew', bundled, '0.1.0');
    assert.equal(active.id, 'bbbbbbbbbbbb');
    assert.equal(fs.readFileSync(path.join(active.root, 'index.html'), 'utf8'), 'v2');
  } finally {
    server.close();
  }
});

test('the installer wins when its own build is newer; older copies are removed', async () => {
  const dir = tmp('upd-');
  const { server, at } = await host(deploy('clew', newer));
  try {
    await updates.check(dir, 'clew', opts(at, bundled));
    fs.mkdirSync(path.join(dir, 'clew', 'cccccccccccc.new'));
    const newerInstaller = { ...bundled, commit: sha('d'), committedAt: '2026-11-03T10:00:00Z' };
    assert.equal(updates.activate(dir, 'clew', newerInstaller, '0.1.0'), null);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'clew')), []);
    // An older build on the site is not taken either.
    assert.equal((await updates.check(dir, 'clew', opts(at, newerInstaller))).status, 'current');
  } finally {
    server.close();
  }
});

test('a build that needs a newer app waits for it', async () => {
  const dir = tmp('upd-');
  const { server, at } = await host(deploy('clew', { ...newer, minDesktop: '0.3.0' }));
  try {
    assert.equal((await updates.check(dir, 'clew', opts(at, bundled, '0.2.9'))).status, 'needs-app');
    assert.equal((await updates.check(dir, 'clew', opts(at, bundled, '0.3.0'))).status, 'ready');
    assert.equal(updates.activate(dir, 'clew', bundled, '0.2.0'), null, 'not used by an older app');
  } finally {
    server.close();
  }
});

test('refuses foreign, altered or incomplete builds, and leaves nothing behind', async () => {
  const dir = tmp('upd-');
  const site = {};
  const { server, at } = await host(site);
  const run = () => updates.check(dir, 'clew', opts(at, bundled));
  try {
    site.files = deploy('yaqatw', newer).files;
    await assert.rejects(run(), /not for clew/);

    const good = deploy('clew', { ...newer, partSize: 1000 });
    const v = JSON.parse(good.files['version.json']);
    const variant = (change) => ({ ...good.files, 'version.json': JSON.stringify(change(structuredClone(v))) });

    site.files = variant((x) => ((x.parts[0].file = 'evil.bin'), x));
    await assert.rejects(run(), /unexpected part name/);
    site.files = variant((x) => ((x.parts[1].sha256 = 'f'.repeat(64)), x));
    await assert.rejects(run(), /SHA-256/);
    site.files = variant((x) => ((x.sha256 = 'f'.repeat(64)), x));
    await assert.rejects(run(), /joined parts/);
    site.files = variant((x) => ((x.size += 1), x));
    await assert.rejects(run(), /add up/);
    // A newer deploy replaced this one between version.json and a part.
    site.files = { ...good.files };
    delete site.files[v.parts[2].file];
    await assert.rejects(run(), /404/);
    // An archive whose build info names another commit.
    site.files = deploy('clew', { ...newer, info: { commit: sha('e') } }).files;
    await assert.rejects(run(), /does not match version.json/);

    assert.equal(updates.activate(dir, 'clew', bundled, '0.1.0'), null);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'clew')), []);
  } finally {
    server.close();
  }
});

test('a site that publishes nothing for the desktop is not an error', async () => {
  const { server, at } = await host({});
  try {
    assert.equal((await updates.check(tmp('upd-'), 'clew', opts(at, bundled))).status, 'none');
  } finally {
    server.close();
  }
  // Nor is a single-page site that answers every missing file with its page.
  const spa = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><div id="app"></div>');
  });
  await new Promise((r) => spa.listen(0, '127.0.0.1', r));
  try {
    const at = `http://127.0.0.1:${spa.address().port}/desktop`;
    assert.equal((await updates.check(tmp('upd-'), 'clew', opts(at, bundled))).status, 'none');
  } finally {
    spa.close();
  }
});

test('part addresses come from the site and commit, never from version.json', () => {
  const v = { site: 'clew', commit: sha('b'), sha256: 'c'.repeat(64), size: 9, committedAt: newer.committedAt,
    builtAt: newer.committedAt, parts: [{ file: 'clew-site-bbbbbbbbbbbb.part1', size: 9, sha256: 'd'.repeat(64), url: 'https://evil.example/x' }] };
  assert.equal(updates.parse(v, 'clew', 'https://clew.alefa.net/desktop').parts[0].url,
    'https://clew.alefa.net/desktop/clew-site-bbbbbbbbbbbb.part1');
  assert.equal(updates.compareVersions('0.10.0', '0.9.9'), 1);
  // An installer built before commit dates were recorded is compared by build time.
  assert.equal(updates.isNewer({ commit: sha('b'), committedAt: '2026-11-02T00:00:00Z', builtAt: '2026-11-02T10:00:00Z' },
    { commit: sha('a'), builtAt: '2026-11-02T09:00:00Z' }), true);
});

// Signatures: version.json.sig, Ed25519 over version.json's bytes (desktop-package.mjs signs).
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}
const signed = (files, privateKey) => ({
  ...files,
  'version.json.sig': crypto.sign(null, Buffer.from(files['version.json']), privateKey).toString('base64'),
});

test('a signed build is taken; a wrong or broken signature never is', async () => {
  const k1 = keyPair();
  const k2 = keyPair();
  const other = keyPair();
  const good = deploy('clew', newer);
  const site = {};
  const { server, at } = await host(site);
  const run = (o = {}) => updates.check(tmp('upd-'), 'clew', { ...opts(at, bundled), keys: [k1.pub, k2.pub], ...o });
  try {
    site.files = signed(good.files, k1.privateKey);
    let r = await run({ requireSignature: true });
    assert.equal(r.status, 'ready');
    assert.equal(r.build.signed, true);
    // The spare key signs as well.
    site.files = signed(good.files, k2.privateKey);
    assert.equal((await run({ requireSignature: true })).status, 'ready');
    // Another key: refused, required or not.
    site.files = signed(good.files, other.privateKey);
    await assert.rejects(run(), /not signed by a key this app knows/);
    // version.json changed after signing (a part's hash swapped).
    const v = JSON.parse(good.files['version.json']);
    v.parts[0].sha256 = 'f'.repeat(64);
    site.files = { ...signed(good.files, k1.privateKey), 'version.json': JSON.stringify(v) };
    await assert.rejects(run(), /not signed by a key this app knows/);
    site.files = { ...good.files, 'version.json.sig': 'not a signature' };
    await assert.rejects(run(), /not an Ed25519 signature/);
    // No signature: taken until signatures are required.
    site.files = good.files;
    r = await run();
    assert.equal(r.status, 'ready');
    assert.equal(r.build.signed, false);
    await assert.rejects(run({ requireSignature: true }), /version.json is not signed/);
  } finally {
    server.close();
  }
});
