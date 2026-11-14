'use strict';
/**
 * Dictation's speech server, fetched on demand: most people never dictate, and it is about
 * 200 MB, so the installer leaves it out and this fetches it the first time it is wanted.
 *
 * From the public clew-tools releases (`yaqalab/clew-tools`), as the standalone tools' updater
 * does (Clew docs/32 §3), with the same care:
 * - `dictation.json` from the latest release: `{ version, packages: { "<platform>-<arch>":
 *   { file, sha256, size } } }`.
 * - The package's address is built from the version and the file name, never read from the
 *   manifest, and the name must look like `clew-stt-server-<version>-<platform>-<arch>.tar.gz`.
 * - The download stops as soon as it is larger than announced; size and SHA-256 must match.
 * - It is unpacked (the system's tar: bsdtar on Windows 10+ and macOS, GNU tar on Linux) into a
 *   new folder, then moved into place; `current.json` says which version is in use.
 *
 * Plain Node: no Electron here.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const RELEASES = 'https://github.com/yaqalab/clew-tools/releases';
const MAX_BYTES = 1024 * 1024 * 1024;
const PROGRAM = process.platform === 'win32' ? 'clew-stt-server.exe' : 'clew-stt-server';

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function manifestUrl(base = RELEASES) {
  return process.env.CLEW_DICTATION_MANIFEST || `${base}/latest/download/dictation.json`;
}

/** The program of the version in use, or null. */
function installed(dir) {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
    const program = path.join(dir, current.version, 'clew-stt-server', PROGRAM);
    return fs.existsSync(program) ? { version: current.version, program } : null;
  } catch {
    return null;
  }
}

/** Checks a manifest and returns the package for this computer: `{ version, file, sha256, size, url }`. */
function pick(manifest, base = RELEASES, key = platformKey()) {
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('the manifest has no valid version');
  const pkg = manifest.packages?.[key];
  if (!pkg) throw new Error(`no dictation package for this computer (${key})`);
  const expected = `clew-stt-server-${version}-${key}.tar.gz`;
  if (pkg.file !== expected) throw new Error(`unexpected package name: ${pkg.file}`);
  if (!/^[0-9a-f]{64}$/.test(pkg.sha256 || '')) throw new Error('the manifest has no valid SHA-256');
  if (!Number.isInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_BYTES) throw new Error('the manifest has no valid size');
  return { version, file: pkg.file, sha256: pkg.sha256, size: pkg.size, url: `${base}/download/v${version}/${pkg.file}` };
}

// Windows' own tar (bsdtar, Windows 10+): a GNU tar found first on PATH reads "C:" as a host name.
const TAR =
  process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function untar(archive, into) {
  return new Promise((resolve, reject) => {
    const child = spawn(TAR, ['-xzf', archive, '-C', into], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`could not unpack (${err.trim() || code})`))));
  });
}

/**
 * Fetches and installs the latest package into `dir`. `onProgress({ phase, received, size })`.
 * Resolves with `{ version, program }`. `base` and `fetchImpl` are for the tests.
 */
async function install(dir, { onProgress = () => {}, signal, base = RELEASES, fetchImpl = fetch } = {}) {
  onProgress({ phase: 'checking' });
  const res = await fetchImpl(manifestUrl(base), { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`could not read the release (${res.status})`);
  const pkg = pick(await res.json(), base);

  const have = installed(dir);
  if (have && have.version === pkg.version) return have;

  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `${pkg.file}.part`);
  const download = await fetchImpl(pkg.url, { signal, redirect: 'follow' });
  if (!download.ok || !download.body) throw new Error(`could not download ${pkg.file} (${download.status})`);
  const hash = crypto.createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(archive);
  try {
    for await (const chunk of Readable.fromWeb(download.body)) {
      received += chunk.length;
      if (received > pkg.size) throw new Error('the download is larger than announced');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress({ phase: 'downloading', received, size: pkg.size });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (received !== pkg.size) throw new Error('the download is incomplete');
    if (hash.digest('hex') !== pkg.sha256) throw new Error('the download does not match its SHA-256');

    onProgress({ phase: 'unpacking' });
    const staging = path.join(dir, `${pkg.version}.new`);
    const target = path.join(dir, pkg.version);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await untar(archive, staging);
    if (!fs.existsSync(path.join(staging, 'clew-stt-server', PROGRAM))) {
      throw new Error('the package does not contain clew-stt-server');
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    fs.writeFileSync(path.join(dir, 'current.json'), `${JSON.stringify({ version: pkg.version }, null, 2)}\n`);
  } catch (err) {
    out.destroy();
    throw err;
  } finally {
    fs.rmSync(archive, { force: true });
  }

  // Older versions go: the one in use is the only one kept.
  for (const entry of fs.readdirSync(dir)) {
    if (/^\d+\.\d+\.\d+(\.new)?$/.test(entry) && entry !== pkg.version) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  onProgress({ phase: 'done' });
  return installed(dir);
}

/** Removes every installed version. */
function uninstall(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { install, installed, uninstall, pick, platformKey, manifestUrl, PROGRAM };
