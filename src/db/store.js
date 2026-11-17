'use strict';
/**
 * The encrypted databases of the bundled sites (SQLCipher 4 format, through SQLite3MultipleCiphers).
 * Runs in the database process (`worker.js`); nothing here knows about pages or windows.
 *
 * Layout: `<root>/<host>/<name>.db`, one folder per site, one file per database. The key comes
 * from the page each time a database is opened; it is held only while the database is open.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const guard = require('./guard');

const NAME = /^[a-z0-9_-]{1,64}$/;
const HOST = /^[a-z0-9.-]+(_[0-9]+)?$/;
const KEY_BYTES = 32;
/** Prepared statements kept per database, by their text. */
const CACHE_SIZE = 200;

class DbError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadDriver() {
  return require('better-sqlite3-multiple-ciphers');
}

/** `clew.alefa.net`, or `localhost_5173` for a host with a port (Windows has no `:` in names). */
function folderName(host) {
  const name = String(host).toLowerCase().replace(':', '_');
  if (!HOST.test(name) || name.startsWith('.')) throw new DbError('bad-name', `not a site: ${host}`);
  return name;
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new DbError('bad-name', 'a database name is 1 to 64 of a-z, 0-9, _ and -');
  }
  return name;
}

function checkKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new DbError('bad-key', `a key is ${KEY_BYTES} bytes (a Uint8Array)`);
  }
  return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
}

/** Uint8Array values (as they arrive over IPC) become Buffers, which is what binds as a BLOB. */
function bindable(params) {
  const conv = (v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(conv);
  if (typeof params === 'object') return [Object.fromEntries(Object.entries(params).map(([k, v]) => [k, conv(v)]))];
  throw new DbError('bad-args', 'parameters are an array or an object');
}

/** The key as SQLCipher's raw-key literal: hex only, so nothing in it can end the string. */
const rawKey = (buf) => `"x'${buf.toString('hex')}'"`;

function sqliteError(err) {
  if (err instanceof DbError) return err;
  if (err instanceof guard.Refused) return new DbError('refused', err.message);
  return new DbError('sqlite', err.message);
}

const deny = () => {
  throw new Error('not allowed');
};

class Store {
  /** @param {string} root  the `db` folder; made when the first database is */
  constructor(root, Driver = loadDriver()) {
    this.root = root;
    this.Driver = Driver;
    /** file → { db, key: Buffer, statements: Map<sql, Statement> } */
    this.open_ = new Map();
  }

  file(host, name) {
    return path.join(this.root, folderName(host), `${checkName(name)}.db`);
  }

  /** The engine, for `alefaDesktop.db.info()`. */
  info() {
    const db = new this.Driver(':memory:');
    try {
      return {
        api: 1,
        engine: 'sqlcipher',
        sqlite: db.prepare('select sqlite_version() v').get().v,
        cipher: db.prepare('select sqlite3mc_version() v').get().v,
      };
    } finally {
      db.close();
    }
  }

  list(host) {
    const dir = path.join(this.root, folderName(host));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.db') && NAME.test(n.slice(0, -3)))
      .map((n) => {
        const file = path.join(dir, n);
        const st = fs.statSync(file);
        return { name: n.slice(0, -3), size: st.size, modified: st.mtime.toISOString(), open: this.open_.has(file) };
      });
  }

  /**
   * Opens the database, creating it with this key if it does not exist. Already open: the key
   * must be the same, and the connection is shared.
   */
  open(host, name, key) {
    const file = this.file(host, name);
    const buf = checkKey(key);
    const held = this.open_.get(file);
    if (held) {
      if (!crypto.timingSafeEqual(held.key, buf)) throw new DbError('wrong-key', 'wrong key');
      return { created: false };
    }
    const created = !fs.existsSync(file);
    if (created) fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new this.Driver(file, { timeout: 5000 });
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma('legacy=4');
      db.pragma(`key=${rawKey(buf)}`);
      try {
        // SQLCipher only finds out about a wrong key when it first reads.
        db.prepare('select count(*) from sqlite_master').get();
      } catch (err) {
        if (err.code === 'SQLITE_NOTADB') throw new DbError('wrong-key', 'wrong key, or not a database');
        throw err;
      }
      db.pragma('journal_mode=WAL');
      db.pragma('foreign_keys=ON');
      // The cipher library's SQL functions would let a page change or read its settings.
      for (const fname of ['sqlite3mc_config', 'sqlite3mc_codec_data']) {
        for (const f of [() => deny(), (a) => deny(), (a, b) => deny(), (a, b, c) => deny()]) db.function(fname, f);
      }
    } catch (err) {
      db.close();
      if (created) removeFiles(file);
      throw sqliteError(err);
    }
    this.open_.set(file, { db, key: Buffer.from(buf), statements: new Map() });
    return { created };
  }

  held(host, name) {
    const held = this.open_.get(this.file(host, name));
    if (!held) throw new DbError('locked', 'the database is not open');
    return held;
  }

  /**
   * The prepared statement, checked: its text before it is prepared (`guard.check`), then the
   * program SQLite made of it (`EXPLAIN`, with the same parameters, which it needs bound).
   * Kept by its text, so each statement is checked once.
   */
  statement(held, sql, args) {
    let stmt = held.statements.get(sql);
    if (stmt) return stmt;
    const { explain } = guard.check(sql);
    stmt = held.db.prepare(sql);
    if (!explain) {
      const found = guard.opcodesRefused(held.db.prepare(`EXPLAIN ${sql}`).all(...args));
      if (found) throw new guard.Refused(`statement not allowed (${found})`);
    }
    if (held.statements.size >= CACHE_SIZE) held.statements.delete(held.statements.keys().next().value);
    held.statements.set(sql, stmt);
    return stmt;
  }

  query(host, name, sql, params) {
    const held = this.held(host, name);
    try {
      const args = bindable(params);
      return this.statement(held, sql, args).all(...args);
    } catch (err) {
      throw sqliteError(err);
    }
  }

  run(host, name, sql, params) {
    const held = this.held(host, name);
    try {
      const args = bindable(params);
      return result(this.statement(held, sql, args).run(...args));
    } catch (err) {
      throw sqliteError(err);
    }
  }

  /**
   * Several statements in one transaction: all or nothing. Rows for those that give rows.
   * Every text is checked before anything runs; each is prepared in turn inside the
   * transaction, so a statement can use a table made earlier in the same batch.
   */
  batch(host, name, items) {
    const held = this.held(host, name);
    if (!Array.isArray(items)) throw new DbError('bad-args', 'a batch is an array of { sql, params }');
    try {
      for (const it of items) guard.check(it?.sql);
      return held.db.transaction(() =>
        items.map(({ sql, params }) => {
          const args = bindable(params);
          const stmt = this.statement(held, sql, args);
          return stmt.reader ? { rows: stmt.all(...args) } : result(stmt.run(...args));
        }),
      )();
    } catch (err) {
      throw sqliteError(err);
    }
  }

  /** Re-encrypts the database with a new key. */
  rekey(host, name, newKey) {
    const held = this.held(host, name);
    const buf = checkKey(newKey);
    try {
      // The cipher library cannot rekey a database in WAL mode.
      held.db.pragma('journal_mode=DELETE');
      held.db.pragma(`rekey=${rawKey(buf)}`);
      held.db.pragma('journal_mode=WAL');
    } catch (err) {
      throw sqliteError(err);
    }
    held.key = Buffer.from(buf);
  }

  close(host, name) {
    const file = this.file(host, name);
    const held = this.open_.get(file);
    if (!held) return;
    this.open_.delete(file);
    held.key.fill(0);
    held.db.close();
  }

  /** Deletes a database's files; it must be closed. */
  remove(host, name) {
    const file = this.file(host, name);
    if (this.open_.has(file)) throw new DbError('in-use', 'the database is open');
    removeFiles(file);
  }

  closeAll() {
    for (const [file, held] of this.open_) {
      this.open_.delete(file);
      held.key.fill(0);
      try {
        held.db.close();
      } catch {
        // closing the rest matters more
      }
    }
  }
}

const result = (r) => ({ changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) });

function removeFiles(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}

module.exports = { Store, DbError, folderName, checkName, KEY_BYTES };
