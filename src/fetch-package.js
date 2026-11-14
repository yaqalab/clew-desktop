'use strict';
/**
 * Downloads a package of known size and SHA-256 and unpacks it: what the dictation install and
 * the site updates share. Plain Node: no Electron here.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

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
 * Downloads `url` into the file `to`: stops as soon as it is larger than `size`, and must end
 * exactly at `size` with the given SHA-256. The file is removed if anything is wrong.
 */
async function download(url, to, { size, sha256, signal, fetchImpl = fetch, onProgress = () => {} }) {
  const res = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`could not download ${path.basename(to)} (${res.status})`);
  const hash = crypto.createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(to);
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      if (received > size) throw new Error('the download is larger than announced');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress({ received, size });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (received !== size) throw new Error('the download is incomplete');
    if (hash.digest('hex') !== sha256) throw new Error('the download does not match its SHA-256');
  } catch (err) {
    out.destroy();
    fs.rmSync(to, { force: true });
    throw err;
  }
}

module.exports = { download, untar, TAR };
