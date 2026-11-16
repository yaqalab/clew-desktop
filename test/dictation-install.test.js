'use strict';
// The on-demand dictation install against a local stand-in for the clew-tools releases.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dictation = require('../src/tools/dictation-install');

const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const KEY = dictation.platformKey();

/** A package as a release would carry it: clew-stt-server/<program> inside a .tar.gz. */
function makePackage(version, { program = dictation.PROGRAM } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  fs.mkdirSync(path.join(work, 'clew-stt-server'));
  fs.writeFileSync(path.join(work, 'clew-stt-server', program), `speech server ${version}`);
  const file = `clew-stt-server-${version}-${KEY}.tar.gz`;
  execFileSync(TAR, ['-czf', path.join(work, file), '-C', work, 'clew-stt-server']);
  const bytes = fs.readFileSync(path.join(work, file));
  return { file, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Serves `/latest/download/dictation.json` and `/download/v<version>/<file>`. */
async function releases(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(typeof body === 'string' ? body : body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function manifest(version, pkg, over = {}) {
  return JSON.stringify({
    version,
    packages: { [KEY]: { file: pkg.file, sha256: pkg.sha256, size: pkg.bytes.length, ...over } },
  });
}

test('installs, reports progress, keeps one version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-'));
  const v1 = makePackage('1.3.0');
  const v2 = makePackage('1.4.0');
  const routes = {
    '/latest/download/dictation.json': manifest('1.3.0', v1),
    [`/download/v1.3.0/${v1.file}`]: v1.bytes,
    [`/download/v1.4.0/${v2.file}`]: v2.bytes,
  };
  const { server, base } = await releases(routes);
  try {
    const phases = new Set();
    const got = await dictation.install(dir, { base, onProgress: (p) => phases.add(p.phase) });
    assert.equal(got.version, '1.3.0');
    assert.equal(fs.readFileSync(got.program, 'utf8'), 'speech server 1.3.0');
    assert.deepEqual([...phases], ['checking', 'downloading', 'unpacking', 'done']);
    assert.deepEqual(dictation.installed(dir), got);

    // The same version again: nothing downloaded.
    assert.deepEqual(await dictation.install(dir, { base }), got);

    // A newer one replaces it; the old folder goes.
    routes['/latest/download/dictation.json'] = manifest('1.4.0', v2);
    const newer = await dictation.install(dir, { base });
    assert.equal(newer.version, '1.4.0');
    assert.equal(fs.existsSync(path.join(dir, '1.3.0')), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['1.4.0', 'current.json']);
  } finally {
    server.close();
  }
});

test('refuses a package that does not match its SHA-256, size or name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-'));
  const pkg = makePackage('2.0.0');
  const routes = { [`/download/v2.0.0/${pkg.file}`]: pkg.bytes };
  const { server, base } = await releases(routes);
  try {
    routes['/latest/download/dictation.json'] = manifest('2.0.0', pkg, { sha256: 'a'.repeat(64) });
    await assert.rejects(dictation.install(dir, { base }), /SHA-256/);
    routes['/latest/download/dictation.json'] = manifest('2.0.0', pkg, { size: pkg.bytes.length - 10 });
    await assert.rejects(dictation.install(dir, { base }), /larger than announced/);
    routes['/latest/download/dictation.json'] = manifest('2.0.0', pkg, { file: 'evil.tar.gz' });
    await assert.rejects(dictation.install(dir, { base }), /unexpected package name/);
    routes['/latest/download/dictation.json'] = JSON.stringify({ version: '2.0.0', packages: {} });
    await assert.rejects(dictation.install(dir, { base }), /no dictation package for this computer/);
    // Nothing half-installed was left behind.
    assert.equal(dictation.installed(dir), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    server.close();
  }
});

test('refuses a package without the speech server in it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-'));
  const pkg = makePackage('3.0.0', { program: 'something-else' });
  const { server, base } = await releases({
    '/latest/download/dictation.json': manifest('3.0.0', pkg),
    [`/download/v3.0.0/${pkg.file}`]: pkg.bytes,
  });
  try {
    await assert.rejects(dictation.install(dir, { base }), /does not contain clew-stt-server/);
    assert.equal(dictation.installed(dir), null);
  } finally {
    server.close();
  }
});

test('the package address is built from the version, never read from the manifest', () => {
  const pkg = { file: `clew-stt-server-1.2.3-${KEY}.tar.gz`, sha256: 'b'.repeat(64), size: 10, url: 'https://evil.example/x' };
  const picked = dictation.pick({ version: '1.2.3', packages: { [KEY]: pkg } }, 'https://github.com/yaqalab/clew-tools/releases');
  assert.equal(picked.url, `https://github.com/yaqalab/clew-tools/releases/download/v1.2.3/${pkg.file}`);
  assert.throws(() => dictation.pick({ version: '1.2', packages: {} }), /valid version/);
});

test('says when the latest release has a newer dictation than the one installed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-'));
  const v1 = makePackage('1.3.0');
  const v2 = makePackage('1.4.0');
  const routes = {
    '/latest/download/dictation.json': manifest('1.3.0', v1),
    [`/download/v1.3.0/${v1.file}`]: v1.bytes,
  };
  const { server, base } = await releases(routes);
  try {
    // Nothing installed: nothing to update.
    assert.equal(await dictation.updateAvailable(dir, { base }), null);
    await dictation.install(dir, { base });
    assert.equal(await dictation.updateAvailable(dir, { base }), null);
    routes['/latest/download/dictation.json'] = manifest('1.4.0', v2);
    assert.equal(await dictation.updateAvailable(dir, { base }), '1.4.0');
    // A release that cannot be read says nothing.
    routes['/latest/download/dictation.json'] = 'not json';
    assert.equal(await dictation.updateAvailable(dir, { base }), null);
  } finally {
    server.close();
  }
});

test('compares versions by their numbers', () => {
  assert.equal(dictation.newer('1.10.0', '1.9.3'), true);
  assert.equal(dictation.newer('1.4.0', '1.4.0'), false);
  assert.equal(dictation.newer('1.3.9', '1.4.0'), false);
});
