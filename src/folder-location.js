'use strict';
/**
 * Where Clew's folder (`Documents/Clew` by default, `folder.js`) lives: whether a cloud drive
 * syncs it, and moving it somewhere else.
 *
 * The folder holds Clew's encrypted copy of each vault. The contents are encrypted, but a cloud
 * drive still sees the files' names, sizes and times, and keeps them in its own history: worth
 * saying once, and worth a way out.
 *
 * Plain Node, so it runs under `node --test`.
 */
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');

/** Same path, ignoring case on Windows and macOS (their usual file systems do). */
function samePath(a, b, platform = process.platform) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** `child` is `parent` or inside it. */
function inside(child, parent, platform = process.platform) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (samePath(c, p, platform)) return true;
  const rel = path.relative(p, c);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The cloud drive that syncs `dir`, or null: OneDrive (its folders from the environment, as
 * Windows sets them), iCloud Drive (macOS: the folder itself, or Desktop & Documents synced),
 * Dropbox, Google Drive, by their usual folder names.
 *
 * @param {string} dir
 * @param {{ env?: object, platform?: string, home?: string, exists?: (p: string) => boolean }} [opts]
 */
function syncedBy(dir, { env = process.env, platform = process.platform, home = require('node:os').homedir(), exists = fss.existsSync } = {}) {
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (env[key] && inside(dir, env[key], platform)) return 'OneDrive';
  }
  if (platform === 'darwin' && home) {
    const mobile = path.join(home, 'Library', 'Mobile Documents');
    if (inside(dir, mobile, platform)) return 'iCloud Drive';
    // Desktop & Documents in iCloud: ~/Documents is synced, and iCloud Drive has a Documents.
    const docs = path.join(home, 'Documents');
    if (inside(dir, docs, platform) && exists(path.join(mobile, 'com~apple~CloudDocs', 'Documents'))) return 'iCloud Drive';
  }
  const parts = path.resolve(dir).split(/[\\/]/).map((p) => p.toLowerCase());
  if (parts.some((p) => p === 'onedrive' || p.startsWith('onedrive - '))) return 'OneDrive';
  if (parts.some((p) => p === 'dropbox' || p.startsWith('dropbox ('))) return 'Dropbox';
  if (parts.some((p) => p === 'google drive' || p === 'my drive' || p.startsWith('googledrive'))) return 'Google Drive';
  return null;
}

class MoveError extends Error {}

/** Every file under `dir`, relative, with its size; links are not followed. */
async function filesOf(dir) {
  const out = new Map();
  const walk = async (abs, rel) => {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' && abs === dir) return;
      throw err;
    }
    for (const e of entries) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(a, r);
      else if (e.isFile()) out.set(r, (await fs.stat(a)).size);
    }
  };
  await walk(dir, '');
  return out;
}

/**
 * Where the folder would go when the user picks `chosen`: the chosen folder itself when it is
 * empty or missing, else a `Clew` folder inside it. Refuses the folder itself, a place inside it,
 * a place it is inside of, and a `Clew` that already holds files.
 */
async function moveTarget(from, chosen, platform = process.platform) {
  if (!chosen || !path.isAbsolute(chosen)) throw new MoveError('Choose a folder.');
  let target = path.resolve(chosen);
  const entries = await fs.readdir(target).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  if (entries.length && !samePath(target, from, platform)) target = path.join(target, 'Clew');
  if (samePath(target, from, platform)) throw new MoveError('Clew’s folder is already there.');
  if (inside(target, from, platform)) throw new MoveError('The new place is inside Clew’s folder.');
  if (inside(from, target, platform)) throw new MoveError('Clew’s folder is inside the new place.');
  const there = await fs.readdir(target).catch(() => []);
  if (there.length) throw new MoveError(`${target} already holds files: choose an empty folder.`);
  return target;
}

/**
 * Copies every file from `from` to `to`, checks that each arrived whole (same size), then removes
 * `from`. Nothing is removed unless the copy is complete; a failed copy removes what it made.
 * @returns {Promise<{ files: number, bytes: number, leftBehind: string | null }>}
 */
async function moveFolder(from, to) {
  const before = await filesOf(from);
  const made = !fss.existsSync(to);
  try {
    await fs.mkdir(to, { recursive: true });
    // Entry by entry: the target may exist (an empty folder the user chose), which some Node
    // versions' `cp` refuses outright with errorOnExist.
    const top = await fs.readdir(from).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
    for (const name of top) {
      await fs.cp(path.join(from, name), path.join(to, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    const after = await filesOf(to);
    for (const [rel, size] of before) {
      if (after.get(rel) !== size) throw new MoveError(`${rel} did not copy whole`);
    }
  } catch (err) {
    if (made) await fs.rm(to, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  let leftBehind = null;
  try {
    await fs.rm(from, { recursive: true, force: true });
  } catch {
    // Copied and in use from the new place; the old copy stays for the user to remove.
    leftBehind = from;
  }
  let bytes = 0;
  for (const size of before.values()) bytes += size;
  return { files: before.size, bytes, leftBehind };
}

module.exports = { syncedBy, moveTarget, moveFolder, MoveError, samePath, inside };
