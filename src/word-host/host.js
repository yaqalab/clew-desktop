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
  const figures = window.ClewWordFigures;
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

  // Operations waiting on Word. Word picks them up when it is idle; past 2 s the page says it is
  // waiting, so a slow Word (its own background work, a dialog) is not mistaken for a hang.
  const WAITING_TEXT = 'Waiting for Word… (if a dialog is open in Word, close it)';
  let waitingOps = 0;
  let waitingTimer = null;

  function op(name, args) {
    waitingOps++;
    if (!waitingTimer) {
      waitingTimer = setTimeout(() => {
        waitingTimer = null;
        if (waitingOps > 0 && !status.textContent) showStatus(WAITING_TEXT);
      }, 2000);
    }
    const done = () => {
      waitingOps--;
      if (waitingOps > 0) return;
      clearTimeout(waitingTimer);
      waitingTimer = null;
      if (status.textContent === WAITING_TEXT) showStatus('');
    };
    return word.call(name, args).then(
      (v) => {
        done();
        return v;
      },
      (err) => {
        done();
        throw err;
      },
    );
  }

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

  // ─── Yaqatw's AI requests, reviewed by Clew ────────────────────────────────────────────────
  // Before Yaqatw sends an AI request that carries text, it asks here (yaqatw:
  // src/service/ai/aiGate.ts). A model on this computer passes: nothing leaves. Anything else is
  // shown in a window in front (review.html, through the main process) once per run, and goes
  // only on Send. A Word document has no Clew names list, so nothing is replaced: the review says
  // so, and the answer comes back untouched (aiGate_restore).

  /** Keys whose values are a request's settings, not its text: left out of the review. */
  const SETTING_KEYS = new Set([
    'role', 'model', 'type', 'format', 'response_format', 'mime_type', 'mimeType',
    'source_lang', 'target_lang', 'source', 'target', 'tool_choice', 'stop', 'id', 'object',
  ]);

  /** The text a request carries: every string but its settings, longest first. */
  function contentOf(payload) {
    const out = [];
    const walk = (v) => {
      if (typeof v === 'string') {
        if (v.trim()) out.push(v);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) if (!SETTING_KEYS.has(k)) walk(x);
      }
    };
    walk(payload);
    return out.sort((a, b) => b.length - a.length);
  }

  /** localhost, 127.0.0.0/8 or ::1: a model on this computer. */
  function isLocalEndpoint(endpoint) {
    try {
      const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
      return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    } catch (_err) {
      return false;
    }
  }

  // Each run's answer: asked once, shared by its requests that arrive while it is asked.
  const reviewedRuns = new Map();

  async function reviewAi(request) {
    const r = request && typeof request === 'object' ? request : {};
    if (typeof r.endpoint !== 'string' || !r.endpoint) {
      return { allow: false, reason: 'Clew could not read this AI request, so it was not sent.' };
    }
    if (isLocalEndpoint(r.endpoint)) return { allow: true, payload: r.payload };
    const runId = typeof r.runId === 'string' ? r.runId : '';
    let answer = runId ? reviewedRuns.get(runId) : undefined;
    if (!answer) {
      let host = r.endpoint;
      try {
        host = new URL(r.endpoint).host;
      } catch (_err) {
        // shown as given
      }
      answer = word.review({
        feature: typeof r.feature === 'string' ? r.feature : 'AI request',
        provider: typeof r.provider === 'string' ? r.provider : '',
        model: typeof r.model === 'string' ? r.model : '',
        host,
        kind: r.kind === 'audio' ? 'audio' : 'json',
        bytes: r.kind === 'audio' && r.payload && typeof r.payload.bytes === 'number' ? r.payload.bytes : 0,
        texts: r.kind === 'audio' ? [] : contentOf(r.payload),
      });
      if (runId) reviewedRuns.set(runId, answer);
    }
    // A run cancelled once stays cancelled: its next requests are not asked about again.
    return (await answer) ? { allow: true, payload: r.payload } : { allow: false, cancelled: true };
  }

  // ─── The table ─────────────────────────────────────────────────────────────────────────────

  const handlers = {
    // Handshake: yaqatw announces itself; Word is there already.
    pluginConnected: () => {
      emit('ready');
      // Clew reviews Yaqatw's AI requests before they go (aiGate_review below). An older
      // yaqatw refuses the call and sends as it always did.
      if (typeof word.review === 'function') {
        callPlugin('setHostFeatures', { name: 'Clew', aiGate: true }).catch(() => {});
      }
      // A yaqatw loaded again may answer other methods: ask it again.
      capabilities = undefined;
      if (markReady) {
        const ready = markReady;
        markReady = null;
        // Ready for actions once the document's type is known (coding actions depend on it).
        syncFileType().then(ready, ready);
      }
    },

    // Yaqatw's AI requests, reviewed before they go (reviewAi below). Nothing is replaced in a
    // Word document, so the answer comes back as it is.
    aiGate_review: (request) => reviewAi(request),
    aiGate_restore: (_token, answer) => answer,

    // Custom XML parts: where yaqatw keeps its entities, inside the document.
    readXmlPart: (ns, root) => op('readXmlPart', { ns, root }),
    ensureXmlPart: (ns, root) => op('ensureXmlPart', { ns, root }),
    saveXmlPart: async (ns, xml) => {
      const saved = await op('saveXmlPart', { ns, xml });
      if (ns === SETTINGS_NS) settingsSaved(xml);
      return saved;
    },
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

    // Quotes, notes, figures and tables in a writing document (word-plugin/src/Citations.bas).
    // Each linked one is a content control whose id yaqatw keeps to refresh it.
    insertCitationAtCursor: (o) =>
      op('insertCitation', {
        title: String((o && o.title) || ''),
        text: String((o && o.formattedText) ?? ''),
        block: Boolean(o && o.style === 'block'),
      }),
    refreshCitationDisplay: (id, text, isBlock) =>
      op('refreshCitation', { id: String(id), text: String(text ?? ''), block: Boolean(isBlock) }).then(none),
    // WebAdapter refreshes them all itself, one by one through the methods here.
    refreshAllCitations: none,
    getAllCitationControlIds: () => op('citationIds'),
    deleteCitationControl: (id) => op('deleteCitation', { id: String(id) }).then(none),
    unlinkCitationControl: (id) => op('unlinkCitation', { id: String(id) }).then(none),
    unlinkAllCitations: () => op('unlinkAllCitations').then(none),
    insertArtifactImageAtCursor: (o) =>
      op('insertCitationXml', {
        title: `Artifact: ${(o && o.title) || ''}`.slice(0, 255),
        xml: figures.figurePackage(o),
        link: Boolean(o && o.createControl),
      }),
    refreshArtifactImageDisplay: (id, o) =>
      op('refreshCitationXml', { id: String(id), xml: figures.figurePackage(o) }).then(none),
    // The table's Word XML is made by yaqatw, which passes it as opts.ooxml.
    insertTableAtCursor: (doc, opts) => {
      if (!opts || typeof opts.ooxml !== 'string') {
        throw new Error('Inserting tables in Word needs a newer Yaqatw: reload Yaqatw and try again.');
      }
      return op('insertCitationXml', {
        title: `Table: ${String((doc && doc.title) || '').slice(0, 30)}`,
        xml: opts.ooxml,
        link: Boolean(opts.link),
      });
    },
    refreshTableCitationDisplay: (id, ooxml) =>
      op('refreshCitationXml', { id: String(id), xml: String(ooxml ?? '') }).then(none),

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
  // yaqatw keeps it in its settings inside the document (a custom XML part Word's ribbon has no
  // way to read). A plain copy goes into a document variable the template reads to show its
  // groups for the type. The type comes from yaqatw (getFileType, then its "fileType" events);
  // a yaqatw too old to say is read in the document's settings part instead, and every save of
  // that part, which passes through this page, carries the type as it now is.

  const TYPE_VARIABLE = 'yaqatw.fileType';
  const FEATURES_VARIABLE = 'yaqatw.features';
  const SETTINGS_NS = 'http://yaqat.alefa.net/xml/settings';
  let fileType = null;

  /** The type in yaqatw's settings XML (`<setting … name="yaqatw-file-type" value="…"/>`), or null. */
  function fileTypeIn(xml) {
    const el = /<setting\b[^>]*\bname="yaqatw-file-type"[^>]*>/.exec(String(xml || ''));
    const value = el && /\bvalue="([^"]*)"/.exec(el[0]);
    return value ? value[1] : null;
  }

  /** Takes the type, then copies it into Word in the background (actions never wait on that). */
  function mirrorFileType(type) {
    fileType = type === 'analyze' || type === 'write' ? type : null;
    const wanted = fileType;
    (async () => {
      const current = await op('getVariable', { key: TYPE_VARIABLE });
      if ((current || null) !== wanted) await op('setVariable', { key: TYPE_VARIABLE, value: wanted });
      // What this yaqatw can do, for the right-click entries that depend on it (Ribbon.bas
      // HasFeature): "categories,relationships,…".
      const features = (await featureList()).join(',');
      const known = await op('getVariable', { key: FEATURES_VARIABLE });
      if ((known || '') !== features) await op('setVariable', { key: FEATURES_VARIABLE, value: features || null });
      await op('refreshRibbon');
    })().catch(() => {
      /* the document closed meanwhile */
    });
  }

  // ─── What this yaqatw can do (its getCapabilities), so Word shows only that ────────────────

  /** Each feature of Word's windows and menus, and the yaqatw methods it needs. */
  const FEATURES = {
    categories: ['getCategoryMenuItems', 'getCategoriesForCode', 'attachCategoryToCode', 'detachCategoryFromCode', 'createCategoryAndAttach'],
    editCode: ['updateCode'],
    editCategory: ['updateCategory'],
    relationships: [
      'getRelationshipMenu',
      'getRelationshipsForCode',
      'addCodeToInstance',
      'removeCodeFromInstance',
      'createRelationshipAndAttach',
      'addInstanceWithCode',
    ],
    removeHighlight: ['deleteHighlight'],
    manage: ['getCodeUsage', 'deprecateCode', 'mergeCode', 'removeCodeFromFile', 'deleteCode'],
    showPassages: ['showHighlightsForCode'],
    // A category, not only a code, in a relationship.
    relationshipCategories: ['getCategoriesForCode', 'getCategoryMenuItems', 'addItemToInstance', 'addInstanceWithItem', 'createRelationshipWithItem'],
  };
  // A yaqatw from before getCapabilities: what Word offered then (callNewer still says when a
  // method is missing). test/word-yaqatw-rpc.test.js checks every method named on this page
  // against yaqatw's HostRpcServer, when YAQATW_PATH says where yaqatw is.
  const BEFORE_CAPABILITIES = ['categories', 'editCode'];
  /** The method names yaqatw answers; undefined until asked, null when it cannot say. */
  let capabilities;

  async function featureList() {
    if (capabilities === undefined) {
      try {
        const c = await callPlugin('getCapabilities');
        capabilities = new Set(((c && c.methods) || []).map(String));
      } catch {
        capabilities = null;
      }
    }
    const methods = capabilities;
    return Object.keys(FEATURES).filter((f) =>
      methods ? FEATURES[f].every((m) => methods.has(m)) : BEFORE_CAPABILITIES.includes(f),
    );
  }

  async function syncFileType() {
    let type = null;
    try {
      type = await callPlugin('getFileType');
    } catch {
      // A yaqatw without getFileType: the document's own settings part says.
      try {
        type = fileTypeIn(await op('readXmlPart', { ns: SETTINGS_NS, root: 'settings' }));
      } catch {
        /* no type: the ribbon shows everything */
      }
    }
    mirrorFileType(type);
  }

  /** yaqatw saves its settings part: the type, as it now is, follows at once. */
  function settingsSaved(xml) {
    const type = fileTypeIn(xml);
    if ((type === 'analyze' || type === 'write' ? type : null) !== fileType) mirrorFileType(type);
  }

  function pluginEvent(event, payload) {
    if (event === 'fileType') mirrorFileType(payload && payload.fileType);
  }

  // ─── Actions: what Word's ribbon (and the code picker) ask of yaqatw ───────────────────────

  /** Why codes cannot be applied in this document, or "" when they can. */
  function codingNote() {
    if (fileType === 'analyze') return '';
    return fileType === 'write'
      ? 'This is a writing document: codes are applied in analysis documents.'
      : "Choose this document's type first: Yaqatw › Open Yaqatw, then Settings › Document type: Analysis.";
  }

  function requireAnalysis() {
    const note = codingNote();
    if (note) throw new Error(note);
  }

  // Codes applied here lately, most recent first: kept in this origin's storage, which the code
  // picker (picker.js) shares, so Word's menus and the picker put the same codes first.
  const RECENT_KEY = 'picker.recent';
  function recentCodes() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [];
    }
  }
  function rememberCode(codeId) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([codeId, ...recentCodes().filter((id) => id !== codeId)].slice(0, 20)));
    } catch {
      /* storage unavailable */
    }
  }

  const actions = {
    /** The state the ribbon needs: is yaqatw there, and the document's type. */
    state: async () => ({ ready: true, fileType }),
    /**
     * The project's codes as yaqatw offers them, colours as Word shows them, the ones applied
     * here lately first (one list for Word's menus and the picker). `note`: why codes cannot be
     * applied in this document, for the menus to say ("" when they can).
     */
    codes: async () => {
      const codes = ((await callPlugin('getCodeMenuItems')) || []).map((c) => ({
        id: String(c.id),
        name: String(c.name || ''),
        description: c.description ? String(c.description) : '',
        color: wordColor(c.color),
      }));
      const order = recentCodes();
      const rank = (c) => (order.includes(c.id) ? order.indexOf(c.id) : Infinity);
      // A stable sort: the others keep yaqatw's order.
      codes.sort((a, b) => rank(a) - rank(b));
      return { fileType, note: codingNote(), codes };
    },
    // Actions from Word's menus answer `{ status }`: one line Word shows in its status bar.
    applyCode: async ({ codeId }) => {
      requireAnalysis();
      await callPlugin('applyCodeToSelection', String(codeId));
      rememberCode(String(codeId));
      return { status: `${await codeName(codeId)} applied.` };
    },
    newCode: async ({ name, description, color }) => {
      requireAnalysis();
      if (!name || !String(name).trim()) throw new Error('A code needs a name.');
      await callPlugin('createCodeAndApply', String(name).trim(), String(description || ''), color ? String(color) : undefined);
    },
    inVivo: async () => {
      requireAnalysis();
      await callPlugin('createInVivoCodeAndApply');
      return { status: 'In vivo code applied.' };
    },
    /** What this yaqatw can do, by feature (FEATURES): the windows show only that. */
    features: async () => ({ features: await featureList() }),

    // Highlight info (the ribbon, Word's right-click menu): what yaqatw shows when a coded passage
    // is clicked, for the passage at Word's cursor. Text fields are saved together; codes at once.
    // Each code comes with its categories and relationships when yaqatw can say, and the
    // project's categories to add one.
    highlightInfo: async ({ hid }) => {
      requireAnalysis();
      const h = await passage(hid);
      const features = await featureList();
      const has = (f) => features.includes(f);
      const codes = [];
      for (const c of h.codes || []) {
        const code = { id: String(c.id), name: String(c.name || ''), color: wordColor(c.color) };
        if (has('categories')) {
          const inAlready = await callPlugin('getCategoriesForCode', code.id).catch(() => null);
          if (Array.isArray(inAlready)) {
            code.categories = inAlready.map((k) => ({ id: String(k.id), name: String(k.name || ''), description: String(k.description || '') }));
          }
        }
        if (has('relationships')) {
          const links = await callPlugin('getRelationshipsForCode', code.id).catch(() => null);
          if (Array.isArray(links)) {
            code.relationships = links.map((r) => ({
              relationshipId: String(r.relationshipId),
              name: String(r.name || ''),
              instanceId: String(r.instanceId),
              instanceName: String(r.instanceName || ''),
            }));
          }
        }
        codes.push(code);
      }
      const categories = has('categories') ? (await callPlugin('getCategoryMenuItems').catch(() => null)) || [] : [];
      return {
        text: String(h.text || ''),
        translation: String(h.translation || ''),
        comment: String(h.comment || ''),
        codes,
        categories: categories.map((k) => ({ id: String(k.id), name: String(k.name || '') })),
        features,
      };
    },
    /** Remove highlight: to yaqatw's Trash, its mark leaves the document (the text stays). */
    removeHighlight: async ({ hid }) => {
      requireAnalysis();
      await callNewer('deleteHighlight', String(hid));
      return { status: "Highlight removed: it is in Yaqatw's Trash." };
    },
    saveHighlightInfo: async ({ hid, translation, comment }) => {
      requireAnalysis();
      await callNewer('updateHighlightDetails', String(hid), { translation: String(translation ?? ''), comment: String(comment ?? '') });
    },
    /** `{ deleted }`: true when it was the passage's last code, and the highlight went with it. */
    detachCode: async ({ hid, codeId }) => {
      requireAnalysis();
      const r = await callNewer('detachCodeFromHighlight', String(hid), String(codeId));
      return { deleted: Boolean(r && r.deleted) };
    },
    attachCode: async ({ hid, codeId }) => {
      requireAnalysis();
      await callNewer('attachCodeToHighlight', String(hid), String(codeId));
    },
    // Add to category (Word's right-click menu, in a coded passage): a category holds codes, so
    // the passage's codes, each with the categories it is in, and all the categories.
    categoryMenu: async ({ hid }) => {
      requireAnalysis();
      const h = await passage(hid);
      const all = (await callNewer('getCategoryMenuItems')) || [];
      const codes = [];
      for (const c of h.codes || []) {
        const inAlready = (await callNewer('getCategoriesForCode', String(c.id))) || [];
        codes.push({ id: String(c.id), name: String(c.name || ''), color: wordColor(c.color), categories: inAlready.map((k) => String(k.id)) });
      }
      return { codes, categories: all.map((k) => ({ id: String(k.id), name: String(k.name || '') })) };
    },
    addToCategory: async ({ categoryId, codeId }) => {
      requireAnalysis();
      await callNewer('attachCategoryToCode', String(categoryId), String(codeId));
      return { status: `${await codeName(codeId)} added to ${await categoryName(categoryId)}.` };
    },
    removeFromCategory: async ({ categoryId, codeId }) => {
      requireAnalysis();
      await callNewer('detachCategoryFromCode', String(categoryId), String(codeId));
      return { status: `${await codeName(codeId)} taken out of ${await categoryName(categoryId)}.` };
    },

    // Add to relationship (Word's right-click menu, in a coded passage). A relationship holds
    // codes and categories in its instances: the passage's codes, then the categories they are
    // directly in (once each, when yaqatw can put a category in a relationship), each with every
    // relationship and its instances (`holds`: the item is in it). Parent categories are the
    // window's (relateItems).
    relationshipMenu: async ({ hid }) => {
      requireAnalysis();
      const h = await passage(hid);
      const items = (h.codes || []).map((c) => ({ kind: 'code', id: String(c.id), name: String(c.name || ''), color: wordColor(c.color) }));
      if ((await featureList()).includes('relationshipCategories')) {
        const seen = new Set();
        for (const code of items.slice()) {
          for (const k of (await callNewer('getCategoriesForCode', code.id)) || []) {
            if (seen.has(String(k.id))) continue;
            seen.add(String(k.id));
            items.push({ kind: 'category', id: String(k.id), name: String(k.name || '') });
          }
        }
      }
      for (const item of items) item.relationships = await relationshipsOf(item.id);
      return { items };
    },
    /**
     * The window's list (Add to relationship › More…): the passage's codes, each with the
     * categories it is in and their parents, as an indented tree (`depth`).
     */
    relateItems: async ({ hid }) => {
      requireAnalysis();
      const h = await passage(hid);
      const withCategories = (await featureList()).includes('relationshipCategories');
      const all = withCategories ? (await callNewer('getCategoryMenuItems')) || [] : [];
      const byId = new Map(all.map((k) => [String(k.id), k]));
      const items = [];
      for (const c of h.codes || []) {
        items.push({ kind: 'code', id: String(c.id), name: String(c.name || ''), color: wordColor(c.color), depth: 0 });
        if (!withCategories) continue;
        for (const k of (await callNewer('getCategoriesForCode', String(c.id))) || []) {
          // The category, then its parent, its parent's parent… (a loop in the data stops it).
          const seen = new Set();
          let at = byId.get(String(k.id)) || k;
          for (let depth = 1; at && !seen.has(String(at.id)) && depth < 12; depth++) {
            seen.add(String(at.id));
            items.push({ kind: 'category', id: String(at.id), name: String(at.name || ''), depth });
            at = at.parentId ? byId.get(String(at.parentId)) : null;
          }
        }
      }
      return { items, categories: withCategories };
    },
    /** Every relationship and its instances, each saying whether it holds `itemId`. */
    itemRelationships: async ({ itemId }) => {
      requireAnalysis();
      return { relationships: await relationshipsOf(String(itemId)) };
    },
    addToRelationship: async (args) => {
      requireAnalysis();
      const item = itemOf(args);
      const rel = String(args.relationshipId);
      const inst = String(args.instanceId);
      if (item.category) await callNewer('addItemToInstance', rel, inst, item.id, 'CategoryXml');
      else await callNewer('addCodeToInstance', rel, inst, item.id);
      return { status: `${await itemName(item)} added to ${await instanceName(rel, inst)}.` };
    },
    removeFromRelationship: async (args) => {
      requireAnalysis();
      const item = itemOf(args);
      // yaqatw takes any item out by its id.
      await callNewer('removeCodeFromInstance', String(args.relationshipId), String(args.instanceId), item.id);
      return { status: `${await itemName(item)} taken out of ${await instanceName(args.relationshipId, args.instanceId)}.` };
    },
    /** A new instance of a relationship (yaqatw names it "<relationship> N"), holding the item. */
    newInstance: async (args) => {
      requireAnalysis();
      const item = itemOf(args);
      const rel = String(args.relationshipId);
      if (item.category) await callNewer('addInstanceWithItem', rel, item.id, 'CategoryXml');
      else await callNewer('addInstanceWithCode', rel, item.id);
      return { status: `A new instance of ${await instanceName(rel)} holds ${lower(await itemName(item))}.` };
    },
    /** A new relationship (name, description) whose first instance holds the item. */
    newRelationship: async (args) => {
      requireAnalysis();
      const item = itemOf(args);
      const wanted = String(args.name || '').trim();
      if (!wanted) throw new Error('A relationship needs a name.');
      const description = String(args.description || '').trim();
      const r = item.category
        ? await callNewer('createRelationshipWithItem', wanted, description, item.id, 'CategoryXml')
        : await callNewer('createRelationshipAndAttach', wanted, description, item.id);
      return { id: String(r && r.id) };
    },
    /** The project's categories (the form window names the one it is for). */
    categories: async () => ({
      categories: ((await callNewer('getCategoryMenuItems')) || []).map((k) => ({ id: String(k.id), name: String(k.name || '') })),
    }),

    // Managing a code (Highlight info › Manage): its reach first (codeUsage), then the action.
    // Each one is undone in Yaqatw (Reactivate, Unmerge, Trash), never by Word's Undo.
    codeUsage: async ({ codeId }) => {
      requireAnalysis();
      const u = (await callNewer('getCodeUsage', String(codeId))) || {};
      return { here: Number(u.here) || 0, elsewhere: Number(u.elsewhere) || 0, files: Number(u.files) || 0 };
    },
    deprecateCode: async ({ codeId, reason }) => {
      requireAnalysis();
      await callNewer('deprecateCode', String(codeId), String(reason || '').trim());
    },
    mergeCode: async ({ codeId, targetId }) => {
      requireAnalysis();
      if (!targetId || String(targetId) === String(codeId)) throw new Error('Choose another code to merge into.');
      const r = await callNewer('mergeCode', String(codeId), String(targetId));
      return { targetId: String((r && r.targetId) || targetId) };
    },
    removeCodeFromFile: async ({ codeId }) => {
      requireAnalysis();
      const r = (await callNewer('removeCodeFromFile', String(codeId))) || {};
      return { removedHighlights: Number(r.removedHighlights) || 0, updatedHighlights: Number(r.updatedHighlights) || 0 };
    },
    deleteCode: async ({ codeId }) => {
      requireAnalysis();
      await callNewer('deleteCode', String(codeId));
    },
    /** The code's passages in yaqatw's window (main.js shows the window). */
    showPassages: async ({ codeId }) => {
      await callNewer('showHighlightsForCode', String(codeId));
    },
    /**
     * A new category (name, description) holding the code, from the New category window; a name
     * already taken puts the code in that category instead (its description stays as it is).
     */
    newCategory: async ({ codeId, name, description }) => {
      requireAnalysis();
      const wanted = String(name || '').trim();
      if (!wanted) throw new Error('A category needs a name.');
      const all = (await callNewer('getCategoryMenuItems')) || [];
      const same = all.find((k) => String(k.name || '').trim().toLowerCase() === wanted.toLowerCase());
      if (same) {
        await callNewer('attachCategoryToCode', String(same.id), String(codeId));
        return { id: String(same.id), existed: true };
      }
      const r = await callNewer('createCategoryAndAttach', wanted, String(description || '').trim(), String(codeId));
      return { id: String(r && r.id), existed: false };
    },
    /** A code's name, description, colour (only those given); yaqatw repaints its passages. */
    editCode: async ({ codeId, name, description, color }) => {
      requireAnalysis();
      const updates = {};
      if (name !== undefined) {
        if (!String(name).trim()) throw new Error('A code needs a name.');
        updates.name = String(name).trim();
      }
      if (description !== undefined) updates.description = String(description);
      if (color) updates.color = String(color);
      await callNewer('updateCode', String(codeId), updates);
    },
    /** A category's name and description (only those given); a name another category has is refused by yaqatw. */
    editCategory: async ({ categoryId, name, description }) => {
      requireAnalysis();
      const updates = {};
      if (name !== undefined) {
        if (!String(name).trim()) throw new Error('A category needs a name.');
        updates.name = String(name).trim();
      }
      if (description !== undefined) updates.description = String(description).trim();
      await callNewer('updateCategory', String(categoryId), updates);
    },
    /** The translators that have their settings in yaqatw (none: no Translate button). */
    translateProviders: async () => {
      const list = await callNewer('getTranslateProviders');
      return { providers: (Array.isArray(list) ? list : []).map((p) => ({ key: String(p.key), label: String(p.label || p.key) })) };
    },
    translateHighlight: async ({ hid, provider }) => ({
      text: String((await callNewer('translateHighlightText', String(hid), String(provider))) ?? ''),
    }),

    // Writing: what yaqatw's Writing › Cite does, from Word's ribbon and the insert window.
    /** Quotes, artifacts, notes, tables, figures matching `query`, each with how it can go in. */
    searchCites: async ({ query, source, limit }) => {
      requireWriting();
      const items = await callWriting('searchCiteSources', String(query || ''), String(source || 'all'), Number(limit) || 30);
      return { items: Array.isArray(items) ? items : [] };
    },
    insertCite: async ({ source, id, option }) => {
      requireWriting();
      await callWriting('insertCiteSource', String(source), String(id), option ? String(option) : undefined);
    },
    refreshCitations: async () => {
      requireWriting();
      await callWriting('refreshAllCitations');
    },
    unlinkCitations: async () => {
      requireWriting();
      await callWriting('unlinkAllCitations');
    },
  };

  /** A yaqatw method recent ones have; one too old to have it says so plainly. */
  async function callNewer(method, ...args) {
    try {
      return await callPlugin(method, ...args);
    } catch (err) {
      if (/Unknown method/.test(cleanError(err))) {
        throw new Error('This needs a newer Yaqatw: update Clew Desktop, then try again.');
      }
      throw err;
    }
  }

  /** The coded passage `hid` as yaqatw keeps it; one it has no record of is said so. */
  async function passage(hid) {
    const h = await callNewer('getHighlightDetails', String(hid));
    if (!h) throw new Error('Yaqatw has no record of this passage: it was deleted, or not saved yet.');
    return h;
  }

  // Names for the status line, looked up after the action: a lookup that fails leaves a plain word.
  const quoted = (name) => `“${name}”`;
  async function codeName(codeId) {
    const list = await callPlugin('getCodeMenuItems').catch(() => null);
    const c = (Array.isArray(list) ? list : []).find((x) => String(x.id) === String(codeId));
    return c && c.name ? quoted(c.name) : 'The code';
  }
  async function categoryName(categoryId) {
    const list = await callPlugin('getCategoryMenuItems').catch(() => null);
    const k = (Array.isArray(list) ? list : []).find((x) => String(x.id) === String(categoryId));
    return k && k.name ? quoted(k.name) : 'the category';
  }
  /**
   * What a relationship action is about: `{ itemId, kind }` ("code" or "category"), or a code's
   * `codeId` as the first menus sent it.
   */
  function itemOf({ itemId, kind, codeId }) {
    const id = String(itemId ?? codeId ?? '');
    if (!id) throw new Error('No code or category to put in the relationship.');
    return { id, category: kind === 'category' };
  }
  /** “Name” of a code, or the category “Name”, for the status line. */
  async function itemName(item) {
    if (!item.category) return codeName(item.id);
    const name = await categoryName(item.id);
    return name === 'the category' ? 'The category' : `The category ${name}`;
  }
  const lower = (s) => (/^The /.test(s) ? `t${s.slice(1)}` : s);

  /** Every relationship with its instances, `holds` when the instance has `itemId`. */
  async function relationshipsOf(itemId) {
    const rels = (await callNewer('getRelationshipMenu', String(itemId))) || [];
    return rels.map((r) => ({
      id: String(r.id),
      name: String(r.name || ''),
      instances: (r.instances || []).map((i) => ({ id: String(i.id), name: String(i.name || ''), holds: Boolean(i.hasCode) })),
    }));
  }

  /** “Relationship”, or “Relationship › Instance” when it has several instances. */
  async function instanceName(relationshipId, instanceId) {
    const list = await callPlugin('getRelationshipMenu').catch(() => null);
    const r = (Array.isArray(list) ? list : []).find((x) => String(x.id) === String(relationshipId));
    if (!r || !r.name) return 'the relationship';
    const instances = r.instances || [];
    const i = instances.find((x) => String(x.id) === String(instanceId));
    return instanceId && i && instances.length > 1 ? quoted(`${r.name} › ${i.name}`) : quoted(r.name);
  }

  /** A yaqatw method for writing; one too old to have it says so plainly. */
  async function callWriting(method, ...args) {
    try {
      return await callPlugin(method, ...args);
    } catch (err) {
      if (/Unknown method/.test(cleanError(err))) {
        throw new Error('Inserting from Word needs a newer Yaqatw: update Clew Desktop, then try again.');
      }
      throw err;
    }
  }

  function requireWriting() {
    if (fileType === 'write') return;
    throw new Error(
      fileType === 'analyze'
        ? 'This is an analysis document: quotes and figures are inserted in writing documents.'
        : "Choose this document's type first: Yaqatw › Open Yaqatw, then Settings › Document type: Writing.",
    );
  }

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
      showStatus('Word did not answer for 30 seconds: if a dialog is open in Word, close it, then try again.', 'closed');
      setTimeout(() => {
        if (status.textContent.startsWith('Word did not answer')) showStatus('');
      }, 8000);
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
