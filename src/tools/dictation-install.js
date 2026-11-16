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
const fs = require('node:fs');
const path = require('node:path');
const { download, untar } = require('../fetch-package');

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

/** `a` is a later version than `b` (both `x.y.z`). */
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/**
 * The newer version the latest release offers for an installed dictation, or null: none is
 * installed, it is already the latest, or the release could not be read (said nowhere, as with
 * the standalone tools' quiet check). `base` and `fetchImpl` are for the tests.
 */
async function updateAvailable(dir, { signal, base = RELEASES, fetchImpl = fetch } = {}) {
  const have = installed(dir);
  if (!have) return null;
  try {
    const res = await fetchImpl(manifestUrl(base), { signal, redirect: 'follow' });
    if (!res.ok) return null;
    const pkg = pick(await res.json(), base);
    return newer(pkg.version, have.version) ? pkg.version : null;
  } catch {
    return null;
  }
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
  try {
    await download(pkg.url, archive, {
      size: pkg.size,
      sha256: pkg.sha256,
      signal,
      fetchImpl,
      onProgress: (p) => onProgress({ phase: 'downloading', ...p }),
    });
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

module.exports = { install, installed, uninstall, updateAvailable, newer, pick, platformKey, manifestUrl, PROGRAM };
