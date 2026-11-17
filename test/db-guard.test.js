'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { check, opcodesRefused, tokens } = require('../src/db/guard');

const allowed = [
  'select 1',
  '  SELECT * FROM t WHERE x = ?',
  'with a as (select 1) select * from a',
  'insert into t values (1)',
  'replace into t values (1)',
  "update t set x = 'pragma key'",
  'delete from t',
  'create table t (x)',
  'create virtual table f using fts5(body)',
  'create trigger tr after insert on t begin update t set x = 1; end',
  'drop table t',
  'alter table t add column y',
  'values (1), (2)',
  'explain query plan select * from t',
  'explain select 1',
  '/* a comment */ select 1',
  '-- a comment\nselect 1',
  'pragma user_version',
  'PRAGMA user_version = 3',
  'pragma main.user_version',
  "pragma table_info('t')",
  'pragma /* c */ foreign_keys = on',
];

const refused = [
  "attach 'x.db' as o",
  "ATTACH DATABASE 'x.db' AS o",
  "/* c */ attach 'x.db' as o",
  "-- c\nattach 'x.db' as o",
  'detach o',
  'vacuum',
  "vacuum into 'y.db'",
  'begin',
  'BEGIN IMMEDIATE',
  'commit',
  'end',
  'rollback',
  'savepoint s',
  'release s',
  "pragma key = 'x'",
  "pragma rekey = 'x'",
  "PRAGMA cipher = 'chacha20'",
  "pragma \"rekey\" = 'x'",
  "pragma `key` = 'x'",
  "pragma [key] = 'x'",
  'pragma journal_mode = delete',
  'pragma writable_schema = on',
  'pragma temp.user_version',
  "pragma o.table_info('t')",
  "explain pragma rekey = 'x'",
  "explain query plan attach 'x' as o",
  'explain explain select 1',
  '; select 1',
  '"select" 1',
  ' select 1',
  '',
  '   ',
  '/* only a comment */',
  null,
  42,
];

test('allowed statements pass', () => {
  for (const sql of allowed) assert.doesNotThrow(() => check(sql), sql);
});

test('refused statements throw, with code "refused"', () => {
  for (const sql of refused) {
    assert.throws(() => check(sql), (err) => err.code === 'refused', String(sql));
  }
});

test('EXPLAIN is reported, so its program is not checked twice', () => {
  assert.equal(check('explain select 1').explain, true);
  assert.equal(check('select 1').explain, false);
});

test('tokens: quotes with doubled quotes, comments, words', () => {
  const t = tokens(`'it''s' "a""b" [x] -- c\n/* d */ w`).map((x) => `${x.type}:${x.text}`);
  assert.deepEqual(t, [`quoted:'it''s'`, 'quoted:"a""b"', 'quoted:[x]', 'word:w']);
});

test('opcodes: attach, detach, vacuum and transactions are found', () => {
  assert.equal(opcodesRefused([{ opcode: 'Function', p4: 'sqlite_attach(3)' }]), 'sqlite_attach(3)');
  assert.equal(opcodesRefused([{ opcode: 'Function', p4: 'sqlite_detach(1)' }]), 'sqlite_detach(1)');
  assert.equal(opcodesRefused([{ opcode: 'Vacuum', p4: null }]), 'Vacuum');
  assert.equal(opcodesRefused([{ opcode: 'AutoCommit', p4: null }]), 'AutoCommit');
  assert.equal(opcodesRefused([{ opcode: 'Savepoint', p4: 's' }]), 'Savepoint');
  assert.equal(opcodesRefused([{ opcode: 'Function', p4: 'upper(1)' }, { opcode: 'ResultRow', p4: null }]), null);
});
