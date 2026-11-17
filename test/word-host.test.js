'use strict';
/**
 * The host page of Word windows (src/word-host/host.js), without Word: it runs in a small fake
 * browser, yaqatw's messages go in as yaqatw posts them, and a scripted Word answers the
 * operations. The real Word side is tested by hand and by automation outside this suite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'word-host', 'host.js'), 'utf8');
const YAQATW = 'https://yaqatw.alefa.net';

/** The page with `word(op, args)` answering operations; rpc(method, ...args) → yaqatw's reply. */
function page(word, { open = true } = {}) {
  const calls = [];
  const posted = [];
  const waiting = new Map();
  const frameWindow = {
    postMessage(sent, origin) {
      assert.equal(origin, YAQATW);
      // A copy, as postMessage makes one (and out of the page's realm, for deepEqual).
      const msg = JSON.parse(JSON.stringify(sent));
      posted.push(msg);
      if (msg.type === 'yaqatw-rpc-response' && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    },
  };
  const el = () => ({ textContent: '', className: '', hidden: false, addEventListener() {} });
  const status = el();
  const frame = Object.assign(el(), { contentWindow: frameWindow });
  let onMessage = null;
  let onWordEvent = null;
  const store = new Map();
  const ctx = {
    console: { warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    URL,
    document: { getElementById: (id) => (id === 'status' ? status : frame) },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    clewWord: {
      info: async () => ({ session: 's1', title: 'Interview.docx', path: 'C:\\Interview.docx', open }),
      call: async (op, args) => {
        calls.push(JSON.parse(JSON.stringify({ op, args: args ?? {} })));
        return word(op, args || {});
      },
      onEvent: (cb) => {
        onWordEvent = cb;
        return () => {};
      },
    },
    addEventListener: (name, fn) => {
      if (name === 'message') onMessage = fn;
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  let next = 1;
  const rpc = (method, ...args) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      onMessage({ source: frameWindow, origin: YAQATW, data: { type: 'yaqatw-rpc', id, method, args } });
    });
  return { rpc, calls, posted, status, frame, fireWord: (...a) => onWordEvent(...a), onMessage: (e) => onMessage(e) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('XML parts and text go to Word as they are', async () => {
  const p = page((op, args) => (op === 'readXmlPart' ? `<${args.root} xmlns="${args.ns}"/>` : op === 'getParagraphs' ? ['a', 'b'] : null));
  const r = await p.rpc('readXmlPart', 'urn:codes', 'codes');
  assert.equal(r.result, '<codes xmlns="urn:codes"/>');
  assert.deepEqual(p.calls[0], { op: 'readXmlPart', args: { ns: 'urn:codes', root: 'codes' } });
  assert.deepEqual((await p.rpc('getParagraphs')).result, ['a', 'b']);
  await p.rpc('saveXmlPart', 'urn:codes', '<codes/>');
  assert.deepEqual(p.calls.at(-1), { op: 'saveXmlPart', args: { ns: 'urn:codes', xml: '<codes/>' } });
});

test('only the yaqatw frame is listened to', async () => {
  const p = page(() => 'x');
  p.onMessage({ source: {}, origin: YAQATW, data: { type: 'yaqatw-rpc', id: 1, method: 'getAllText', args: [] } });
  p.onMessage({ source: p.frame.contentWindow, origin: 'https://evil.example', data: { type: 'yaqatw-rpc', id: 2, method: 'getAllText', args: [] } });
  await settle();
  assert.equal(p.calls.length, 0);
  assert.equal(p.posted.length, 0);
});

test('pluginConnected answers with a ready event', async () => {
  const p = page(() => null);
  await p.rpc('pluginConnected');
  assert.ok(p.posted.some((m) => m.type === 'yaqatw-rpc-event' && m.event === 'ready'));
});

test('applyHighlightUpdate: codes once each, names joined, last colour; none left removes it', async () => {
  const p = page(() => true);
  const code = (id, name, color) => ({ id, attrs: { name, color } });
  await p.rpc('applyHighlightUpdate', { id: 'h1', fullChildren: { code: [code('a', 'Calm', '#FFEB3B'), code('b', 'Place', '#4CAF50'), code('a', 'Calm')] } });
  assert.deepEqual(p.calls[0], { op: 'paintHighlight', args: { hid: 'h1', title: 'Calm | Place', color: '#4CAF50', remove: false } });
  await p.rpc('setHighlightAppearanceForCodes', { id: 'h2', fullChildren: { code: [] } });
  assert.deepEqual(p.calls[1].args, { hid: 'h2', title: '', color: '', remove: true });
});

test('coding the selection: the code and the overlap rule reach Word', async () => {
  const p = page(() => ({ hid: 'h1', text: 'calm' }));
  const r = await p.rpc('insertHighlightAtSelection', { id: 'c', name: 'Calm', color: '#FFEB3B' }, { allowOverlappingHighlights: false });
  assert.deepEqual(r.result, { hid: 'h1', text: 'calm' });
  assert.deepEqual(p.calls[0].args, { title: 'Calm', color: '#FFEB3B', expandToParagraphs: false, noOverlap: true });
  await p.rpc('insertHighlightAtSelection', { id: 'c', name: 'Calm' }, {});
  assert.equal(p.calls[1].args.noOverlap, false);
});

test("Word's list-item refusal is named HighlightBoundaryError, other errors lose their code", async () => {
  const p = page((op) => {
    if (op === 'insertHighlightAtSelection') throw new Error("Error invoking remote method 'word:call': Error: word-error: HighlightBoundaryError: Word cannot mark part of a list item.");
    throw new Error('word-error: No text selected');
  });
  const r = await p.rpc('insertHighlightAtSelection', { name: 'X' }, {});
  assert.equal(r.errorName, 'HighlightBoundaryError');
  assert.equal(r.error, 'Word cannot mark part of a list item.');
  const r2 = await p.rpc('getSelectionText');
  assert.equal(r2.error, 'No text selected');
  assert.equal(r2.errorName, undefined);
});

test('coded paragraph indices come from the paragraph map, sorted, once each', async () => {
  const p = page(() => [
    { hid: 'a', paragraphIndices: [3, 4], order: 0 },
    { hid: 'b', paragraphIndices: [1], order: 1 },
    { hid: 'c', paragraphIndices: [4], order: 2 },
  ]);
  assert.deepEqual((await p.rpc('getCodedParagraphIndices')).result, [1, 3, 4]);
});

test('document settings live in document variables, as JSON', async () => {
  const vars = new Map();
  const p = page((op, args) => {
    if (op === 'setVariable') vars.set(args.key, args.value);
    if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
    return null;
  });
  await p.rpc('setDocumentSetting', 'tab', { name: 'coding' });
  assert.equal(vars.get('yaqatw.setting.tab'), '{"name":"coding"}');
  assert.deepEqual((await p.rpc('getDocumentSetting', 'tab')).result, { name: 'coding' });
  assert.equal((await p.rpc('getDocumentSetting', 'nothing')).result, null);
});

test('findAndSelectBestMatch picks the match whose paragraph fits the context', async () => {
  const p = page((op) => {
    if (op === 'findText')
      return [
        { start: 10, end: 20, paragraphText: 'The room was calm and quiet.' },
        { start: 90, end: 100, paragraphText: 'Calm again: the waiting room was calm.' },
      ];
    return true;
  });
  const r = await p.rpc('findAndSelectBestMatch', 'room was calm', 'Calm again: the waiting room was calm.');
  assert.deepEqual(r.result, { found: true, multiple: true });
  assert.deepEqual(p.calls.at(-1), { op: 'selectRange', args: { start: 90, end: 100 } });
});

test('documentContainsText tries normalised quotes when the raw text is not found', async () => {
  const p = page((op, args) => (op === 'findText' && args.text.includes('"it\'s') ? [{ start: 1, end: 2 }] : []));
  assert.equal((await p.rpc('documentContainsText', 'She said “it’s calm” here')).result, true);
  assert.ok(p.calls.length > 1);
  assert.equal((await p.rpc('documentContainsText', 'short')).result, false);
});

test('restoreHighlight: already there; one free match restored; duplicates told apart or refused', async () => {
  let present = [{ hid: 'h1', text: 'x' }];
  let hits = [];
  const p = page((op) => {
    if (op === 'getAllHighlights') return present;
    if (op === 'findText') return hits;
    return true;
  });
  assert.deepEqual((await p.rpc('restoreHighlight', 'h1', 'waiting room calm')).result, { applied: true });

  present = [];
  hits = [{ start: 5, end: 30, offset: 5, prefix: 'Participants ', suffix: ' as calm.', inHighlight: false }];
  assert.deepEqual((await p.rpc('restoreHighlight', 'h2', 'described the waiting room')).result, { applied: true, created: true });
  assert.deepEqual(p.calls.at(-1), { op: 'insertHighlightAtSelection', args: { hid: 'h2', title: '', color: '' } });

  hits = [
    { start: 5, end: 30, offset: 5, prefix: 'Participants ', suffix: ' as calm.', inHighlight: false },
    { start: 80, end: 105, offset: 80, prefix: 'Later, staff ', suffix: ' as busy.', inHighlight: false },
  ];
  const chosen = await p.rpc('restoreHighlight', 'h3', 'described the waiting room', { prefix: 'staff ', suffix: ' as busy.' });
  assert.deepEqual(chosen.result, { applied: true, created: true });
  assert.deepEqual(p.calls.filter((c) => c.op === 'selectRange').at(-1).args, { start: 80, end: 105 });

  const unsure = await p.rpc('restoreHighlight', 'h4', 'described the waiting room', {});
  assert.deepEqual(unsure.result, { applied: false, ambiguous: true });

  hits = [{ start: 5, end: 30, offset: 5, prefix: '', suffix: '', inHighlight: true }];
  assert.deepEqual((await p.rpc('restoreHighlight', 'h5', 'described the waiting room')).result, { applied: false });
});

test('unknown methods and things not done yet answer "not supported", without asking Word', async () => {
  const p = page(() => null);
  assert.match((await p.rpc('somethingNew', 1)).error, /Not supported in Word yet: somethingNew/);
  assert.match((await p.rpc('insertCitationAtCursor', {})).error, /not supported in Word yet/);
  assert.deepEqual((await p.rpc('getAllCitationControlIds')).result, []);
  assert.equal(p.calls.length, 0);
});

test('a document closed in Word: the page says so, and from the start when already closed', async () => {
  const p = page(() => {
    throw new Error('closed: The Word document was closed.');
  });
  await settle();
  const r = await p.rpc('getAllText');
  assert.equal(r.error, 'The Word document was closed.');
  assert.match(p.status.textContent, /was closed in Word/);

  const late = page(() => null, { open: false });
  await settle();
  assert.match(late.status.textContent, /was closed in Word/);
  assert.equal(late.frame.src, undefined);
});

test("Word's selection reaches yaqatw as selectionchange", async () => {
  const p = page(() => null);
  await settle();
  p.fireWord('selection', { hid: 'h7' });
  p.fireWord('selection', { hid: null });
  const events = p.posted.filter((m) => m.event === 'selectionchange').map((m) => m.payload.parentHighlightId);
  assert.deepEqual(events, ['h7', null]);
});
