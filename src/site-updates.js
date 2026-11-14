'use strict';
/**
 * Newer builds of the bundled sites, between installers, straight from the sites themselves.
 *
 * Cloudflare Pages builds Clew and yaqatw on each push to main; the build ends with
 * `scripts/desktop-package.mjs` (in each app's repo), which adds to the deployed site:
 *
 *   /desktop/version.json   { site, commit, ref, committedAt, builtAt, minDesktop, size, sha256,
 *                             parts: [{ file, size, sha256 }] }
 *   /desktop/<name>-site-<commit12>.partN   the whole output as one .tar.gz, cut in parts of at
 *                             most 20 MiB (Cloudflare Pages serves files up to 25 MiB)
 *
 * The app takes a build only if version.json names this site, is newer than what the app already
 * has (commit date) and allows this app version (`minDesktop`). The part addresses are built from
 * the site and the commit, never read from the file; every part and the whole must match their
 * size and SHA-256. It is unpacked under `<dir>/<name>/<commit12>/` and `current.json` points at
 * it; the app switches at its next start (a running page never has its files changed underneath
 * it), and only if that copy is still newer than the installer's own.
 *
 * The trust is the site's: what https://clew.alefa.net serves is what its web users run.
 * Plain Node: no Electron here.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { download, untar } = require('./fetch-package');

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_PART = 25 * 1024 * 1024;
const ID = /^[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** -1, 0 or 1, for plain x.y.z versions. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const validDate = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

/**
 * Checks a version.json and returns the build: `{ commit, id, size, sha256, parts: [{ url, … }], … }`.
 * `at` is the folder it came from (`https://clew.alefa.net/desktop`).
 */
function parse(v, name, at) {
  if (v?.site !== name) throw new Error(`version.json is not for ${name}`);
  const { commit, sha256, size, committedAt, builtAt } = v;
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('version.json has no valid commit');
  if (!HEX64.test(sha256 || '')) throw new Error('version.json has no valid SHA-256');
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) throw new Error('version.json has no valid size');
  if (!validDate(committedAt) || !validDate(builtAt)) throw new Error('version.json has no valid dates');
  const minDesktop = v.minDesktop ?? '0.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(minDesktop)) throw new Error('version.json has no valid minDesktop');
  const id = commit.slice(0, 12);
  if (!Array.isArray(v.parts) || v.parts.length === 0 || v.parts.length > 20) throw new Error('version.json has no valid parts');
  const parts = v.parts.map((p, i) => {
    const file = `${name}-site-${id}.part${i + 1}`;
    if (p?.file !== file) throw new Error(`unexpected part name: ${p?.file}`);
    if (!Number.isInteger(p.size) || p.size <= 0 || p.size > MAX_PART) throw new Error(`${file} has no valid size`);
    if (!HEX64.test(p.sha256 || '')) throw new Error(`${file} has no valid SHA-256`);
    return { file, size: p.size, sha256: p.sha256, url: `${at}/${file}` };
  });
  if (parts.reduce((n, p) => n + p.size, 0) !== size) throw new Error('the parts do not add up to the size');
  return { site: name, commit, id, size, sha256, committedAt, builtAt, minDesktop, parts };
}

/**
 * Whether build `a` is newer than build `b` (build infos or version files). By commit date when
 * both have one; an installer built before commit dates were recorded is compared by build time.
 */
function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.commit === b.commit) return false;
  const both = validDate(a.committedAt) && validDate(b.committedAt);
  const ta = Date.parse(both ? a.committedAt : a.builtAt);
  const tb = Date.parse(both ? b.committedAt : b.builtAt);
  return ta > tb;
}

/**
 * At start: the downloaded copy of `name` to serve instead of the installer's, or null.
 * Everything else under `<dir>/<name>` goes (older copies, half-finished downloads).
 */
function activate(dir, name, bundledInfo, appVersion) {
  const siteDir = path.join(dir, name);
  if (!fs.existsSync(siteDir)) return null;
  const current = readJson(path.join(siteDir, 'current.json'));
  let active = null;
  if (current && ID.test(current.id)) {
    const root = path.join(siteDir, current.id);
    const info = readJson(path.join(root, '.build-info.json'));
    const allowed = info && compareVersions(appVersion, info.minDesktop ?? '0.0.0') >= 0;
    if (allowed && isNewer(info, bundledInfo)) active = { id: current.id, root, info };
  }
  for (const entry of fs.readdirSync(siteDir)) {
    if (active && (entry === active.id || entry === 'current.json')) continue;
    fs.rmSync(path.join(siteDir, entry), { recursive: true, force: true });
  }
  return active;
}

/** Joins the downloaded parts into `to`, checking the whole SHA-256. */
async function join(files, to, sha256) {
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(to);
  try {
    for (const file of files) {
      for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    throw err;
  }
  if (hash.digest('hex') !== sha256) throw new Error('the joined parts do not match their SHA-256');
}

/**
 * Looks for a newer build of `name` than `current` (the build info in use or already waiting),
 * at `at` (`https://<host>/desktop`). Resolves with `{ status, build?, info? }`: 'none' (the site
 * publishes nothing for the desktop), 'current', 'needs-app' or 'ready' (downloaded, used from the
 * next start).
 */
async function check(dir, name, { at, appVersion, current, signal, fetchImpl = fetch }) {
  // Never a cached copy: browsers may keep the site's files for hours.
  const res = await fetchImpl(`${at}/version.json?t=${Date.now()}`, {
    signal,
    redirect: 'follow',
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
  });
  if (res.status === 404) return { status: 'none' };
  if (!res.ok) throw new Error(`could not read version.json (${res.status})`);
  const build = parse(await res.json(), name, at);
  if (!isNewer(build, current)) return { status: 'current', build };
  if (compareVersions(appVersion, build.minDesktop) < 0) return { status: 'needs-app', build };

  const siteDir = path.join(dir, name);
  fs.mkdirSync(siteDir, { recursive: true });
  const archive = path.join(siteDir, `${build.id}.tar.gz.part`);
  const pieces = build.parts.map((p) => path.join(siteDir, `${p.file}.part`));
  const staging = path.join(siteDir, `${build.id}.new`);
  const target = path.join(siteDir, build.id);
  try {
    // A part missing means a newer deploy replaced this one meanwhile: the next check gets it.
    for (const [i, p] of build.parts.entries()) {
      await download(p.url, pieces[i], { size: p.size, sha256: p.sha256, signal, fetchImpl });
    }
    await join(pieces, archive, build.sha256);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await untar(archive, staging);
    const info = readJson(path.join(staging, '.build-info.json'));
    if (info?.commit !== build.commit || info?.name !== name) throw new Error('the archive does not match version.json');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    fs.writeFileSync(path.join(siteDir, 'current.json'), `${JSON.stringify({ id: build.id }, null, 2)}\n`);
    return { status: 'ready', build, info };
  } finally {
    for (const f of [archive, ...pieces]) fs.rmSync(f, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { activate, check, parse, isNewer, compareVersions };
