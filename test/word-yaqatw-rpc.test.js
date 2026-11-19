'use strict';
/**
 * The yaqatw methods Word's host page calls (src/word-host/host.js) against yaqatw's
 * HostRpcServer (src/host/HostRpcServer.ts in yaqatw). Clew bundles yaqatw from GitHub: a method
 * renamed there, or not merged yet, breaks Word's menus only when someone clicks. Run with
 * YAQATW_PATH set to a yaqatw checkout (the one Clew is about to bundle); skipped otherwise.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'src', 'word-host', 'host.js'), 'utf8');
const YAQATW = process.env.YAQATW_PATH ? path.resolve(process.env.YAQATW_PATH) : '';
const SERVER = YAQATW ? path.join(YAQATW, 'src', 'host', 'HostRpcServer.ts') : '';

/** Every yaqatw method host.js names: its calls, and the methods its features need. */
function methodsHostCalls() {
  const called = [...HOST.matchAll(/\b(?:callPlugin|callNewer|callWriting)\('(\w+)'/g)].map((m) => m[1]);
  const block = /const FEATURES = \{([\s\S]*?)\n {2}\};/.exec(HOST);
  assert.ok(block, 'FEATURES in host.js');
  const needed = [...block[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  return [...new Set([...called, ...needed])].sort();
}

test('host.js names the yaqatw methods it calls in a form this test can read', () => {
  const names = methodsHostCalls();
  for (const m of ['getCapabilities', 'getHighlightDetails', 'deleteHighlight', 'getRelationshipMenu', 'insertCiteSource']) {
    assert.ok(names.includes(m), m);
  }
});

test('every yaqatw method host.js calls is in the yaqatw at YAQATW_PATH', { skip: !SERVER && 'YAQATW_PATH not set' }, () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  const answered = new Set([...source.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]));
  assert.ok(answered.size > 20, `methods read in ${SERVER}: ${answered.size}`);
  assert.deepEqual(
    methodsHostCalls().filter((m) => !answered.has(m)),
    [],
    `missing in ${SERVER}`,
  );
});
