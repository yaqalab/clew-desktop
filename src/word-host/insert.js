/**
 * The insert window of a Word document (Yaqatw › Insert in Word's ribbon), in the manner of
 * Zotero's quick citation: type to find a quote (a highlight), an artifact, a note, a table or a
 * figure; a click or Enter inserts it at the cursor in Word, the usual way; the arrow (or →) shows
 * the other ways (block quote, translation, a picture, not linked…). The search and the insert
 * are the document's own Yaqatw's (Writing › Cite), through its Word window (host.js).
 */
(function () {
  'use strict';

  const word = window.clewWord;
  const { wordColor } = window.ClewWordColors;
  const $ = (id) => document.getElementById(id);
  const LIMIT = 50;
  const SOURCE_LABELS = { highlights: 'Quote', artifacts: 'Artifact', notes: 'Note', tables: 'Table', figures: 'Figure' };

  let items = [];
  let rows = []; // what the list shows: { item, option } (option null for the item itself)
  let selected = 0;
  let expanded = null; // the item whose other ways are shown
  let busy = false;
  let searchTimer = null;
  let searchSeq = 0;

  function message(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }

  function cleanError(err) {
    const msg = err && err.message ? err.message : String(err);
    const m = /^Error invoking remote method '[^']+': (?:Error: )?(.*)$/s.exec(msg);
    return m ? m[1] : msg;
  }

  // ─── Finding ───────────────────────────────────────────────────────────────────────────────

  async function search() {
    const seq = ++searchSeq;
    const query = $('q').value.trim();
    try {
      const r = await word.action('searchCites', { query, source: $('source').value, limit: LIMIT });
      if (seq !== searchSeq) return; // a later search answers
      items = (r && r.items) || [];
      expanded = null;
      selected = 0;
      message(items.length ? '' : query ? `Nothing found for “${query}”.` : 'Nothing to insert here yet.');
    } catch (err) {
      if (seq !== searchSeq) return;
      items = [];
      message(cleanError(err));
    }
    render();
  }

  function searchSoon() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      search();
    }, 250);
  }

  function itemRow(item, i) {
    const li = document.createElement('li');
    li.className = 'item';
    li.setAttribute('role', 'option');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = item.color ? wordColor(item.color) : 'transparent';
    if (!item.color) dot.style.visibility = 'hidden';
    const body = document.createElement('span');
    body.className = 'body';
    const head = document.createElement('span');
    head.className = 'head';
    head.textContent = [SOURCE_LABELS[item.source] || '', item.title].filter(Boolean).join(' · ');
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = item.text || '';
    body.append(head, text);
    const more = document.createElement('button');
    more.className = 'more';
    more.type = 'button';
    more.title = 'Other ways to insert';
    more.setAttribute('aria-label', 'Other ways to insert');
    more.textContent = expanded === item ? '▾' : '▸';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(item);
    });
    li.append(dot, body);
    if ((item.options || []).length > 1) li.append(more);
    li.addEventListener('mousemove', () => select(i));
    li.addEventListener('click', () => insert(i));
    return li;
  }

  function optionRow(option, i) {
    const li = document.createElement('li');
    li.className = 'way';
    li.setAttribute('role', 'option');
    li.textContent = option.label;
    li.addEventListener('mousemove', () => select(i));
    li.addEventListener('click', () => insert(i));
    return li;
  }

  function render() {
    rows = [];
    for (const item of items) {
      rows.push({ item, option: null });
      if (item === expanded) for (const option of item.options || []) rows.push({ item, option });
    }
    const list = $('list');
    list.replaceChildren(...rows.map((r, i) => (r.option ? optionRow(r.option, i) : itemRow(r.item, i))));
    select(Math.min(selected, rows.length - 1));
  }

  function select(i) {
    selected = Math.max(0, Math.min(i, rows.length - 1));
    [...$('list').children].forEach((li, j) => li.setAttribute('aria-selected', String(j === selected)));
    const el = $('list').children[selected];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function toggle(item) {
    const at = items.indexOf(item);
    expanded = expanded === item ? null : item;
    render();
    select(rows.findIndex((r) => r.item === items[at] && !r.option));
  }

  // ─── Inserting ─────────────────────────────────────────────────────────────────────────────

  async function insert(i) {
    const row = rows[i];
    if (busy || !row) return;
    const option = row.option || (row.item.options || [])[0];
    busy = true;
    message('Inserting…');
    try {
      await word.action('insertCite', { source: row.item.source, id: row.item.id, option: option ? option.key : undefined });
      word.close();
    } catch (err) {
      message(cleanError(err));
    } finally {
      busy = false;
    }
  }

  // ─── Keys and buttons ──────────────────────────────────────────────────────────────────────

  $('q').addEventListener('input', searchSoon);
  $('source').addEventListener('change', () => {
    search();
    $('q').focus();
  });

  /** Arrows left and right move in the search box, except at its ends. */
  function caretAt(end) {
    const q = $('q');
    if (document.activeElement !== q) return true;
    return end ? q.selectionStart === q.value.length : q.selectionEnd === 0;
  }

  document.addEventListener('keydown', (e) => {
    const row = rows[selected];
    if (e.key === 'Escape') {
      if (expanded) toggle(expanded);
      else word.close();
    } else if (e.key === 'ArrowDown') select(selected + 1);
    else if (e.key === 'ArrowUp') select(selected - 1);
    else if (e.key === 'ArrowRight' && row && row.item !== expanded && row.item.options.length > 1 && caretAt(true)) {
      toggle(row.item);
    } else if (e.key === 'ArrowLeft' && row && row.item === expanded && caretAt(false)) {
      toggle(row.item);
    } else if (e.key === 'Enter' && document.activeElement !== $('source')) {
      // Typed and not searched yet: search first, then insert what it found first.
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
        search().then(() => insert(0));
      } else insert(selected);
    } else return;
    e.preventDefault();
  });
  $('full').addEventListener('click', () => word.action('showWindow').catch(() => {}).then(() => word.close()));

  function start() {
    const source = new URLSearchParams(location.search).get('source');
    if ([...$('source').options].some((o) => o.value === source)) $('source').value = source;
    message('Loading…');
    search();
    $('q').focus();
  }

  start();
})();
