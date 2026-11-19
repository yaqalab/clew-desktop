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
const FIGURES = fs.readFileSync(path.join(DIR, 'figures.js'), 'utf8');
const YAQATW = 'https://yaqatw.alefa.net';

/** The page with `word(op, args)` answering operations; rpc(method, ...args) → yaqatw's reply. */
// `plugin` plays yaqatw's HostRpcServer: method -> answer (or a function of the args).
function page(word, { open = true, plugin = {}, review } = {}) {
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
    atob,
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
      // The review window of an AI request (main.js): absent in an older preload.
      ...(review ? { review } : {}),
    },
    addEventListener: (name, fn) => {
      if (name === 'message') onMessage = fn;
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(COLORS, ctx);
  vm.runInContext(FIGURES, ctx);
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
  assert.match((await p.rpc('openDocument', 'C:\\Other.docx')).error, /not supported in Word yet/);
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
    note: '',
    codes: [
      { id: 'c1', name: 'Calm', description: 'quiet', color: '#00FF00' },
      { id: 'c2', name: 'Place', description: '', color: '' },
    ],
  });
  // Word's status bar says what was done.
  assert.deepEqual(await p.act('applyCode', { codeId: 'c2' }), { status: '“Place” applied.' });
  // A code applied lately comes first, for Word's menu and the picker alike (one list).
  assert.deepEqual(
    (await p.act('codes')).codes.map((c) => c.id),
    ['c2', 'c1'],
  );
  await p.act('newCode', { name: ' Hope ', description: 'd', color: '#008080' });
  assert.deepEqual(await p.act('inVivo'), { status: 'In vivo code applied.' });
  assert.deepEqual(
    p.pluginCalls.filter((c) => !['getFileType', 'getCodeMenuItems', 'getCapabilities'].includes(c.method)),
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
    const p = page(() => null, { plugin: { getFileType: type, applyCodeToSelection: null, getCodeMenuItems: [] } });
    await p.rpc('pluginConnected');
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(p.act('applyCode', { codeId: 'c1' }), why);
    // Word's menu and the picker show the same reason, from here (codes' note).
    assert.match((await p.act('codes')).note, why);
    assert.ok(!p.pluginCalls.some((c) => c.method === 'applyCodeToSelection'));
  }
});

test('Highlight info: the passage (Word colours), saved fields, codes detached and added, translation', async () => {
  const p = page(() => null, {
    plugin: {
      getFileType: 'analyze',
      getHighlightDetails: (hid) =>
        hid === 'h1'
          ? { text: 'Text', translation: 'Texte', codes: [{ id: 'c1', name: 'Calm', color: '#4CAF50' }] }
          : null,
      updateHighlightDetails: null,
      detachCodeFromHighlight: (hid, codeId) => ({ deleted: codeId === 'c1' }),
      attachCodeToHighlight: null,
      getTranslateProviders: [{ key: 'deepl', label: 'DeepL' }, { key: 'custom' }],
      translateHighlightText: (hid, provider) => `${provider}:${hid}`,
    },
  });
  await p.rpc('pluginConnected');
  // A yaqatw without getCapabilities: what Word offered before it, no categories when it cannot
  // give them.
  assert.deepEqual(await p.act('highlightInfo', { hid: 'h1' }), {
    text: 'Text',
    translation: 'Texte',
    comment: '',
    codes: [{ id: 'c1', name: 'Calm', color: '#00FF00' }],
    categories: [],
    features: ['categories', 'editCode'],
  });
  await assert.rejects(p.act('highlightInfo', { hid: 'gone' }), /no record of this passage/);
  await p.act('saveHighlightInfo', { hid: 'h1', translation: 'T', comment: 'N' });
  assert.deepEqual(await p.act('detachCode', { hid: 'h1', codeId: 'c2' }), { deleted: false });
  assert.deepEqual(await p.act('detachCode', { hid: 'h1', codeId: 'c1' }), { deleted: true });
  await p.act('attachCode', { hid: 'h1', codeId: 'c3' });
  assert.deepEqual(await p.act('translateProviders'), {
    providers: [
      { key: 'deepl', label: 'DeepL' },
      { key: 'custom', label: 'custom' },
    ],
  });
  assert.deepEqual(await p.act('translateHighlight', { hid: 'h1', provider: 'deepl' }), { text: 'deepl:h1' });
  assert.deepEqual(
    p.pluginCalls.find((c) => c.method === 'updateHighlightDetails'),
    { method: 'updateHighlightDetails', args: ['h1', { translation: 'T', comment: 'N' }] },
  );
  assert.deepEqual(
    p.pluginCalls.find((c) => c.method === 'attachCodeToHighlight'),
    { method: 'attachCodeToHighlight', args: ['h1', 'c3'] },
  );
});

test("Add to category: the passage's codes with their categories; a category added, a new one made", async () => {
  const p = page(() => null, {
    plugin: {
      getFileType: 'analyze',
      getHighlightDetails: () => ({
        text: 'T',
        codes: [
          { id: 'c1', name: 'Calm', color: '#4CAF50' },
          { id: 'c2', name: 'Place' },
        ],
      }),
      getCategoryMenuItems: [
        { id: 'k1', name: 'Feelings' },
        { id: 'k2', name: 'Space' },
      ],
      getCategoriesForCode: (codeId) => (codeId === 'c1' ? [{ id: 'k1', name: 'Feelings' }] : []),
      attachCategoryToCode: null,
      detachCategoryFromCode: null,
      createCategoryAndAttach: () => ({ id: 'k3' }),
    },
  });
  await p.rpc('pluginConnected');
  assert.deepEqual(await p.act('categoryMenu', { hid: 'h1' }), {
    codes: [
      { id: 'c1', name: 'Calm', color: '#00FF00', categories: ['k1'] },
      { id: 'c2', name: 'Place', color: '', categories: [] },
    ],
    categories: [
      { id: 'k1', name: 'Feelings' },
      { id: 'k2', name: 'Space' },
    ],
  });
  await p.act('addToCategory', { categoryId: 'k2', codeId: 'c1' });
  await p.act('removeFromCategory', { categoryId: 'k1', codeId: 'c1' });
  // A name already taken (whatever its case): the code goes in that category, none is made.
  assert.deepEqual(await p.act('newCategory', { codeId: 'c2', name: ' space ', description: 'x' }), { id: 'k2', existed: true });
  assert.deepEqual(await p.act('newCategory', { codeId: 'c2', name: 'Time', description: ' when ' }), { id: 'k3', existed: false });
  await assert.rejects(p.act('newCategory', { codeId: 'c2', name: ' ' }), /needs a name/);
  assert.deepEqual(
    p.pluginCalls.filter((c) =>
      ['attachCategoryToCode', 'detachCategoryFromCode', 'createCategoryAndAttach'].includes(c.method),
    ),
    [
      { method: 'attachCategoryToCode', args: ['k2', 'c1'] },
      { method: 'detachCategoryFromCode', args: ['k1', 'c1'] },
      { method: 'attachCategoryToCode', args: ['k2', 'c2'] },
      { method: 'createCategoryAndAttach', args: ['Time', 'when', 'c2'] },
    ],
  );
});

test('editing a code: only what is given goes to yaqatw, a name trimmed, an empty one refused', async () => {
  const p = page(() => null, { plugin: { getFileType: 'analyze', updateCode: null } });
  await p.rpc('pluginConnected');
  await p.act('editCode', { codeId: 'c1', name: ' Calm ', description: 'quiet' });
  await p.act('editCode', { codeId: 'c1', color: '#FF0000' });
  await assert.rejects(p.act('editCode', { codeId: 'c1', name: '  ' }), /needs a name/);
  assert.deepEqual(
    p.pluginCalls.filter((c) => c.method === 'updateCode'),
    [
      { method: 'updateCode', args: ['c1', { name: 'Calm', description: 'quiet' }] },
      { method: 'updateCode', args: ['c1', { color: '#FF0000' }] },
    ],
  );
  const old = page(() => null, { plugin: { getFileType: 'analyze' } });
  await old.rpc('pluginConnected');
  await assert.rejects(old.act('editCode', { codeId: 'c1', name: 'X' }), /needs a newer Yaqatw/);
});

// yaqatw's HostRpcServer as of its coding actions: every method Word's features need.
const ALL_METHODS = [
  'getCapabilities',
  'getFileType',
  'getCodeMenuItems',
  'getHighlightDetails',
  'getCategoryMenuItems',
  'getCategoriesForCode',
  'attachCategoryToCode',
  'detachCategoryFromCode',
  'createCategoryAndAttach',
  'updateCode',
  'getRelationshipMenu',
  'getRelationshipsForCode',
  'addCodeToInstance',
  'removeCodeFromInstance',
  'createRelationshipAndAttach',
  'addInstanceWithCode',
  'deleteHighlight',
  'getCodeUsage',
  'deprecateCode',
  'mergeCode',
  'removeCodeFromFile',
  'deleteCode',
  'showHighlightsForCode',
  'addItemToInstance',
  'addInstanceWithItem',
  'createRelationshipWithItem',
  'updateCategory',
];

/** A yaqatw that has every method, with the answers given (null for the rest). */
function fullPlugin(answers) {
  const plugin = Object.fromEntries(ALL_METHODS.map((m) => [m, null]));
  return Object.assign(plugin, { getFileType: 'analyze', getCapabilities: { rpc: 1, methods: ALL_METHODS } }, answers);
}

test('what yaqatw can do: from its capabilities, kept in a document variable for the right-click menus', async () => {
  const vars = new Map();
  const word = (op, args) => {
    if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
    if (op === 'setVariable') vars.set(args.key, args.value);
    return null;
  };
  const p = page(word, { plugin: fullPlugin({}) });
  await p.rpc('pluginConnected');
  await new Promise((r) => setTimeout(r, 20));
  const all = ['categories', 'editCode', 'editCategory', 'relationships', 'removeHighlight', 'manage', 'showPassages', 'relationshipCategories'];
  assert.deepEqual(await p.act('features'), { features: all });
  assert.equal(vars.get('yaqatw.features'), all.join(','));
  // A yaqatw that lacks one method of a feature: not that feature.
  const some = ALL_METHODS.filter((m) => m !== 'mergeCode' && m !== 'addInstanceWithCode');
  const q = page(word, { plugin: fullPlugin({ getCapabilities: { rpc: 1, methods: some } }) });
  await q.rpc('pluginConnected');
  await new Promise((r) => setTimeout(r, 20));
  const left = ['categories', 'editCode', 'editCategory', 'removeHighlight', 'showPassages', 'relationshipCategories'];
  assert.deepEqual(await q.act('features'), { features: left });
  assert.equal(vars.get('yaqatw.features'), left.join(','));
  // Asked once, not at every action.
  await q.act('features');
  assert.equal(q.pluginCalls.filter((c) => c.method === 'getCapabilities').length, 1);
});

test("Highlight info: each code's categories and relationships, the project's categories", async () => {
  const p = page(() => null, {
    plugin: fullPlugin({
      getHighlightDetails: { text: 'T', codes: [{ id: 'c1', name: 'Calm', color: '#4CAF50' }] },
      getCategoriesForCode: [{ id: 'k1', name: 'Feelings', description: 'd' }],
      getRelationshipsForCode: [{ relationshipId: 'r1', name: 'Trust', instanceId: 'i1', instanceName: 'Trust 1' }],
      getCategoryMenuItems: [
        { id: 'k1', name: 'Feelings' },
        { id: 'k2', name: 'Space', parentId: 'k1' },
      ],
    }),
  });
  await p.rpc('pluginConnected');
  const info = await p.act('highlightInfo', { hid: 'h1' });
  assert.deepEqual(info.codes, [
    {
      id: 'c1',
      name: 'Calm',
      color: '#00FF00',
      categories: [{ id: 'k1', name: 'Feelings', description: 'd' }],
      relationships: [{ relationshipId: 'r1', name: 'Trust', instanceId: 'i1', instanceName: 'Trust 1' }],
    },
  ]);
  assert.deepEqual(info.categories, [
    { id: 'k1', name: 'Feelings' },
    { id: 'k2', name: 'Space' },
  ]);
  assert.equal(info.features.length, 8);
  // A category edited from its tag: only what is given, trimmed; an empty name refused.
  await p.act('editCategory', { categoryId: 'k1', name: ' Moods ', description: ' how one feels ' });
  await p.act('editCategory', { categoryId: 'k1', description: '' });
  await assert.rejects(p.act('editCategory', { categoryId: 'k1', name: ' ' }), /needs a name/);
  assert.deepEqual(
    p.pluginCalls.filter((c) => c.method === 'updateCategory'),
    [
      { method: 'updateCategory', args: ['k1', { name: 'Moods', description: 'how one feels' }] },
      { method: 'updateCategory', args: ['k1', { description: '' }] },
    ],
  );
});

test('a category added or taken out: the status line names the code and the category', async () => {
  const p = page(() => null, {
    plugin: fullPlugin({
      getCodeMenuItems: [{ id: 'c1', name: 'Calm' }],
      getCategoryMenuItems: [{ id: 'k1', name: 'Feelings' }],
    }),
  });
  await p.rpc('pluginConnected');
  assert.deepEqual(await p.act('addToCategory', { categoryId: 'k1', codeId: 'c1' }), { status: '“Calm” added to “Feelings”.' });
  assert.deepEqual(await p.act('removeFromCategory', { categoryId: 'k1', codeId: 'c1' }), {
    status: '“Calm” taken out of “Feelings”.',
  });
  // Names yaqatw does not list: plain words, the action done all the same.
  assert.deepEqual(await p.act('addToCategory', { categoryId: 'k9', codeId: 'c9' }), { status: 'The code added to the category.' });
});

test('Add to relationship: each code with every relationship and its instances; ticks, new instance, new relationship', async () => {
  const menu = [
    { id: 'r1', name: 'Trust', instances: [{ id: 'i1', name: 'Trust 1', hasCode: true }] },
    {
      id: 'r2',
      name: 'Cause',
      description: 'x',
      instances: [
        { id: 'i2', name: 'Cause 1', hasCode: false },
        { id: 'i3', name: 'Cause 2', hasCode: 1 },
      ],
    },
  ];
  const p = page(() => null, {
    plugin: fullPlugin({
      getHighlightDetails: { text: 'T', codes: [{ id: 'c1', name: 'Calm', color: '#4CAF50' }] },
      getCodeMenuItems: [{ id: 'c1', name: 'Calm' }],
      getRelationshipMenu: () => menu,
      addCodeToInstance: { added: true },
      addInstanceWithCode: { id: 'i4' },
      createRelationshipAndAttach: { id: 'r3', instanceId: 'i5' },
    }),
  });
  await p.rpc('pluginConnected');
  // A code in no category: the code alone.
  assert.deepEqual(await p.act('relationshipMenu', { hid: 'h1' }), {
    items: [
      {
        kind: 'code',
        id: 'c1',
        name: 'Calm',
        color: '#00FF00',
        relationships: [
          { id: 'r1', name: 'Trust', instances: [{ id: 'i1', name: 'Trust 1', holds: true }] },
          {
            id: 'r2',
            name: 'Cause',
            instances: [
              { id: 'i2', name: 'Cause 1', holds: false },
              { id: 'i3', name: 'Cause 2', holds: true },
            ],
          },
        ],
      },
    ],
  });
  // A relationship with one instance is named alone; with several, with the instance.
  assert.deepEqual(await p.act('addToRelationship', { relationshipId: 'r1', instanceId: 'i1', codeId: 'c1' }), {
    status: '“Calm” added to “Trust”.',
  });
  assert.deepEqual(await p.act('removeFromRelationship', { relationshipId: 'r2', instanceId: 'i3', codeId: 'c1' }), {
    status: '“Calm” taken out of “Cause › Cause 2”.',
  });
  assert.deepEqual(await p.act('newInstance', { relationshipId: 'r2', codeId: 'c1' }), {
    status: 'A new instance of “Cause” holds “Calm”.',
  });
  assert.deepEqual(await p.act('newRelationship', { codeId: 'c1', name: ' Effect ', description: ' why ' }), { id: 'r3' });
  await assert.rejects(p.act('newRelationship', { codeId: 'c1', name: ' ' }), /needs a name/);
  assert.deepEqual(
    p.pluginCalls.filter((c) =>
      ['getRelationshipMenu', 'addCodeToInstance', 'removeCodeFromInstance', 'addInstanceWithCode', 'createRelationshipAndAttach'].includes(
        c.method,
      ) && !(c.method === 'getRelationshipMenu' && c.args.length === 0),
    ),
    [
      { method: 'getRelationshipMenu', args: ['c1'] },
      { method: 'addCodeToInstance', args: ['r1', 'i1', 'c1'] },
      { method: 'removeCodeFromInstance', args: ['r2', 'i3', 'c1'] },
      { method: 'addInstanceWithCode', args: ['r2', 'c1'] },
      { method: 'createRelationshipAndAttach', args: ['Effect', 'why', 'c1'] },
    ],
  );
});

test("Add to relationship with categories: the codes' categories once each, a category put in, its parents in the window", async () => {
  const p = page(() => null, {
    plugin: fullPlugin({
      getHighlightDetails: {
        text: 'T',
        codes: [
          { id: 'c1', name: 'Calm', color: '#4CAF50' },
          { id: 'c2', name: 'Place' },
        ],
      },
      getCodeMenuItems: [{ id: 'c1', name: 'Calm' }],
      getCategoriesForCode: (codeId) => (codeId === 'c1' ? [{ id: 'k1', name: 'Feelings' }] : [{ id: 'k1', name: 'Feelings' }, { id: 'k3', name: 'Space' }]),
      getCategoryMenuItems: [
        { id: 'k1', name: 'Feelings', parentId: 'k2' },
        { id: 'k2', name: 'Emotions', parentId: 'k0' },
        { id: 'k0', name: 'Inner life' },
        { id: 'k3', name: 'Space' },
      ],
      getRelationshipMenu: (itemId) => [{ id: 'r1', name: 'Trust', instances: [{ id: 'i1', name: 'Trust 1', hasCode: itemId === 'k1' }] }],
      addItemToInstance: { added: true },
      addInstanceWithItem: { id: 'i2' },
      createRelationshipWithItem: { id: 'r2', instanceId: 'i3' },
    }),
  });
  await p.rpc('pluginConnected');
  const menu = await p.act('relationshipMenu', { hid: 'h1' });
  assert.deepEqual(
    menu.items.map((it) => [it.kind, it.id, it.relationships[0].instances[0].holds]),
    [
      ['code', 'c1', false],
      ['code', 'c2', false],
      ['category', 'k1', true],
      ['category', 'k3', false],
    ],
  );
  // The window: each code, the categories it is in, their parents under them.
  assert.deepEqual(
    (await p.act('relateItems', { hid: 'h1' })).items.map((it) => `${'  '.repeat(it.depth)}${it.kind}:${it.name}`),
    [
      'code:Calm',
      '  category:Feelings',
      '    category:Emotions',
      '      category:Inner life',
      'code:Place',
      '  category:Feelings',
      '    category:Emotions',
      '      category:Inner life',
      '  category:Space',
    ],
  );
  assert.deepEqual(await p.act('itemRelationships', { itemId: 'k1' }), {
    relationships: [{ id: 'r1', name: 'Trust', instances: [{ id: 'i1', name: 'Trust 1', holds: true }] }],
  });
  const k1 = { itemId: 'k1', kind: 'category' };
  assert.deepEqual(await p.act('addToRelationship', { relationshipId: 'r1', instanceId: 'i1', ...k1 }), {
    status: 'The category “Feelings” added to “Trust”.',
  });
  assert.deepEqual(await p.act('removeFromRelationship', { relationshipId: 'r1', instanceId: 'i1', ...k1 }), {
    status: 'The category “Feelings” taken out of “Trust”.',
  });
  assert.deepEqual(await p.act('newInstance', { relationshipId: 'r1', ...k1 }), {
    status: 'A new instance of “Trust” holds the category “Feelings”.',
  });
  assert.deepEqual(await p.act('newRelationship', { name: 'Cause', description: '', ...k1 }), { id: 'r2' });
  // A code given as an item is a code, as before.
  await p.act('addToRelationship', { relationshipId: 'r1', instanceId: 'i1', itemId: 'c1', kind: 'code' });
  assert.deepEqual(
    p.pluginCalls.filter((c) =>
      ['addItemToInstance', 'removeCodeFromInstance', 'addInstanceWithItem', 'createRelationshipWithItem', 'addCodeToInstance'].includes(c.method),
    ),
    [
      { method: 'addItemToInstance', args: ['r1', 'i1', 'k1', 'CategoryXml'] },
      { method: 'removeCodeFromInstance', args: ['r1', 'i1', 'k1'] },
      { method: 'addInstanceWithItem', args: ['r1', 'k1', 'CategoryXml'] },
      { method: 'createRelationshipWithItem', args: ['Cause', '', 'k1', 'CategoryXml'] },
      { method: 'addCodeToInstance', args: ['r1', 'i1', 'c1'] },
    ],
  );
  // A yaqatw that cannot put a category in a relationship: the codes alone, in the menu and the window.
  const older = ALL_METHODS.filter((m) => !['addItemToInstance', 'addInstanceWithItem', 'createRelationshipWithItem'].includes(m));
  const q = page(() => null, {
    plugin: fullPlugin({
      getCapabilities: { rpc: 1, methods: older },
      getHighlightDetails: { text: 'T', codes: [{ id: 'c1', name: 'Calm' }] },
      getCategoriesForCode: [{ id: 'k1', name: 'Feelings' }],
      getRelationshipMenu: [],
    }),
  });
  await q.rpc('pluginConnected');
  assert.deepEqual((await q.act('relationshipMenu', { hid: 'h1' })).items.map((it) => it.id), ['c1']);
  assert.deepEqual(await q.act('relateItems', { hid: 'h1' }), {
    items: [{ kind: 'code', id: 'c1', name: 'Calm', color: '', depth: 0 }],
    categories: false,
  });
});

test('managing a code: its reach, then deprecate, merge, remove from this document, delete', async () => {
  const p = page(() => null, {
    plugin: fullPlugin({
      getCodeUsage: { here: 4, elsewhere: '12', files: 3 },
      mergeCode: (source, target) => ({ targetId: `${target}-end` }),
      removeCodeFromFile: { removedHighlights: 1, updatedHighlights: 3, removedControls: 1, deletedCodes: 0 },
    }),
  });
  await p.rpc('pluginConnected');
  assert.deepEqual(await p.act('codeUsage', { codeId: 'c1' }), { here: 4, elsewhere: 12, files: 3 });
  await p.act('deprecateCode', { codeId: 'c1', reason: ' unclear ' });
  assert.deepEqual(await p.act('mergeCode', { codeId: 'c1', targetId: 'c2' }), { targetId: 'c2-end' });
  await assert.rejects(p.act('mergeCode', { codeId: 'c1', targetId: 'c1' }), /another code/);
  assert.deepEqual(await p.act('removeCodeFromFile', { codeId: 'c1' }), { removedHighlights: 1, updatedHighlights: 3 });
  await p.act('deleteCode', { codeId: 'c1' });
  assert.deepEqual(await p.act('removeHighlight', { hid: 'h1' }), { status: "Highlight removed: it is in Yaqatw's Trash." });
  await p.act('showPassages', { codeId: 'c1' });
  assert.deepEqual(
    p.pluginCalls.filter((c) =>
      ['getCodeUsage', 'deprecateCode', 'mergeCode', 'removeCodeFromFile', 'deleteCode', 'deleteHighlight', 'showHighlightsForCode'].includes(
        c.method,
      ),
    ),
    [
      { method: 'getCodeUsage', args: ['c1'] },
      { method: 'deprecateCode', args: ['c1', 'unclear'] },
      { method: 'mergeCode', args: ['c1', 'c2'] },
      { method: 'removeCodeFromFile', args: ['c1'] },
      { method: 'deleteCode', args: ['c1'] },
      { method: 'deleteHighlight', args: ['h1'] },
      { method: 'showHighlightsForCode', args: ['c1'] },
    ],
  );
  // An older yaqatw: said plainly.
  const old = page(() => null, { plugin: { getFileType: 'analyze' } });
  await old.rpc('pluginConnected');
  await assert.rejects(old.act('removeHighlight', { hid: 'h1' }), /needs a newer Yaqatw/);
  await assert.rejects(old.act('codeUsage', { codeId: 'c1' }), /needs a newer Yaqatw/);
});

test('Highlight info: a writing document says why; an older yaqatw asks for a newer one', async () => {
  const w = page(() => null, { plugin: { getFileType: 'write', getHighlightDetails: null } });
  await w.rpc('pluginConnected');
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(w.act('highlightInfo', { hid: 'h1' }), /writing document/);
  const old = page(() => null, { plugin: { getFileType: 'analyze' } });
  await old.rpc('pluginConnected');
  await assert.rejects(old.act('highlightInfo', { hid: 'h1' }), /needs a newer Yaqatw/);
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

// ---------------------------------------------------------------------------------------------
// Quotes, notes, figures and tables (word-plugin/src/Citations.bas)

/** The start of a picture file, enough for its type and size. */
function pictureHead(kind, width, height) {
  if (kind === 'png') {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b.toString('base64');
  }
  if (kind === 'jpeg') {
    // SOI, an APP0 segment (16 bytes), then SOF0 with the size.
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]).toString('base64');
  }
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b.toString('base64');
}

test('a quote goes to Word as text in a citation, block quotes in the Quote style', async () => {
  const p = page((op) => (op === 'insertCitation' ? { controlId: '-955410093' } : null));
  const r = await p.rpc('insertCitationAtCursor', { formattedText: '“Calm.” Participant #3', title: 'Quote: Calm.', style: 'block' });
  assert.deepEqual(r.result, { controlId: '-955410093' });
  assert.deepEqual(p.calls[0], { op: 'insertCitation', args: { title: 'Quote: Calm.', text: '“Calm.” Participant #3', block: true } });
  await p.rpc('refreshCitationDisplay', '-955410093', '“Calm.”', false);
  assert.deepEqual(p.calls[1], { op: 'refreshCitation', args: { id: '-955410093', text: '“Calm.”', block: false } });
});

test('citations are listed, deleted and unlinked in Word', async () => {
  const p = page((op) => (op === 'citationIds' ? ['1', '-2'] : null));
  assert.deepEqual((await p.rpc('getAllCitationControlIds')).result, ['1', '-2']);
  await p.rpc('deleteCitationControl', 1);
  await p.rpc('unlinkCitationControl', '-2');
  await p.rpc('unlinkAllCitations');
  assert.deepEqual(p.calls.slice(1), [
    { op: 'deleteCitation', args: { id: '1' } },
    { op: 'unlinkCitation', args: { id: '-2' } },
    { op: 'unlinkAllCitations', args: {} },
  ]);
});

test('a figure is one Word XML package: caption, picture at its size, source, in the set order', async () => {
  const p = page((op) => (op === 'insertCitationXml' ? { controlId: '7' } : null));
  const caption = '<pkg:package><w:body><w:p><w:r><w:t>Figure 1. Rooms</w:t></w:r></w:p></w:body></pkg:package>';
  const opts = {
    title: 'Rooms', captionOoxml: caption, captionPosition: 'above', imageAlignment: 'center',
    sourceAlignment: 'right', source: 'Source: field notes & photos', base64: pictureHead('png', 640, 480), createControl: true,
  };
  const r = await p.rpc('insertArtifactImageAtCursor', opts);
  assert.deepEqual(r.result, { controlId: '7' });
  const { args } = p.calls[0];
  assert.equal(p.calls[0].op, 'insertCitationXml');
  assert.equal(args.title, 'Artifact: Rooms');
  assert.equal(args.link, true);
  const xml = args.xml;
  assert.match(xml, /<pkg:part pkg:name="\/word\/media\/figure\.png" pkg:contentType="image\/png"/);
  assert.match(xml, new RegExp(`<pkg:binaryData>${opts.base64.replace(/[+/]/g, '\\$&')}</pkg:binaryData>`));
  // 640 × 480 pixels at 96 an inch, in EMU.
  assert.match(xml, /<wp:extent cx="6096000" cy="4572000"\/>/);
  const at = (s) => xml.indexOf(s);
  assert.ok(at('Figure 1. Rooms') > 0 && at('Figure 1. Rooms') < at('<w:drawing>'), 'caption above the picture');
  assert.ok(at('<w:jc w:val="center"/></w:pPr><w:r><w:drawing>') > 0, 'picture centred');
  assert.ok(at('<w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Source: field notes &amp; photos') > at('<w:drawing>'), 'source last');

  // Below, unlinked, a JPEG, as a refresh too.
  await p.rpc('insertArtifactImageAtCursor', { ...opts, captionPosition: 'below', createControl: false, base64: pictureHead('jpeg', 300, 200) });
  const below = p.calls[1].args;
  assert.equal(below.link, false);
  assert.match(below.xml, /figure\.jpeg" pkg:contentType="image\/jpeg"/);
  assert.match(below.xml, /<wp:extent cx="2857500" cy="1905000"\/>/);
  assert.ok(below.xml.indexOf('<w:drawing>') < below.xml.indexOf('Figure 1. Rooms'), 'caption below the picture');
  await p.rpc('refreshArtifactImageDisplay', '7', { ...opts, base64: `data:image/gif;base64,${pictureHead('gif', 10, 20)}` });
  assert.equal(p.calls[2].op, 'refreshCitationXml');
  assert.equal(p.calls[2].args.id, '7');
  assert.match(p.calls[2].args.xml, /figure\.gif[\s\S]*<wp:extent cx="95250" cy="190500"\/>/);
});

test('a picture Word cannot take is refused before Word is asked', async () => {
  const p = page(() => null);
  const r = await p.rpc('insertArtifactImageAtCursor', { title: 'x', base64: Buffer.from('<svg/>').toString('base64'), createControl: true });
  assert.match(r.error, /PNG, JPEG, GIF or BMP/);
  assert.equal(p.calls.length, 0);
});

test("a table goes in as the Word XML yaqatw made; an older yaqatw that sends none is told so", async () => {
  const p = page((op) => (op === 'insertCitationXml' ? { controlId: '9' } : null));
  const doc = { title: 'Waiting times in the three clinics', blocks: [] };
  const r = await p.rpc('insertTableAtCursor', doc, { link: true, ooxml: '<pkg:package/>' });
  assert.deepEqual(r.result, { controlId: '9' });
  assert.deepEqual(p.calls[0], { op: 'insertCitationXml', args: { title: 'Table: Waiting times in the three cli', xml: '<pkg:package/>', link: true } });
  const old = await p.rpc('insertTableAtCursor', doc, { link: true });
  assert.match(old.error, /newer Yaqatw/);
  await p.rpc('refreshTableCitationDisplay', '9', '<pkg:package/>', doc);
  assert.deepEqual(p.calls[1], { op: 'refreshCitationXml', args: { id: '9', xml: '<pkg:package/>' } });
});

// ---------------------------------------------------------------------------------------------
// Writing: the ribbon's Writing group and the insert window

test('writing actions go to yaqatw in a writing document, and are refused elsewhere', async () => {
  const items = [{ source: 'highlights', id: 'h1', title: 'Calm', text: 'calm', options: [{ key: 'quote', label: 'Quote' }] }];
  const vars = new Map();
  const p = page(
    (op, args) => {
      if (op === 'getVariable') return vars.has(args.key) ? vars.get(args.key) : null;
      if (op === 'setVariable') vars.set(args.key, args.value);
      return null;
    },
    {
      plugin: {
        getFileType: 'write',
        searchCiteSources: (query, source, limit) => (query === 'calm' && source === 'highlights' && limit === 50 ? items : []),
        insertCiteSource: null,
        refreshAllCitations: null,
        unlinkAllCitations: null,
      },
    },
  );
  await p.rpc('pluginConnected');
  assert.deepEqual(await p.act('searchCites', { query: 'calm', source: 'highlights', limit: 50 }), { items });
  await p.act('insertCite', { source: 'highlights', id: 'h1', option: 'block' });
  await p.act('refreshCitations');
  await p.act('unlinkCitations');
  const sent = p.pluginCalls.filter((c) => c.method !== 'getFileType' && c.method !== 'getCapabilities');
  assert.deepEqual(sent.slice(1), [
    { method: 'insertCiteSource', args: ['highlights', 'h1', 'block'] },
    { method: 'refreshAllCitations', args: [] },
    { method: 'unlinkAllCitations', args: [] },
  ]);
  // Coding is refused in a writing document; writing in an analysis one.
  await assert.rejects(p.act('applyCode', { codeId: 'c1' }), /writing document/);
  p.pluginEvent('fileType', { fileType: 'analyze' });
  await assert.rejects(p.act('searchCites', { query: 'calm' }), /analysis document/);
});
test('a yaqatw without the writing methods: the insert window says it needs a newer one', async () => {
  const p = page((op) => (op === 'getVariable' ? 'write' : null), { plugin: { getFileType: 'write' } });
  await p.rpc('pluginConnected');
  await assert.rejects(p.act('searchCites', { query: 'calm' }), /needs a newer Yaqatw/);
});
// --- Yaqatw's AI requests, reviewed by Clew (yaqatw: src/service/ai/aiGate.ts) ---------------

const chat = (content) => ({ model: 'gpt', messages: [{ role: 'user', content }] });
const aiAsk = (over = {}) => ({
  feature: 'Code Agent',
  runId: 'run-1',
  provider: 'openai',
  model: 'gpt',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  kind: 'json',
  payload: chat('I wrote to them one by one.'),
  ...over,
});

test('on connect, Yaqatw is told Clew reviews its AI requests (when this window can show them)', async () => {
  const p = page(() => null, { review: async () => true, plugin: { setHostFeatures: (f) => f } });
  await p.rpc('pluginConnected');
  await settle();
  const told = p.pluginCalls.find((c) => c.method === 'setHostFeatures');
  assert.deepEqual(told && told.args[0], { name: 'Clew', aiGate: true });
  const older = page(() => null, { plugin: { setHostFeatures: (f) => f } });
  await older.rpc('pluginConnected');
  await settle();
  assert.equal(older.pluginCalls.some((c) => c.method === 'setHostFeatures'), false);
});

test('a model on this computer passes without a review', async () => {
  const shown = [];
  const p = page(() => null, { review: async (d) => (shown.push(d), true) });
  const r = await p.rpc('aiGate_review', aiAsk({ endpoint: 'http://localhost:11434/api/chat' }));
  assert.equal(r.result.allow, true);
  assert.equal(shown.length, 0);
});

test('a cloud request is shown once per run, its text without the settings, and sent as it is', async () => {
  const shown = [];
  const p = page(() => null, { review: async (d) => (shown.push(JSON.parse(JSON.stringify(d))), true) });
  const first = await p.rpc('aiGate_review', aiAsk());
  const second = await p.rpc('aiGate_review', aiAsk({ payload: chat('Again.') }));
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], {
    feature: 'Code Agent',
    provider: 'openai',
    model: 'gpt',
    host: 'api.openai.com',
    kind: 'json',
    bytes: 0,
    texts: ['I wrote to them one by one.'],
  });
  assert.deepEqual(first.result, { allow: true, payload: chat('I wrote to them one by one.') });
  assert.deepEqual(second.result.payload, chat('Again.'));
  await p.rpc('aiGate_review', aiAsk({ runId: 'run-2' }));
  assert.equal(shown.length, 2);
});

test('Cancel sends nothing, quietly, for the whole run; an unreadable request is refused', async () => {
  let asked = 0;
  const p = page(() => null, { review: async () => (asked++, false) });
  assert.deepEqual((await p.rpc('aiGate_review', aiAsk())).result, { allow: false, cancelled: true });
  assert.deepEqual((await p.rpc('aiGate_review', aiAsk())).result, { allow: false, cancelled: true });
  assert.equal(asked, 1);
  const bad = await p.rpc('aiGate_review', { nope: true });
  assert.equal(bad.result.allow, false);
});

test("the answer comes back untouched: nothing was replaced in a Word document", async () => {
  const p = page(() => null, { review: async () => true });
  const r = await p.rpc('aiGate_restore', 'g1', { text: 'Tanaka agrees' });
  assert.deepEqual(r.result, { text: 'Tanaka agrees' });
});
