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

const DIR = path.join(__dirname, '..', 'src', 'word-host');
const SOURCE = fs.readFileSync(path.join(DIR, 'host.js'), 'utf8');
const COLORS = fs.readFileSync(path.join(DIR, 'colors.js'), 'utf8');
const YAQATW = 'https://yaqatw.alefa.net';

/** The page with `word(op, args)` answering operations; rpc(method, ...args) → yaqatw's reply. */
// `plugin` plays yaqatw's HostRpcServer: method -> answer (or a function of the args).
function page(word, { open = true, plugin = {} } = {}) {
  const calls = [];
  const posted = [];
  const pluginCalls = [];
  const waiting = new Map();
  let actionHandler = null;
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
      if (msg.type === 'yaqatw-host-rpc') {
        pluginCalls.push({ method: msg.method, args: msg.args });
        setTimeout(async () => {
          const reply = { type: 'yaqatw-host-rpc-response', id: msg.id };
          if (!Object.prototype.hasOwnProperty.call(plugin, msg.method)) reply.error = `Unknown method: ${msg.method}`;
          else {
            try {
              const a = plugin[msg.method];
              reply.result = typeof a === 'function' ? await a(...msg.args) : a;
            } catch (err) {
              reply.error = err.message;
            }
          }
          onMessage({ source: frameWindow, origin: YAQATW, data: reply });
        }, 0);
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
      onAction: (handler) => {
        actionHandler = handler;
      },
    },
    addEventListener: (name, fn) => {
      if (name === 'message') onMessage = fn;
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(COLORS, ctx);
  vm.runInContext(SOURCE, ctx);
  let next = 1;
  const rpc = (method, ...args) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      onMessage({ source: frameWindow, origin: YAQATW, data: { type: 'yaqatw-rpc', id, method, args } });
    });
  // An action as main.js passes it (Word's ribbon, the picker); a copy of the answer.
  const act = async (name, args) => JSON.parse(JSON.stringify((await actionHandler(name, args)) ?? null));
  const pluginEvent = (event, payload) =>
    onMessage({ source: frameWindow, origin: YAQATW, data: { type: 'yaqatw-host-rpc-event', event, payload } });
  return {
    rpc,
    calls,
    posted,
    pluginCalls,
    status,
    frame,
    act,
    pluginEvent,
    fireWord: (...a) => onWordEvent(...a),
    onMessage: (e) => onMessage(e),
  };
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
  // #4CAF50, a soft green, reaches Word as Word's bright green.
  assert.deepEqual(p.calls[0], { op: 'paintHighlight', args: { hid: 'h1', title: 'Calm | Place', color: '#00FF00', remove: false } });
  await p.rpc('setHighlightAppearanceForCodes', { id: 'h2', fullChildren: { code: [] } });
  assert.deepEqual(p.calls[1].args, { hid: 'h2', title: '', color: '', remove: true });
});

test("colours reach Word as Word's highlight colours, as yaqatw's wordColor gives them", async () => {
  const p = page(() => true);
  // The same cases as yaqatw's src/service/wordColors.test.ts.
  const cases = {
    '#FFFF00': '#FFFF00', '#ffff00': '#FFFF00', '#008080': '#008080', '#FFFFFF': '#FFFFFF', '#000000': '#000000',
    yellow: '#FFFF00', Teal: '#008080', '#ff0': '#FFFF00', ' #00ff00 ': '#00FF00',
    '#4CAF50': '#00FF00', '#FFEB3B': '#FFFF00', '#FF9800': '#FFFF00', '#F44336': '#FF0000',
    '#3F51B5': '#0000FF', '#00BCD4': '#00FFFF', '#9C27B0': '#FF00FF', '#880E4F': '#800080',
    '#4A148C': '#000080', '#1B5E20': '#008000', '#FE0101': '#FF0000', '#7F0000': '#800000',
    '#FAFAFA': '#FFFFFF', '#BDBDBD': '#C0C0C0', '#9E9E9E': '#808080', '#212121': '#000000',
    '#010203': '#000000', 'not a colour': '', '#12345': '',
  };
  for (const [color, expected] of Object.entries(cases)) {
    await p.rpc('applyHighlightUpdate', { id: 'h', fullChildren: { code: [{ id: 'c', attrs: { name: 'C', color } }] } });
    assert.equal(p.calls.at(-1).args.color, expected, color);
  }
});

test('coding the selection: the code and the overlap rule reach Word', async () => {
  const p = page(() => ({ hid: 'h1', text: 'calm' }));
  const r = await p.rpc('insertHighlightAtSelection', { id: 'c', name: 'Calm', color: '#FFEB3B' }, { allowOverlappingHighlights: false });
  assert.deepEqual(r.result, { hid: 'h1', text: 'calm' });
  assert.deepEqual(p.calls[0].args, { title: 'Calm', color: '#FFFF00', expandToParagraphs: false, noOverlap: true });
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

// --- Word's ribbon: the document's type and the actions ---------------------------------------

test("once yaqatw is there, the document's type goes into a document variable, and follows it", async () => {
  const vars = new Map();
  const p = page(
    (op, args) => {
      if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
      if (op === 'setVariable') vars.set(args.key, args.value);
      return null;
    },
    { plugin: { getFileType: 'analyze' } },
  );
  await p.rpc('pluginConnected');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(vars.get('yaqatw.fileType'), 'analyze');
  assert.ok(p.calls.some((c) => c.op === 'refreshRibbon'));
  p.pluginEvent('fileType', { fileType: 'write' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(vars.get('yaqatw.fileType'), 'write');
  // Unchanged: no write to the document.
  const writes = p.calls.filter((c) => c.op === 'setVariable').length;
  p.pluginEvent('fileType', { fileType: 'write' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.calls.filter((c) => c.op === 'setVariable').length, writes);
});

test('an older yaqatw without getFileType: no type, the ribbon shows everything', async () => {
  const vars = new Map([['yaqatw.fileType', 'analyze']]);
  const p = page((op, args) => {
    if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
    if (op === 'setVariable') vars.set(args.key, args.value);
    return null;
  });
  await p.rpc('pluginConnected');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(vars.get('yaqatw.fileType'), null);
});

test('actions wait for yaqatw, then: codes (Word colours), apply, new code, in vivo', async () => {
  const p = page(() => null, {
    plugin: {
      getFileType: 'analyze',
      getCodeMenuItems: [
        { id: 'c1', name: 'Calm', color: '#4CAF50', description: 'quiet' },
        { id: 'c2', name: 'Place' },
      ],
      applyCodeToSelection: null,
      createCodeAndApply: null,
      createInVivoCodeAndApply: null,
    },
  });
  const early = p.act('codes');
  await p.rpc('pluginConnected');
  assert.deepEqual(await early, {
    fileType: 'analyze',
    codes: [
      { id: 'c1', name: 'Calm', description: 'quiet', color: '#00FF00' },
      { id: 'c2', name: 'Place', description: '', color: '' },
    ],
  });
  await p.act('applyCode', { codeId: 'c2' });
  await p.act('newCode', { name: ' Hope ', description: 'd', color: '#008080' });
  await p.act('inVivo');
  assert.deepEqual(
    p.pluginCalls.filter((c) => c.method !== 'getFileType' && c.method !== 'getCodeMenuItems'),
    [
      { method: 'applyCodeToSelection', args: ['c2'] },
      { method: 'createCodeAndApply', args: ['Hope', 'd', '#008080'] },
      { method: 'createInVivoCodeAndApply', args: [] },
    ],
  );
  await assert.rejects(p.act('newCode', { name: '  ' }), /needs a name/);
  await assert.rejects(p.act('nothing'), /Unknown action/);
});

test('coding actions say why not, in a writing document or one without a type', async () => {
  for (const [type, why] of [
    ['write', /writing document/],
    [null, /type first/],
  ]) {
    const p = page(() => null, { plugin: { getFileType: type, applyCodeToSelection: null } });
    await p.rpc('pluginConnected');
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(p.act('applyCode', { codeId: 'c1' }), why);
    assert.ok(!p.pluginCalls.some((c) => c.method === 'applyCodeToSelection'));
  }
});

test("yaqatw's own refusal comes back as the action's error", async () => {
  const p = page(() => null, {
    plugin: {
      getFileType: 'analyze',
      applyCodeToSelection: () => {
        throw new Error('applyCodeToSelection: unknown code id "zz"');
      },
    },
  });
  await p.rpc('pluginConnected');
  await assert.rejects(p.act('applyCode', { codeId: 'zz' }), /unknown code id/);
});

test('an operation Word is slow to take: the page says it is waiting, then clears it', async () => {
  let release;
  const p = page((op) => (op === 'getAllText' ? new Promise((r) => (release = r)) : null));
  await settle();
  const pending = p.rpc('getAllText');
  await new Promise((r) => setTimeout(r, 2200));
  assert.match(p.status.textContent, /Waiting for Word/);
  release('text');
  assert.equal((await pending).result, 'text');
  assert.equal(p.status.textContent, '');
});

test("a yaqatw without getFileType: the type is read in the document's settings part", async () => {
  const vars = new Map();
  const settings = '<settings xmlns="http://yaqat.alefa.net/xml/settings"><setting id="projectName" name="projectName" value="p"/><setting id="yaqatw-file-type" created="x" name="yaqatw-file-type" value="analyze"/></settings>';
  const p = page(
    (op, args) => {
      if (op === 'readXmlPart' && args.ns === 'http://yaqat.alefa.net/xml/settings') return settings;
      if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
      if (op === 'setVariable') vars.set(args.key, args.value);
      return null;
    },
    { plugin: { applyCodeToSelection: null } },
  );
  await p.rpc('pluginConnected');
  await p.act('applyCode', { codeId: 'c1' });
  assert.ok(p.pluginCalls.some((c) => c.method === 'applyCodeToSelection'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(vars.get('yaqatw.fileType'), 'analyze');
});

test('saving the settings part carries the new type at once', async () => {
  const vars = new Map();
  const p = page(
    (op, args) => {
      if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
      if (op === 'setVariable') vars.set(args.key, args.value);
      return null;
    },
    { plugin: { getFileType: null, applyCodeToSelection: null } },
  );
  await p.rpc('pluginConnected');
  await assert.rejects(p.act('applyCode', { codeId: 'c1' }), /type first/);
  await p.rpc('saveXmlPart', 'http://yaqat.alefa.net/xml/settings', '<settings xmlns="http://yaqat.alefa.net/xml/settings"><setting id="yaqatw-file-type" name="yaqatw-file-type" value="analyze"/></settings>');
  await p.act('applyCode', { codeId: 'c1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(vars.get('yaqatw.fileType'), 'analyze');
  await p.rpc('saveXmlPart', 'http://yaqat.alefa.net/xml/settings', '<settings xmlns="http://yaqat.alefa.net/xml/settings"><setting id="yaqatw-file-type" name="yaqatw-file-type" value="write"/></settings>');
  await assert.rejects(p.act('applyCode', { codeId: 'c1' }), /writing document/);
});
