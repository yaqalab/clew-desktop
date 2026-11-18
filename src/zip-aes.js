'use strict';
/**
 * Encrypted zip files: WinZip AES-256 (AE-2), deflated, ZIP64 when sizes need it. 7-Zip, WinZip,
 * macOS's Archive Utility (recent versions), `bsdtar` and most archivers open them with the
 * passphrase; Windows Explorer's own zip support does not.
 *
 * Format (APPNOTE.TXT 6.3.10; WinZip's AES specification):
 * - method 99 with a 0x9901 extra field (AE-2, "AE", strength 3 = AES-256, the real method 8);
 *   CRC-32 is 0 in AE-2, the HMAC stands in for it;
 * - per entry: salt (16 bytes) · password verifier (2) · AES-256-CTR data · HMAC-SHA1 (10);
 *   keys from PBKDF2-HMAC-SHA1, 1000 rounds, 66 bytes: AES key, HMAC key, verifier;
 * - CTR as WinZip does it: a 128-bit little-endian counter starting at 1.
 *
 * Plain Node; `writeZip` streams each file (nothing whole in memory), `verifyZip` reads one back
 * entry by entry and checks the passphrase, every HMAC and every size.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, Writable } = require('node:stream');

const SALT = 16;
const MAC = 10;
const ROUNDS = 1000;
const MAX32 = 0xffffffff;

/**
 * Archivers do not agree on how a passphrase becomes bytes: 7-Zip uses the system's legacy code
 * page (and refuses what it cannot convert), WinZip and others UTF-8. Printable ASCII is the
 * same in all of them, so only that is accepted.
 */
function passphraseProblem(passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) return 'no passphrase';
  if (!/^[\x20-\x7e]+$/.test(passphrase)) {
    return 'use letters without accents, digits, spaces and punctuation only: other characters open differently in different archivers';
  }
  return null;
}

function deriveKeys(passphrase, salt) {
  const dk = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, ROUNDS, 66, 'sha1');
  return { aes: dk.subarray(0, 32), mac: dk.subarray(32, 64), verifier: dk.subarray(64, 66) };
}

/** AES-256-CTR with WinZip's little-endian counter, from 1; the same both ways. */
function ctrTransform(key) {
  const ecb = () => {
    const c = crypto.createCipheriv('aes-256-ecb', key, null);
    c.setAutoPadding(false);
    return c;
  };
  const cipher = ecb();
  let counter = 1n;
  let stream = Buffer.alloc(0); // keystream left over from the last block
  return (chunk) => {
    const need = chunk.length - stream.length;
    if (need > 0) {
      const blocks = Math.ceil(need / 16);
      const counters = Buffer.alloc(blocks * 16);
      for (let i = 0; i < blocks; i++) {
        let n = counter++;
        for (let b = 0; b < 16 && n > 0n; b++, n >>= 8n) counters[i * 16 + b] = Number(n & 0xffn);
      }
      stream = Buffer.concat([stream, cipher.update(counters)]);
    }
    const out = Buffer.allocUnsafe(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] ^ stream[i];
    stream = stream.subarray(chunk.length);
    return out;
  };
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function aesExtra() {
  const b = Buffer.alloc(11);
  b.writeUInt16LE(0x9901, 0);
  b.writeUInt16LE(7, 2);
  b.writeUInt16LE(2, 4); // AE-2
  b.write('AE', 6, 'latin1');
  b.writeUInt8(3, 8); // AES-256
  b.writeUInt16LE(8, 9); // deflate
  return b;
}

/**
 * Writes `entries` into an encrypted zip at `file` (replaced if there).
 * @param {string} file
 * @param {Array<{ name: string, path?: string, data?: Buffer, mtime?: Date }>} entries  `name`
 *        inside the zip (`/`-separated; ending in `/` for a folder), from a file or from bytes
 * @param {string} passphrase
 * @param {{ onProgress?: (p: { done: number, total: number, bytes: number }) => void }} [opts]
 * @returns {Promise<{ entries: number, bytes: number }>}  `bytes`: the files' own size
 */
async function writeZip(file, entries, passphrase, { onProgress } = {}) {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const fd = await fsp.open(file, 'w');
  let offset = 0;
  const central = [];
  let bytes = 0;
  const write = async (buf, at = null) => {
    await fd.write(buf, 0, buf.length, at ?? offset);
    if (at === null) offset += buf.length;
  };
  try {
    let done = 0;
    for (const entry of entries) {
      const dir = entry.name.endsWith('/');
      const name = Buffer.from(entry.name, 'utf8');
      const { time, date } = dosDateTime(entry.mtime);
      const headerAt = offset;
      // Local header: ZIP64 extra always (sizes patched in after the data), then the AES extra.
      const z64 = Buffer.alloc(20);
      z64.writeUInt16LE(0x0001, 0);
      z64.writeUInt16LE(16, 2);
      const aes = dir ? Buffer.alloc(0) : aesExtra();
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(45, 4);
      local.writeUInt16LE(dir ? 0x0800 : 0x0801, 6); // UTF-8 names; encrypted
      local.writeUInt16LE(dir ? 0 : 99, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // CRC: 0 in AE-2
      local.writeUInt32LE(MAX32, 18);
      local.writeUInt32LE(MAX32, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(z64.length + aes.length, 28);
      await write(Buffer.concat([local, name, z64, aes]));
      const z64At = headerAt + 30 + name.length + 4;

      let size = 0;
      let csize = 0;
      if (!dir) {
        const salt = crypto.randomBytes(SALT);
        const keys = deriveKeys(passphrase, salt);
        await write(Buffer.concat([salt, keys.verifier]));
        const xor = ctrTransform(keys.aes);
        const hmac = crypto.createHmac('sha1', keys.mac);
        let pending = Promise.resolve();
        const encrypt = new Transform({
          transform(chunk, _enc, cb) {
            const out = xor(chunk);
            hmac.update(out);
            cb(null, out);
          },
        });
        const sink = new Writable({
          write(chunk, _enc, cb) {
            csize += chunk.length;
            pending = pending.then(() => write(chunk));
            pending.then(() => cb(), cb);
          },
        });
        const count = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            cb(null, chunk);
          },
        });
        const source = entry.data !== undefined ? [Buffer.from(entry.data)] : fs.createReadStream(entry.path);
        await pipeline(source, count, zlib.createDeflateRaw({ level: 6 }), encrypt, sink);
        await pending;
        await write(hmac.digest().subarray(0, MAC));
        csize += SALT + 2 + MAC;
      }
      const sizes = Buffer.alloc(16);
      sizes.writeBigUInt64LE(BigInt(size), 0);
      sizes.writeBigUInt64LE(BigInt(csize), 8);
      await write(sizes, z64At);
      central.push({ name, time, date, dir, size, csize, headerAt });
      bytes += size;
      done++;
      onProgress?.({ done, total: entries.length, bytes });
    }

    // Central directory: ZIP64 fields only where a value does not fit.
    const cdAt = offset;
    for (const e of central) {
      const big = [];
      if (e.size >= MAX32) big.push(e.size);
      if (e.csize >= MAX32) big.push(e.csize);
      if (e.headerAt >= MAX32) big.push(e.headerAt);
      let z64 = Buffer.alloc(0);
      if (big.length) {
        z64 = Buffer.alloc(4 + 8 * big.length);
        z64.writeUInt16LE(0x0001, 0);
        z64.writeUInt16LE(8 * big.length, 2);
        big.forEach((v, i) => z64.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      }
      const aes = e.dir ? Buffer.alloc(0) : aesExtra();
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, 4.5
      h.writeUInt16LE(45, 6);
      h.writeUInt16LE(e.dir ? 0x0800 : 0x0801, 8);
      h.writeUInt16LE(e.dir ? 0 : 99, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(0, 16);
      h.writeUInt32LE(Math.min(e.csize, MAX32), 20);
      h.writeUInt32LE(Math.min(e.size, MAX32), 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(z64.length + aes.length, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(e.dir ? 0x10 : 0, 38); // a folder's DOS attribute
      h.writeUInt32LE(Math.min(e.headerAt, MAX32), 42);
      await write(Buffer.concat([h, e.name, z64, aes]));
    }
    const cdSize = offset - cdAt;
    const needs64 = central.length >= 0xffff || cdAt >= MAX32 || cdSize >= MAX32;
    if (needs64) {
      const at = offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(central.length), 24);
      r.writeBigUInt64LE(BigInt(central.length), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdAt), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(at), 8);
      loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(central.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(central.length, 0xffff), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdAt, MAX32), 16);
    await write(end);
    await fd.sync();
  } finally {
    await fd.close();
  }
  return { entries: central.length, bytes };
}

/** The central directory: `{ name, method, size, csize, headerAt, aes }` per entry. */
async function readDirectory(fd, fileSize) {
  const tailLen = Math.min(fileSize, 22 + 0xffff + 20);
  const tail = Buffer.alloc(tailLen);
  await fd.read(tail, 0, tailLen, fileSize - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdAt = tail.readUInt32LE(eocd + 16);
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
    const recAt = Number(tail.readBigUInt64LE(eocd - 20 + 8));
    const rec = Buffer.alloc(56);
    await fd.read(rec, 0, 56, recAt);
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdAt = Number(rec.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize);
  await fd.read(cd, 0, cdSize, cdAt);
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('broken central directory');
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let headerAt = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    let aes = null;
    for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let y = x + 4;
        if (size === MAX32) (size = Number(cd.readBigUInt64LE(y))), (y += 8);
        if (csize === MAX32) (csize = Number(cd.readBigUInt64LE(y))), (y += 8);
        if (headerAt === MAX32) headerAt = Number(cd.readBigUInt64LE(y));
      } else if (id === 0x9901) {
        aes = { strength: cd.readUInt8(x + 8), method: cd.readUInt16LE(x + 9) };
      }
      x += 4 + len;
    }
    out.push({ name, method, size, csize, headerAt, aes });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

class WrongPassphrase extends Error {}

/**
 * Reads a zip from `writeZip` back with the passphrase: every entry decrypted, its HMAC checked,
 * inflated, its size compared. `onEntry(name, bytes)` may look at each file (small ones only:
 * `bytes` is the whole file).
 * @returns {Promise<{ entries: number, bytes: number }>}
 */
async function verifyZip(file, passphrase, { onEntry } = {}) {
  const fd = await fsp.open(file, 'r');
  try {
    const { size: fileSize } = await fd.stat();
    const list = await readDirectory(fd, fileSize);
    let bytes = 0;
    for (const e of list) {
      if (e.name.endsWith('/')) continue;
      if (e.method !== 99 || !e.aes || e.aes.strength !== 3) throw new Error(`${e.name}: not AES-256`);
      const lh = Buffer.alloc(30);
      await fd.read(lh, 0, 30, e.headerAt);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`${e.name}: broken local header`);
      let at = e.headerAt + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const head = Buffer.alloc(SALT + 2);
      await fd.read(head, 0, head.length, at);
      at += head.length;
      const keys = deriveKeys(passphrase, head.subarray(0, SALT));
      if (!keys.verifier.equals(head.subarray(SALT))) throw new WrongPassphrase('wrong passphrase');
      const dataLen = e.csize - SALT - 2 - MAC;
      const xor = ctrTransform(keys.aes);
      const hmac = crypto.createHmac('sha1', keys.mac);
      const inflate = zlib.createInflateRaw();
      const parts = [];
      let size = 0;
      inflate.on('data', (c) => {
        size += c.length;
        if (onEntry) parts.push(c);
      });
      const ended = new Promise((resolve, reject) => {
        inflate.on('end', resolve);
        inflate.on('error', reject);
      });
      const chunk = Buffer.alloc(1 << 20);
      for (let left = dataLen; left > 0; ) {
        const n = Math.min(left, chunk.length);
        const { bytesRead } = await fd.read(chunk, 0, n, at);
        if (!bytesRead) throw new Error(`${e.name}: cut short`);
        const enc = chunk.subarray(0, bytesRead);
        hmac.update(enc);
        if (!inflate.write(xor(enc))) await new Promise((r) => inflate.once('drain', r));
        at += bytesRead;
        left -= bytesRead;
      }
      inflate.end();
      await ended;
      const mac = Buffer.alloc(MAC);
      await fd.read(mac, 0, MAC, at);
      if (!hmac.digest().subarray(0, MAC).equals(mac)) throw new Error(`${e.name}: damaged (authentication failed)`);
      if (size !== e.size) throw new Error(`${e.name}: ${size} bytes, expected ${e.size}`);
      bytes += size;
      onEntry?.(e.name, Buffer.concat(parts));
    }
    return { entries: list.length, bytes };
  } finally {
    await fd.close();
  }
}

module.exports = { writeZip, verifyZip, WrongPassphrase, passphraseProblem };
