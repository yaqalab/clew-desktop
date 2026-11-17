'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../src/db/store');

const HOST = 'clew.alefa.net';
const key = () => new Uint8Array(crypto.randomBytes(32));

function fresh(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-db-test-'));
  const store = new Store(root);
  t.after(() => {
    store.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

const code = (c) => (err) => err.code === c;

test('creates, writes and reads back; the file holds no plain text', (t) => {
  const { store } = fresh(t);
  const k = key();
  assert.deepEqual(store.open(HOST, 'vault-a', k), { created: true });
  store.run(HOST, 'vault-a', 'create table notes (id integer primary key, body text, data blob)');
  const r = store.run(HOST, 'vault-a', 'insert into notes (body, data) values (?, ?)', ['secret-text', new Uint8Array([1, 2, 250])]);
  assert.equal(r.changes, 1);
  const rows = store.query(HOST, 'vault-a', 'select body, data from notes where id = :id', { id: r.lastInsertRowid });
  assert.equal(rows[0].body, 'secret-text');
  assert.deepEqual([...rows[0].data], [1, 2, 250]);
  const file = store.file(HOST, 'vault-a');
  assert.ok(file.endsWith(path.join('clew.alefa.net', 'vault-a.db')));
  store.close(HOST, 'vault-a');
  assert.equal(fs.readFileSync(file).includes('secret-text'), false);
  assert.notEqual(fs.readFileSync(file).subarray(0, 15).toString(), 'SQLite format 3');
});

test('a wrong key is caught at open; the right one opens', (t) => {
  const { store } = fresh(t);
  const k = key();
  store.open(HOST, 'v', k);
  store.run(HOST, 'v', 'create table t (x)');
  store.close(HOST, 'v');
  assert.throws(() => store.open(HOST, 'v', key()), code('wrong-key'));
  assert.throws(() => store.query(HOST, 'v', 'select 1'), code('locked'));
  store.open(HOST, 'v', k);
  assert.deepEqual(store.query(HOST, 'v', 'select count(*) n from t'), [{ n: 0 }]);
  // Open already: the same key shares it, another is refused.
  assert.deepEqual(store.open(HOST, 'v', k), { created: false });
  assert.throws(() => store.open(HOST, 'v', key()), code('wrong-key'));
});

test('each database has its own key', (t) => {
  const { store } = fresh(t);
  const ka = key();
  const kb = key();
  store.open(HOST, 'a', ka);
  store.open(HOST, 'b', kb);
  store.close(HOST, 'a');
  store.close(HOST, 'b');
  assert.throws(() => store.open(HOST, 'a', kb), code('wrong-key'));
  assert.doesNotThrow(() => store.open(HOST, 'a', ka));
});

test('names, hosts and keys are checked', (t) => {
  const { store } = fresh(t);
  for (const name of ['../x', 'A', '', 'a.b', 'a/b', 'x'.repeat(65), null]) {
    assert.throws(() => store.open(HOST, name, key()), code('bad-name'), String(name));
  }
  for (const host of ['..', '../x', 'a/b', '.hidden']) assert.throws(() => store.open(host, 'v', key()), code('bad-name'), host);
  assert.ok(store.file('localhost:5173', 'v').includes('localhost_5173'));
  assert.throws(() => store.open(HOST, 'v', new Uint8Array(16)), code('bad-key'));
  assert.throws(() => store.open(HOST, 'v', 'a passphrase'), code('bad-key'));
});

test('statements that leave the database are refused, and nothing is created', (t) => {
  const { root, store } = fresh(t);
  store.open(HOST, 'v', key());
  const other = path.join(root, 'other.db').replace(/\\/g, '/');
  for (const sql of [
    `attach '${other}' as o`,
    `vacuum into '${other}'`,
    'vacuum',
    'begin',
    "pragma rekey = 'x'",
    "pragma cipher = 'chacha20'",
    'pragma journal_mode = delete',
  ]) {
    assert.throws(() => store.run(HOST, 'v', sql), code('refused'), sql);
  }
  assert.equal(fs.existsSync(other), false);
  assert.throws(() => store.query(HOST, 'v', "select sqlite3mc_config('default:cipher', 'chacha20')"), code('sqlite'));
  assert.throws(() => store.query(HOST, 'v', "select sqlite3mc_codec_data('cipher_salt')"), code('sqlite'));
  assert.throws(() => store.query(HOST, 'v', "select load_extension('x')"), code('sqlite'));
  assert.deepEqual(store.query(HOST, 'v', 'pragma user_version'), [{ user_version: 0 }]);
  store.run(HOST, 'v', 'pragma user_version = 7');
  assert.deepEqual(store.query(HOST, 'v', 'pragma user_version'), [{ user_version: 7 }]);
});

test('batch is all or nothing', (t) => {
  const { store } = fresh(t);
  store.open(HOST, 'v', key());
  const r = store.batch(HOST, 'v', [
    { sql: 'create table t (x unique)' },
    { sql: 'insert into t values (?)', params: [1] },
    { sql: 'select x from t' },
  ]);
  assert.deepEqual(r[2], { rows: [{ x: 1 }] });
  assert.throws(() =>
    store.batch(HOST, 'v', [
      { sql: 'insert into t values (?)', params: [2] },
      { sql: 'insert into t values (?)', params: [1] }, // duplicate: the whole batch goes
    ]),
  );
  assert.deepEqual(store.query(HOST, 'v', 'select x from t order by x'), [{ x: 1 }]);
  // A refused statement anywhere stops the batch before anything runs.
  assert.throws(() => store.batch(HOST, 'v', [{ sql: 'insert into t values (3)' }, { sql: 'commit' }]), code('refused'));
  assert.deepEqual(store.query(HOST, 'v', 'select count(*) n from t'), [{ n: 1 }]);
});

test('full-text search and JSON are there', (t) => {
  const { store } = fresh(t);
  store.open(HOST, 'v', key());
  store.batch(HOST, 'v', [
    { sql: 'create virtual table f using fts5(body)' },
    { sql: 'insert into f values (?)', params: ['the clew of thread through the labyrinth'] },
  ]);
  assert.equal(store.query(HOST, 'v', "select count(*) n from f where f match 'labyrinth'")[0].n, 1);
  assert.equal(store.query(HOST, 'v', `select json_extract('{"a":2}', '$.a') v`)[0].v, 2);
});

test('rekey: the old key stops working, the new one opens', (t) => {
  const { store } = fresh(t);
  const k1 = key();
  const k2 = key();
  store.open(HOST, 'v', k1);
  store.run(HOST, 'v', 'create table t (x)');
  store.run(HOST, 'v', "insert into t values ('kept')");
  store.rekey(HOST, 'v', k2);
  store.close(HOST, 'v');
  assert.throws(() => store.open(HOST, 'v', k1), code('wrong-key'));
  store.open(HOST, 'v', k2);
  assert.deepEqual(store.query(HOST, 'v', 'select x from t'), [{ x: 'kept' }]);
});

test('list and remove', (t) => {
  const { store } = fresh(t);
  assert.deepEqual(store.list(HOST), []);
  store.open(HOST, 'a', key());
  store.open(HOST, 'b', key());
  store.close(HOST, 'b');
  const listed = store.list(HOST).map((d) => `${d.name}:${d.open}`).sort();
  assert.deepEqual(listed, ['a:true', 'b:false']);
  assert.throws(() => store.remove(HOST, 'a'), code('in-use'));
  store.remove(HOST, 'b');
  assert.deepEqual(store.list(HOST).map((d) => d.name), ['a']);
  assert.deepEqual(store.list('yaqatw.alefa.net'), []);
});

test('info names the engine', (t) => {
  const { store } = fresh(t);
  const info = store.info();
  assert.equal(info.api, 1);
  assert.equal(info.engine, 'sqlcipher');
  assert.match(info.sqlite, /^3\.\d+/);
  assert.ok(info.cipher);
});
