'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createLocalApi, createClients } = require('../src/local-api');
const { createWordBridge } = require('../src/word-bridge');
const { KIND } = require('../src/word-plugin');

const quiet = { log() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The local API with the bridge's routes, a Word template client and another client. */
async function fresh(t, bridgeOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-word-bridge-test-'));
  const clients = createClients(path.join(dir, 'clients.json'));
  const seen = { opened: [], closed: [], events: [] };
  const bridge = createWordBridge({
    onOpen: (s, again, opts) => seen.opened.push({ ...s, again, ...(opts && opts.show === false ? { hidden: true } : {}) }),
    onClose: (s, by) => seen.closed.push({ ...s, by }),
    onEvent: (id, event, payload) => seen.events.push({ id, event, payload }),
    ...bridgeOpts,
  });
  const api = createLocalApi({ port: 0, clients, approve: async () => false, routes: bridge.routes, log: quiet });
  const port = await api.listen();
  t.after(async () => {
    bridge.closeAll();
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const word = clients.add('Yaqatw for Word', { kind: KIND }).token;
  const other = clients.add('Something else').token;
  const post = (p, body, token = word) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: p,
          headers: {
            host: `127.0.0.1:${port}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  const open = async (title = 'Interview 1.docx') => (await post('/v1/word/open', { title, path: `C:\\Docs\\${title}` })).body.session;
  return { bridge, post, open, seen, word, other, clients };
}

test('open, then work goes to Word one at a time and answers come back in order', async (t) => {
  const { bridge, post, open, seen } = await fresh(t);
  const session = await open();
  assert.match(session, /^[0-9a-f]{24}$/);
  assert.deepEqual(seen.opened, [{ id: session, title: 'Interview 1.docx', path: 'C:\\Docs\\Interview 1.docx', again: false }]);

  const a = bridge.call(session, 'getAllText');
  const b = bridge.call(session, 'readXmlPart', { ns: 'http://yaqat.alefa.net/xml/code', root: 'codes' });
  let r = await post('/v1/word/next', { session });
  assert.deepEqual(r.body, { op: { id: r.body.op.id, op: 'getAllText', args: {} } });
  // The answer to the first comes with the ask for the second.
  r = await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: true, value: 'Hello' } });
  assert.equal(await a, 'Hello');
  assert.equal(r.body.op.op, 'readXmlPart');
  assert.deepEqual(r.body.op.args, { ns: 'http://yaqat.alefa.net/xml/code', root: 'codes' });
  r = await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: true, value: '<codes/>' } });
  assert.equal(await b, '<codes/>');
  assert.deepEqual(r.body, { op: null });
});

test('a waiting ask gets work that arrives while it waits; with nothing, op: null after waitMs', async (t) => {
  const { bridge, post, open } = await fresh(t);
  const session = await open();
  const started = Date.now();
  const empty = await post('/v1/word/next', { session, waitMs: 150 });
  assert.deepEqual(empty.body, { op: null });
  assert.ok(Date.now() - started >= 140);

  const asking = post('/v1/word/next', { session, waitMs: 1000 });
  await sleep(50);
  const call = bridge.call(session, 'getSelectionText');
  const r = await asking;
  assert.equal(r.body.op.op, 'getSelectionText');
  await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: true, value: 'calm' } });
  assert.equal(await call, 'calm');
});

test('waitMs is capped at one second', async (t) => {
  const { post, open } = await fresh(t);
  const session = await open();
  const started = Date.now();
  await post('/v1/word/next', { session, waitMs: 60000 });
  assert.ok(Date.now() - started < 1500);
});

test('Word failing an operation fails the call with its message', async (t) => {
  const { bridge, post, open } = await fresh(t);
  const session = await open();
  const call = bridge.call(session, 'insertHighlightAtSelection', { hid: 'x' });
  call.catch(() => {}); // checked below, after Word answers
  const r = await post('/v1/word/next', { session });
  await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: false, error: 'No text selected' } });
  await assert.rejects(call, (err) => err.code === 'word-error' && /No text selected/.test(err.message));
});

test('Word busy: queued work fails with word-busy when Word stops asking', async (t) => {
  const { bridge, open } = await fresh(t, { busyMs: 100 });
  const session = await open();
  const calls = [bridge.call(session, 'a'), bridge.call(session, 'b')];
  for (const c of calls) await assert.rejects(c, { code: 'word-busy' });
});

test('a long operation does not make the work behind it look busy', async (t) => {
  const { bridge, post, open } = await fresh(t, { busyMs: 100 });
  const session = await open();
  const first = bridge.call(session, 'saveXmlPart');
  const second = bridge.call(session, 'getAllText');
  const r = await post('/v1/word/next', { session });
  await sleep(300); // Word works on the first; it does not ask meanwhile.
  const r2 = await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: true, value: null } });
  assert.equal(await first, null);
  assert.equal(r2.body.op.op, 'getAllText');
  await post('/v1/word/next', { session, result: { id: r2.body.op.id, ok: true, value: 'text' } });
  assert.equal(await second, 'text');
});

test('taken and never answered: word-timeout; a late answer is ignored', async (t) => {
  const { bridge, post, open } = await fresh(t, { runMs: 100 });
  const session = await open();
  const call = bridge.call(session, 'getAllText');
  const r = await post('/v1/word/next', { session });
  await assert.rejects(call, { code: 'word-timeout' });
  const late = await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: true, value: 'late' } });
  assert.deepEqual(late.body, { op: null });
});

test('closed by Word: pending calls fail, the session is gone, the app is told', async (t) => {
  const { bridge, post, open, seen } = await fresh(t);
  const session = await open();
  const call = bridge.call(session, 'getAllText');
  call.catch(() => {}); // checked below, after the close
  assert.deepEqual((await post('/v1/word/close', { session })).body, { ok: true });
  await assert.rejects(call, { code: 'closed' });
  assert.equal(seen.closed[0].by, 'word');
  assert.deepEqual((await post('/v1/word/next', { session })).body, { closed: true });
  await assert.rejects(bridge.call(session, 'x'), { code: 'no-session' });
});

test('closed by the app: a waiting ask hears closed', async (t) => {
  const { bridge, post, open, seen } = await fresh(t);
  const session = await open();
  const asking = post('/v1/word/next', { session, waitMs: 1000 });
  await sleep(50);
  bridge.close(session);
  assert.deepEqual((await asking).body, { closed: true });
  assert.equal(seen.closed[0].by, 'app');
});

test('opening the same session again shows it again, no new session', async (t) => {
  const { bridge, post, open, seen } = await fresh(t);
  const session = await open();
  const again = await post('/v1/word/open', { session, title: 'ignored' });
  assert.equal(again.body.session, session);
  assert.equal(seen.opened[1].again, true);
  assert.equal(bridge.list().length, 1);
});

test('events reach the app; only for a session of this client', async (t) => {
  const { post, open, seen } = await fresh(t);
  const session = await open();
  assert.deepEqual((await post('/v1/word/event', { session, event: 'selection', payload: { hid: 'h1' } })).body, { ok: true });
  assert.deepEqual((await post('/v1/word/event', { session: 'nope', event: 'selection' })).body, { ok: false });
  assert.deepEqual(seen.events, [{ id: session, event: 'selection', payload: { hid: 'h1' } }]);
});

test('only the Word template: other clients 403, no token 401, another template sees nothing', async (t) => {
  const { post, open, other, clients } = await fresh(t);
  const session = await open();
  assert.equal((await post('/v1/word/open', {}, other)).status, 403);
  assert.equal((await post('/v1/word/next', { session }, other)).body.error, 'wrong-client');
  assert.equal((await post('/v1/word/next', { session }, null)).status, 401);
  const second = clients.add('Another Word', { kind: KIND }).token;
  assert.deepEqual((await post('/v1/word/next', { session }, second)).body, { closed: true });
});

test('large answers (XML parts) are accepted on next', async (t) => {
  const { bridge, post, open } = await fresh(t);
  const session = await open();
  const call = bridge.call(session, 'readXmlPart');
  const r = await post('/v1/word/next', { session });
  const xml = `<codes>${'<code id="x"/>'.repeat(100000)}</codes>`;
  await post('/v1/word/next', { session, result: { id: r.body.op.id, ok: true, value: xml } });
  assert.equal((await call).length, xml.length);
  // Elsewhere the limit stays small.
  assert.equal((await post('/v1/word/event', { session, event: 'x', payload: 'y'.repeat(20000) })).status, 413);
});

test('open without showing: onOpen hears show: false', async (t) => {
  const { post, seen } = await fresh(t);
  const r = await post('/v1/word/open', { title: 'Quiet.docx', path: 'C:\Quiet.docx', show: false });
  assert.equal(r.status, 200);
  assert.equal(seen.opened[0].hidden, true);
  await post('/v1/word/open', { session: r.body.session });
  assert.equal(seen.opened[1].hidden, undefined, 'shown when asked again without show: false');
});

test('actions: carried out by onAction for that session, answered as ok/value or ok/error', async (t) => {
  const asked = [];
  const { post, open } = await fresh(t, {
    onAction: async (s, action, args) => {
      asked.push({ session: s.id, action, args });
      if (action === 'fail') throw new Error('Not an analysis document.');
      return action === 'codes' ? [{ id: 'c1', name: 'Calm' }] : undefined;
    },
  });
  const session = await open();
  const codes = await post('/v1/word/action', { session, action: 'codes', args: { recent: ['c1'] } });
  assert.deepEqual(codes.body, { ok: true, value: [{ id: 'c1', name: 'Calm' }] });
  assert.deepEqual(asked[0], { session, action: 'codes', args: { recent: ['c1'] } });
  assert.deepEqual((await post('/v1/word/action', { session, action: 'apply' })).body, { ok: true, value: null });
  assert.deepEqual((await post('/v1/word/action', { session, action: 'fail' })).body, { ok: false, error: 'Not an analysis document.' });
  assert.equal((await post('/v1/word/action', { session, action: 'bad name!' })).status, 400);
  assert.deepEqual((await post('/v1/word/action', { session: 'nope', action: 'codes' })).body.ok, false);
});

test('actions need the Word template client', async (t) => {
  const { post, open, other } = await fresh(t, { onAction: async () => 'x' });
  const session = await open();
  assert.equal((await post('/v1/word/action', { session, action: 'codes' }, other)).status, 403);
});
