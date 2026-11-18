'use strict';
/**
 * One folder on this computer that Clew may use — `Documents/Clew` by default — and nothing
 * outside it. Clew keeps an encrypted copy of each vault there, beside its cloud (Clew's
 * `docs/44`, `@clew/sync` `FolderCopy`).
 *
 * Every path Clew gives is relative to the root and `/`-separated; anything that could leave the
 * root is refused — `..`, an absolute path, a drive, a backslash — and so is a path that would
 * reach outside it through a link already on disk. A write lands whole or not at all: the bytes
 * go to a temporary file beside the target, flushed to disk, which is then renamed over it.
 *
 * Plain Node: the IPC that reaches it is `folder-ipc.js`.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

/** Large enough for any record or blob chunk Clew writes (chunks are 1 MiB). */
const MAX_WRITE = 64 * 1024 * 1024;
const TEMP_SUFFIX = '.clew-tmp';

class FolderError extends Error {}

function createFolder(rootDir) {
  const root = path.resolve(rootDir);

  /** A relative, `/`-separated path → an absolute one inside the root. */
  function locate(rel, { allowRoot = false } = {}) {
    if (typeof rel !== 'string' || rel.includes('\0')) throw new FolderError('not a path');
    if (rel.startsWith('/') || rel.includes('\\') || /^[a-zA-Z]:/.test(rel)) {
      throw new FolderError(`not a relative path: ${rel}`);
    }
    const parts = rel.split('/').filter((p) => p !== '');
    if (parts.some((p) => p === '.' || p === '..')) throw new FolderError(`not allowed: ${rel}`);
    if (parts.length === 0 && !allowRoot) throw new FolderError('no file named');
    const abs = path.join(root, ...parts);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new FolderError(`outside the folder: ${rel}`);
    return abs;
  }

  /** Refuses a path whose nearest existing part resolves, through a link, outside the root. */
  async function staysInside(abs) {
    const realRoot = await fs.realpath(root).catch(() => root);
    for (let p = abs; ; p = path.dirname(p)) {
      try {
        const real = await fs.realpath(p);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new FolderError('outside the folder');
        }
        return;
      } catch (err) {
        if (err instanceof FolderError || err.code !== 'ENOENT') throw err;
        if (path.dirname(p) === p || p === root) return;
      }
    }
  }

  async function list(dir = '', opts = {}) {
    const recursive = opts.recursive !== false;
    const base = locate(dir, { allowRoot: true });
    await staysInside(base);
    const out = [];
    const walk = async (abs, rel) => {
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (err) {
        // The root itself not made yet is an empty folder; any other folder missing is ENOENT.
        if (err.code === 'ENOENT' && abs === root) return;
        throw err;
      }
      for (const entry of entries) {
        // Links are not followed, and a half-written file is not there yet.
        if (entry.isSymbolicLink() || entry.name.endsWith(TEMP_SUFFIX)) continue;
        const childAbs = path.join(abs, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (recursive) await walk(childAbs, childRel);
          else out.push({ path: childRel, dir: true, size: 0, modified: (await fs.stat(childAbs)).mtime.toISOString() });
        } else if (entry.isFile()) {
          const st = await fs.stat(childAbs);
          out.push({ path: childRel, dir: false, size: st.size, modified: st.mtime.toISOString() });
        }
      }
    };
    await walk(base, '');
    return out;
  }

  async function read(rel) {
    const abs = locate(rel);
    await staysInside(abs);
    return new Uint8Array(await fs.readFile(abs));
  }

  async function write(rel, bytes) {
    if (!(bytes instanceof Uint8Array)) throw new FolderError('not bytes');
    if (bytes.length > MAX_WRITE) throw new FolderError('too large');
    const abs = locate(rel);
    await staysInside(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const temp = `${abs}.${crypto.randomBytes(4).toString('hex')}${TEMP_SUFFIX}`;
    try {
      // On disk before the rename: a power cut right after it would otherwise leave an empty
      // file under the real name.
      const handle = await fs.open(temp, 'w');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, abs);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
  }

  /** Removes a file, then any folder it leaves empty, up to the root. A file already gone is fine. */
  async function remove(rel) {
    const abs = locate(rel);
    await staysInside(abs);
    await fs.rm(abs, { force: true });
    for (let dir = path.dirname(abs); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return; // not empty, or gone
      }
    }
  }

  return { root, locate, list, read, write, remove };
}

module.exports = { createFolder, FolderError, MAX_WRITE };
