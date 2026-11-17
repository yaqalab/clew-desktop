/**
 * The host page of a Word window: yaqatw's /embed in a frame, working on a Word document
 * through Clew Desktop (window.clewWord → main process → local API → Yaqatw for Word).
 *
 * yaqatw's side of the conversation is its WebAdapter (yaqatw: src/host/WebAdapter.ts), the
 * same one Clew and Euro-Office answer:
 *
 *   yaqatw → host   { type: "yaqatw-rpc",          id, method, args }
 *   host → yaqatw   { type: "yaqatw-rpc-response", id, result | error }
 *   host → yaqatw   { type: "yaqatw-rpc-event",    event, payload }   ("ready", "selectionchange")
 *
 * Each method is answered from the table below: a Word operation (word-plugin/src/WordOps.bas),
 * a local answer, or "not supported in Word yet" for what is still to come. A method this page
 * does not know gets that answer too, so a newer yaqatw never hangs on it.
 */
(function () {
  'use strict';

  const YAQATW = 'https://yaqatw.alefa.net';
  const EMBED = `${YAQATW}/embed`;
  const KV_PREFIX = 'yaqatw-word:';
  const SETTING_PREFIX = 'yaqatw.setting.';

  const word = window.clewWord;
  const status = document.getElementById('status');
  const frame = document.getElementById('yaqatw');
  let info = { title: 'Word document' };

  function showStatus(text, kind) {
    status.textContent = text;
    status.className = kind || '';
    status.hidden = !text;
  }

  /** Word's errors come through the main process as "Error invoking …: code: message". */
  function cleanError(err) {
    const msg = err && err.message ? err.message : String(err);
    const m = /^Error invoking remote method '[^']+': (?:Error: )?(.*)$/s.exec(msg);
    return m ? m[1] : msg;
  }

  const op = (name, args) => word.call(name, args);

  function notSupported(what) {
    return () => {
      throw new Error(`${what} is not supported in Word yet.`);
    };
  }
  const none = () => undefined;
  const empty = () => [];

  // ─── Highlights ────────────────────────────────────────────────────────────────────────────

  // Word's highlight colours (colors.js): Word gets palette colours only.
  const wordColor = window.ClewWordColors.wordColor;

  /**
   * Title and colour from the highlight's codes, as WordDocumentHost.applyHighlightUpdate works
   * them out: the resolved codes in `fullChildren.code`, each once; the title their names
   * joined by " | ", the colour the last one's. No codes left: the highlight goes.
   */
  function paint(h) {
    if (!h || !h.id) return undefined;
    const seen = new Set();
    const codes = ((h.fullChildren && h.fullChildren.code) || []).filter((c) => {
      if (!c || !c.id || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    const title = codes
      .map((c) => c.attrs && c.attrs.name)
      .filter(Boolean)
      .join(' | ');
    const last = codes[codes.length - 1];
    const color = wordColor(last && last.attrs && last.attrs.color);
    return op('paintHighlight', { hid: String(h.id), title, color, remove: codes.length === 0 }).then(() => undefined);
  }

  /** Selects a highlight in Word; one not in this document is said so here. */
  async function goTo(hid) {
    if (!hid) return;
    const found = await op('goToHighlight', { hid: String(hid) });
    if (!found) {
      showStatus('That highlight is not in this document.', 'closed');
      setTimeout(() => {
        if (status.textContent.startsWith('That highlight')) showStatus('');
      }, 4000);
    }
  }

  // ─── Finding text: WordDocumentHost's logic, on Word's own search (findText) ───────────────

  const MAX_SEARCH = 255;
  const MIN_CONTEXT_SCORE = 4;
  const cap = (s) => (s.length > MAX_SEARCH ? s.substring(0, MAX_SEARCH) : s);

  /** yaqatw's normalizeSearchText (WordDocumentHost.ts). */
  function normalizeSearchText(text) {
    return String(text)
      .replace(/[‘’`ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Fragments Word's search can find: whole, first paragraph, first sentence, split on …—–. */
  function fragments(src, out, keepShortPrimary) {
    const add = (s) => {
      const t = s.trim();
      if (t.length >= 10 && !out.includes(cap(t))) out.push(cap(t));
    };
    if (keepShortPrimary) {
      const primary = src.trim();
      if (primary.length > 0 && !out.includes(cap(primary))) out.push(cap(primary));
    } else {
      add(src);
    }
    const firstPara = src.split(/\r?\n|\r/)[0];
    if (firstPara) add(firstPara);
    const sentenceEnd = src.search(/\.\s/);
    if (sentenceEnd > 20) add(src.substring(0, sentenceEnd + 1));
    for (const frag of src.split(/[…—–]+/)) add(frag);
    return out;
  }

  /** The raw candidates first, then normalised ones not already there. */
  function candidatesFor(src, keepShortPrimary = false) {
    const raw = fragments(String(src), [], keepShortPrimary);
    const normalized = normalizeSearchText(src);
    if (normalized === String(src)) return raw;
    return [...raw, ...fragments(normalized, [], keepShortPrimary).filter((c) => !raw.includes(c))];
  }

  async function search(text, { max = 50, context = false } = {}) {
    try {
      return await op('findText', { text, max, context });
    } catch {
      // A string Word's search refuses: the next candidate.
      return [];
    }
  }

  /** The matches of the first candidate that has any. */
  async function firstHits(candidates, opts) {
    for (const c of candidates) {
      const hits = await search(c, opts);
      if (hits.length) return hits;
    }
    return [];
  }

  const selectHit = (hit) => op('selectRange', { start: hit.start, end: hit.end });

  async function documentContainsText(text) {
    const src = String(text ?? '');
    const out = [];
    const add = (s) => {
      const t = s.trim();
      if (t.length >= 10 && !out.includes(cap(t))) out.push(cap(t));
    };
    add(src);
    for (const frag of src.split(/[…—–]+/)) add(frag);
    const normalized = normalizeSearchText(src);
    if (normalized !== src) {
      add(normalized);
      for (const frag of normalized.split(/[…—–]+/)) add(frag);
    }
    return (await firstHits(out, { max: 1 })).length > 0;
  }

  /** The match whose paragraphs best fit `fullContext`, selected (WordDocumentHost's scoring). */
  async function findAndSelectBestMatch(needle, fullContext) {
    const hits = await firstHits(candidatesFor(String(needle ?? ''), true));
    if (!hits.length) return { found: false };
    if (hits.length === 1) {
      await selectHit(hits[0]);
      return { found: true, multiple: false };
    }
    const ctx = String(fullContext ?? '').toLowerCase().trim();
    const prefix = ctx.substring(0, 60);
    let best = 0;
    let bestScore = -1;
    hits.forEach((hit, i) => {
      const para = String(hit.paragraphText || '').toLowerCase().trim();
      const score = (para.includes(prefix) ? 1000 : 0) + [...para].filter((ch) => ctx.includes(ch)).length;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    await selectHit(hits[best]);
    return { found: true, multiple: true };
  }

  /** Finds the passage and codes it with each code, as WordDocumentHost.insertHighlightForExcerpt. */
  async function insertHighlightForExcerpt(excerpt, codes, searchText) {
    if (!excerpt || !String(excerpt).trim()) throw new Error('Excerpt text is empty');
    const hits = await firstHits(candidatesFor(searchText || excerpt), { max: 1 });
    let result = { hid: '', text: excerpt, modified: false };
    if (!hits.length) return result;
    await selectHit(hits[0]);
    for (const code of codes || []) {
      // From the second code on, the passage is the new highlight: select it again to reuse it.
      if (result.hid) await op('goToHighlight', { hid: result.hid });
      result = await op('insertHighlightAtSelection', {
        title: (code && code.name) || '',
        color: wordColor(code && code.color),
      });
    }
    return result;
  }

  // yaqatw's chooseHighlightMatch (src/service/highlightAnchor.ts).
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function commonSuffixLen(a, b) {
    let i = a.length;
    let j = b.length;
    let n = 0;
    while (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i--;
      j--;
      n++;
    }
    return n;
  }
  function commonPrefixLen(a, b) {
    const m = Math.min(a.length, b.length);
    let n = 0;
    while (n < m && a[n] === b[n]) n++;
    return n;
  }
  function chooseHighlightMatch(candidates, hints) {
    if (candidates.length === 0) return { index: null, ambiguous: false };
    if (candidates.length === 1) return { index: 0, ambiguous: false };
    if (hints.prefix || hints.suffix) {
      const scores = candidates.map(
        (c) =>
          (hints.prefix ? commonSuffixLen(norm(hints.prefix), norm(c.prefix)) : 0) +
          (hints.suffix ? commonPrefixLen(norm(hints.suffix), norm(c.suffix)) : 0),
      );
      const max = Math.max(...scores);
      if (max >= MIN_CONTEXT_SCORE) {
        const winners = scores.reduce((acc, s, i) => (s === max ? [...acc, i] : acc), []);
        if (winners.length === 1) return { index: winners[0], ambiguous: false };
        if (hints.offset !== undefined) {
          let bestIdx = null;
          let bestDist = Infinity;
          let tie = false;
          for (const i of winners) {
            const dist = Math.abs(candidates[i].offset - hints.offset);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
              tie = false;
            } else if (dist === bestDist) tie = true;
          }
          if (!tie && bestIdx !== null) return { index: bestIdx, ambiguous: false };
        }
        if (hints.rank !== undefined && winners.includes(hints.rank)) return { index: hints.rank, ambiguous: false };
      }
    }
    return { index: null, ambiguous: true };
  }

  /**
   * Puts back the control of a highlight that is in yaqatw's data but not in the document, with
   * its own id (WordDocumentHost.restoreHighlight): only on a passage no other highlight holds,
   * and only when the passage is certain. Title and colour come with yaqatw's next repaint.
   */
  async function restoreHighlight(hid, text, hints) {
    if (!hid || !text || !String(text).trim()) return { applied: false };
    const present = await op('getAllHighlights');
    if (present.some((h) => h.hid === String(hid))) return { applied: true };
    const hits = await firstHits(candidatesFor(text), { context: true });
    const free = hits.filter((h) => !h.inHighlight);
    if (!free.length) return { applied: false };
    const choice = chooseHighlightMatch(free, hints || {});
    if (choice.index === null) return { applied: false, ambiguous: choice.ambiguous };
    await selectHit(free[choice.index]);
    await op('insertHighlightAtSelection', { hid: String(hid), title: '', color: '' });
    // `created`: the control is new, so yaqatw paints it (with its WebAdapter repainting then).
    return { applied: true, created: true };
  }

  // ─── Local storage (getItem/setItem), as Euro-Office keeps it ──────────────────────────────

  function kvGet(k) {
    try {
      const raw = localStorage.getItem(KV_PREFIX + k);
      return raw == null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function kvSet(k, v) {
    try {
      localStorage.setItem(KV_PREFIX + k, JSON.stringify(v));
    } catch (e) {
      console.warn('[word] could not keep', k, e);
    }
  }
  function kvRemove(k) {
    try {
      localStorage.removeItem(KV_PREFIX + k);
    } catch {
      /* storage unavailable */
    }
  }

  // ─── The table ─────────────────────────────────────────────────────────────────────────────

  const handlers = {
    // Handshake: yaqatw announces itself; Word is there already.
    pluginConnected: () => {
      emit('ready');
      if (markReady) {
        const ready = markReady;
        markReady = null;
        // Ready for actions once the document's type is known (coding actions depend on it).
        syncFileType().then(ready, ready);
      }
    },

    // Custom XML parts: where yaqatw keeps its entities, inside the document.
    readXmlPart: (ns, root) => op('readXmlPart', { ns, root }),
    ensureXmlPart: (ns, root) => op('ensureXmlPart', { ns, root }),
    saveXmlPart: (ns, xml) => op('saveXmlPart', { ns, xml }),
    deleteXmlParts: (ns) => op('deleteXmlParts', { ns }),

    // Per-document settings: Word's document variables, as JSON.
    getDocumentSetting: async (k) => {
      const raw = await op('getVariable', { key: SETTING_PREFIX + k });
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    setDocumentSetting: (k, v) =>
      op('setVariable', { key: SETTING_PREFIX + k, value: v == null ? null : JSON.stringify(v) }),

    // Text and the document
    getAllText: () => op('getAllText'),
    isEmpty: () => op('isEmpty'),
    getParagraphs: () => op('getParagraphs'),
    getSelectionText: () => op('getSelectionText'),
    getSelectionParagraphText: () => op('getSelectionParagraphText'),
    getCurrentFilePath: async () => (await op('getCurrentFilePath')) || info.title,
    getDocumentTitle: async () => (await op('getDocumentTitle')) || info.title,
    openDocument: notSupported('Opening another document'),
    documentContainsText,
    findAndSelectBestMatch,
    insertTextAtSelection: (text) => op('insertTextAtSelection', { text: String(text ?? '') }),
    appendText: (text) => op('appendText', { text: String(text ?? '') }),

    // Highlights (word-plugin/src/Highlights.bas)
    insertHighlightAtSelection: (code, opts) =>
      op('insertHighlightAtSelection', {
        title: (code && code.name) || '',
        color: wordColor(code && code.color),
        expandToParagraphs: Boolean(opts && opts.expandToParagraphs),
        noOverlap: Boolean(opts && opts.allowOverlappingHighlights === false),
      }),
    insertHighlightForExcerpt,
    restoreHighlight,
    setHighlightTitle: (hid, title) => op('setHighlightTitle', { hid: String(hid), title: String(title ?? '') }),
    removeHighlightControl: (hid) => op('removeHighlights', { hids: [String(hid)] }).then(() => undefined),
    removeHighlightControls: async (hids) => Number(await op('removeHighlights', { hids: (hids || []).map(String) })),
    applyHighlightUpdate: paint,
    setHighlightAppearanceForCodes: paint,
    goToHighlight: (h) => goTo(h && h.id),
    goToHighlightById: (hid) => goTo(hid),
    goToContentControl: (id) => op('goToControl', { id: String(id) }).then(() => undefined),
    getAllHighlightsInDocument: () => op('getAllHighlights'),
    getHighlightParagraphMap: () => op('getHighlightParagraphMap'),
    getCodedParagraphIndices: async () => {
      const coded = new Set();
      for (const h of await op('getHighlightParagraphMap')) for (const i of h.paragraphIndices) coded.add(i);
      return [...coded].sort((a, b) => a - b);
    },
    getComments: () => op('getComments'),
    hideAllHighlights: () => op('setHighlightsVisible', { visible: false }),
    // yaqatw's WebAdapter repaints each highlight afterwards (applyHighlightUpdate).
    refreshHighlightsInDocument: () => op('setHighlightsVisible', { visible: true }),
    // WebAdapter does these two itself; kept for completeness.
    refreshAllHighlights: none,
    updateAllHighlights: none,

    // Metadata table: the document's first table (WebAdapter writes MetadataXml itself).
    readMetadataTable: () => op('readMetadataTable'),
    readMetadataFromDocument: none,

    // Citations, figures, tables: not yet.
    insertCitationAtCursor: notSupported('Inserting citations'),
    refreshCitationDisplay: none,
    refreshAllCitations: none,
    getAllCitationControlIds: empty,
    deleteCitationControl: none,
    unlinkCitationControl: none,
    unlinkAllCitations: none,
    insertArtifactImageAtCursor: notSupported('Inserting figures'),
    refreshArtifactImageDisplay: none,
    insertTableAtCursor: notSupported('Inserting tables'),
    refreshTableCitationDisplay: none,

    // IDataStore: yaqatw keeps entities through the XML parts; these are unused (as in
    // Euro-Office), except the key/value settings.
    init: none,
    ds_getAll: empty,
    ds_getAllGlobal: empty,
    ds_add: none,
    ds_update: none,
    ds_delete: none,
    ds_refreshAll: none,
    ds_addChild: none,
    ds_populateChildren: none,
    getItem: kvGet,
    setItem: kvSet,
    removeItem: kvRemove,

    // The host's cloud sync: off. yaqatw's own sync inside the frame is unaffected.
    cloud_syncAll: none,
    cloud_pushFile: none,
    cloud_deleteFile: none,
    cloud_isEnabled: () => false,
  };

  // ─── The conversation with the frame ───────────────────────────────────────────────────────

  function post(msg) {
    if (frame.contentWindow) frame.contentWindow.postMessage(msg, YAQATW);
  }

  function emit(event, payload) {
    post({ type: 'yaqatw-rpc-event', event, payload: payload || {} });
  }

  async function answer(m) {
    const handler = Object.prototype.hasOwnProperty.call(handlers, m.method) ? handlers[m.method] : null;
    if (!handler) {
      post({ type: 'yaqatw-rpc-response', id: m.id, error: `Not supported in Word yet: ${m.method}` });
      return;
    }
    try {
      const result = await handler(...(Array.isArray(m.args) ? m.args : []));
      post({ type: 'yaqatw-rpc-response', id: m.id, result });
    } catch (err) {
      const message = cleanError(err);
      if (/^(word-busy|closed|no-session):/.test(message)) showProblem(message);
      let text = message.replace(/^[a-z-]+: /, '');
      // Word refused to wrap part of a list item: named, so yaqatw can offer to extend the
      // selection as it does in Word (with yaqatw's WebAdapter reading `errorName`).
      let errorName;
      const named = /^(HighlightBoundaryError): (.*)$/s.exec(text);
      if (named) [, errorName, text] = named;
      post({ type: 'yaqatw-rpc-response', id: m.id, error: text, ...(errorName ? { errorName } : {}) });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== YAQATW) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'yaqatw-rpc') answer(m);
    else if (m.type === 'yaqatw-host-rpc-response') settlePlugin(m);
    else if (m.type === 'yaqatw-host-rpc-event') pluginEvent(m.event, m.payload);
  });

  // ─── The other way: asking yaqatw (its HostRpcServer, as Euro-Office's menu does) ──────────
  //
  //   host → yaqatw   { type: "yaqatw-host-rpc",          id, method, args }
  //   yaqatw → host   { type: "yaqatw-host-rpc-response", id, result | error }
  //   yaqatw → host   { type: "yaqatw-host-rpc-event",    event, payload }

  const pluginCalls = new Map();
  let nextPluginCall = 1;

  function callPlugin(method, ...args) {
    const id = nextPluginCall++;
    return new Promise((resolve, reject) => {
      pluginCalls.set(id, { resolve, reject });
      post({ type: 'yaqatw-host-rpc', id, method, args });
    });
  }

  function settlePlugin(m) {
    const p = pluginCalls.get(m.id);
    if (!p) return;
    pluginCalls.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }

  // yaqatw is there once it has said pluginConnected.
  let markReady;
  const yaqatwReady = new Promise((resolve) => (markReady = resolve));
  const READY_WAIT_MS = 30000;

  function whenReady() {
    return Promise.race([
      yaqatwReady,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Yaqatw is not ready in this document yet: open it with Yaqatw › Open Yaqatw.')),
          READY_WAIT_MS,
        ),
      ),
    ]);
  }

  // ─── The document's type, for Word's ribbon ────────────────────────────────────────────────
  //
  // yaqatw keeps it in its settings inside the document, possibly encrypted: Word's ribbon could
  // not read it there. A plain copy goes into a document variable the template reads to show its
  // groups for the type, kept in step with yaqatw ("fileType" events).

  const TYPE_VARIABLE = 'yaqatw.fileType';
  let fileType = null;

  /** Takes the type, then copies it into Word in the background (actions never wait on that). */
  function mirrorFileType(type) {
    fileType = type === 'analyze' || type === 'write' ? type : null;
    const wanted = fileType;
    (async () => {
      const current = await op('getVariable', { key: TYPE_VARIABLE });
      if ((current || null) !== wanted) await op('setVariable', { key: TYPE_VARIABLE, value: wanted });
      await op('refreshRibbon');
    })().catch(() => {
      /* the document closed meanwhile */
    });
  }

  async function syncFileType() {
    let type = null;
    try {
      type = await callPlugin('getFileType');
    } catch {
      /* an older yaqatw: no type, the ribbon shows everything */
    }
    mirrorFileType(type);
  }

  function pluginEvent(event, payload) {
    if (event === 'fileType') mirrorFileType(payload && payload.fileType);
  }

  // ─── Actions: what Word's ribbon (and the code picker) ask of yaqatw ───────────────────────

  function requireAnalysis() {
    if (fileType === 'analyze') return;
    throw new Error(
      fileType === 'write'
        ? 'This is a writing document: codes are applied in analysis documents.'
        : "Choose this document's type first: Yaqatw › Open Yaqatw, then Settings › Document type: Analysis.",
    );
  }

  const actions = {
    /** The state the ribbon needs: is yaqatw there, and the document's type. */
    state: async () => ({ ready: true, fileType }),
    /** The project's codes, colours as Word shows them. */
    codes: async () => ({
      fileType,
      codes: ((await callPlugin('getCodeMenuItems')) || []).map((c) => ({
        id: String(c.id),
        name: String(c.name || ''),
        description: c.description ? String(c.description) : '',
        color: wordColor(c.color),
      })),
    }),
    applyCode: async ({ codeId }) => {
      requireAnalysis();
      await callPlugin('applyCodeToSelection', String(codeId));
    },
    newCode: async ({ name, description, color }) => {
      requireAnalysis();
      if (!name || !String(name).trim()) throw new Error('A code needs a name.');
      await callPlugin('createCodeAndApply', String(name).trim(), String(description || ''), color ? String(color) : undefined);
    },
    inVivo: async () => {
      requireAnalysis();
      await callPlugin('createInVivoCodeAndApply');
    },
  };

  word.onAction(async (name, args) => {
    if (!Object.prototype.hasOwnProperty.call(actions, name)) throw new Error(`Unknown action: ${name}`);
    await whenReady();
    return actions[name](args || {});
  });

  // ─── Word's side ───────────────────────────────────────────────────────────────────────────

  function showProblem(message) {
    if (/^(closed|no-session):/.test(message)) {
      showStatus(`“${info.title}” was closed in Word. Open it again in Word, then Yaqatw › Open Yaqatw.`, 'closed');
    } else if (/^word-busy:/.test(message)) {
      showStatus('Word is busy: finish what is open in Word, then try again.', 'closed');
      setTimeout(() => {
        if (status.textContent.startsWith('Word is busy')) showStatus('');
      }, 5000);
    }
  }

  word.onEvent((name, payload) => {
    if (name === 'selection') {
      emit('selectionchange', { parentHighlightId: (payload && payload.hid) || null });
    } else if (name === 'closed') {
      showProblem('closed: ');
    }
  });

  async function start() {
    try {
      info = Object.assign(info, await word.info());
    } catch {
      /* the title stays generic */
    }
    if (!info.open) {
      showProblem('closed: ');
      return;
    }
    frame.addEventListener('load', () => {
      showStatus('');
      frame.hidden = false;
      // yaqatw may have said pluginConnected before this listener existed; a second "ready" is
      // ignored by WebAdapter.onReady.
      emit('ready');
    });
    frame.src = EMBED;
  }

  start();
})();
