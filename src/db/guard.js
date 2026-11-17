'use strict';
/**
 * Which statements a page may run on its database. Checked on the text, before SQLite sees it:
 * the cipher library acts on `PRAGMA key`, `rekey` and `cipher` while a statement is being
 * prepared, not when it runs, so preparing one is already too late (even under `EXPLAIN`).
 *
 * The check is an allow-list of what a statement starts with. A statement's kind is fixed by
 * its first keyword, and the store prepares one statement at a time (more is an error), so
 * nothing else can follow. What is left out: ATTACH and DETACH (another file), VACUUM (VACUUM
 * INTO writes a file anywhere), BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT and RELEASE (`batch` is
 * the only transaction), and every PRAGMA not listed below.
 *
 * `opcodesRefused` is the second look, once the statement is known to be safe to prepare: what
 * SQLite compiled it to, whatever the text looked like.
 */

const STATEMENTS = new Set([
  'select', 'values', 'with', 'insert', 'replace', 'update', 'delete',
  'create', 'drop', 'alter', 'analyze', 'reindex', 'explain', 'pragma',
]);

/** Read-only, or harmless to set. The cipher's pragmas, journal_mode and the like are the app's. */
const PRAGMAS = new Set([
  'user_version', 'foreign_keys', 'table_info', 'table_xinfo', 'table_list', 'index_list',
  'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'integrity_check',
  'quick_check', 'optimize',
]);

class Refused extends Error {
  constructor(message) {
    super(message);
    this.code = 'refused';
  }
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
// SQLite's identifier characters; anything at or above 0x80 counts as one too.
const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/**
 * SQLite's tokens, as far as this check needs them: words, quoted names or strings, and single
 * punctuation characters. Whitespace and comments are skipped as SQLite skips them.
 * @returns {{ type: 'word' | 'quoted' | 'punct', text: string }[]}
 */
function tokens(sql, max = 8) {
  const out = [];
  let i = 0;
  while (i < sql.length && out.length < max) {
    const c = sql[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) {
          j = sql.length;
          break;
        }
        // A doubled quote is an escaped one (not for [...]).
        if (close !== ']' && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      out.push({ type: 'quoted', text: sql.slice(i, j) });
      i = j;
    } else if (isWordChar(c)) {
      let j = i + 1;
      while (j < sql.length && isWordChar(sql[j])) j++;
      out.push({ type: 'word', text: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ type: 'punct', text: c });
      i++;
    }
  }
  return out;
}

const word = (t) => (t && t.type === 'word' ? t.text.toLowerCase() : null);

/**
 * Throws `Refused` unless a page may run this statement.
 * @returns {{ explain: boolean }}  whether it is an EXPLAIN (which never runs its statement)
 */
function check(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Refused('an SQL statement is required');
  const t = tokens(sql);
  let at = 0;
  let explain = false;
  if (word(t[0]) === 'explain') {
    explain = true;
    at = 1;
    if (word(t[1]) === 'query' && word(t[2]) === 'plan') at = 3;
  }
  const kind = word(t[at]);
  if (!kind || !STATEMENTS.has(kind) || kind === 'explain') {
    throw new Refused(`statement not allowed: ${t[at] ? t[at].text : '(none)'}`);
  }
  if (kind === 'pragma') {
    let name = t[at + 1];
    // PRAGMA main.name
    if (t[at + 2]?.type === 'punct' && t[at + 2].text === '.') {
      if (word(name) !== 'main') throw new Refused('PRAGMA only on the main database');
      name = t[at + 3];
    }
    // A quoted name is refused too: SQLite would accept PRAGMA "rekey".
    if (!word(name) || !PRAGMAS.has(word(name))) {
      throw new Refused(`PRAGMA not allowed: ${name ? name.text : '(none)'}`);
    }
  }
  return { explain };
}

/**
 * The second look: SQLite's own compiled program (`EXPLAIN` rows). Anything that attaches,
 * vacuums, or starts or ends a transaction is refused, whatever the text looked like.
 * @param {{ opcode: string, p4: unknown }[]} program
 * @returns {string | null}  what was found, or null
 */
function opcodesRefused(program) {
  for (const { opcode, p4 } of program) {
    if (opcode === 'Vacuum' || opcode === 'AutoCommit' || opcode === 'Savepoint' || opcode === 'JournalMode') {
      return opcode;
    }
    if (opcode === 'Function' && /^sqlite_(attach|detach)\b/i.test(String(p4))) return String(p4);
  }
  return null;
}

module.exports = { check, opcodesRefused, tokens, Refused, PRAGMAS, STATEMENTS };
