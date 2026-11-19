/**
 * The code picker of a Word document (Yaqatw › Find code… / New code… in Word's ribbon): a small
 * window in the manner of Zotero's quick citation. Type to find a code, Enter applies it to the
 * selection in Word; "New code" creates one (Word's 16 highlight colours) and applies it. Every
 * action goes to the document's own Yaqatw (its Word window, src/word-host/host.js), through
 * window.clewWord.action. Codes applied lately come first, as the host page orders them (one
 * list with Word's Apply code menu).
 * New category and New relationship are form.html's.
 */
(function () {
  'use strict';

  const word = window.clewWord;
  const { PALETTE, wordColor } = window.ClewWordColors;
  const $ = (id) => document.getElementById(id);
  const MAX_SHOWN = 200;

  let codes = [];
  let shown = [];
  let selected = 0;
  let busy = false;
  let chosenColor = PALETTE[1].hex;

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

  function matches(code, q) {
    if (!q) return true;
    const hay = `${code.name} ${code.description || ''}`.toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((word) => hay.includes(word));
  }

  function render() {
    const q = $('q').value.trim();
    shown = codes
      .filter((c) => matches(c, q))
      .sort((a, b) => {
        // A name that starts with what was typed first; otherwise the order the codes came in
        // (recently applied first, then yaqatw's: host.js codes). The sort is stable.
        const sa = q && a.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
        const sb = q && b.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
        return sa - sb;
      })
      .slice(0, MAX_SHOWN);
    const list = $('list');
    list.replaceChildren();
    shown.forEach((c, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = wordColor(c.color) || 'transparent';
      const text = document.createElement('span');
      text.textContent = c.name;
      li.append(dot, text);
      if (c.description) {
        const d = document.createElement('span');
        d.className = 'desc';
        d.textContent = c.description;
        li.append(d);
      }
      li.addEventListener('mousemove', () => select(i));
      li.addEventListener('click', () => apply(i));
      list.append(li);
    });
    // Always last: a new code, named after what was typed.
    const li = document.createElement('li');
    li.className = 'new';
    li.setAttribute('role', 'option');
    li.textContent = q ? `New code “${q}”…` : 'New code…';
    li.addEventListener('mousemove', () => select(shown.length));
    li.addEventListener('click', () => openNew(q));
    list.append(li);
    select(Math.min(selected, shown.length));
  }

  function select(i) {
    selected = Math.max(0, Math.min(i, shown.length));
    [...$('list').children].forEach((li, j) => li.setAttribute('aria-selected', String(j === selected)));
    const el = $('list').children[selected];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  async function apply(i) {
    if (busy) return;
    if (i >= shown.length) {
      openNew($('q').value.trim());
      return;
    }
    const code = shown[i];
    busy = true;
    message('');
    try {
      // The host page notes it among the codes applied lately (host.js rememberCode).
      await word.action('applyCode', { codeId: code.id });
      word.close();
    } catch (err) {
      message(cleanError(err));
    } finally {
      busy = false;
    }
  }

  // ─── A new code ────────────────────────────────────────────────────────────────────────────

  /** The first of Word's colours no code has yet, as Euro-Office's "New code" suggests. */
  function suggestColor() {
    const used = new Set(codes.map((c) => wordColor(c.color)));
    const free = PALETTE.slice(1).find((c) => !used.has(c.hex)); // white is a poor highlight
    return (free || PALETTE[1 + (codes.length % (PALETTE.length - 1))]).hex;
  }

  function renderSwatches() {
    const box = $('swatches');
    box.replaceChildren();
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', c.label);
      b.setAttribute('aria-checked', String(c.hex === chosenColor));
      b.style.background = c.hex;
      b.addEventListener('click', () => {
        chosenColor = c.hex;
        renderSwatches();
      });
      box.append(b);
    }
  }

  function openNew(name) {
    $('find').hidden = true;
    $('new').hidden = false;
    $('name').value = name || '';
    chosenColor = suggestColor();
    renderSwatches();
    message('');
    $('name').focus();
  }

  function closeNew() {
    $('new').hidden = true;
    $('find').hidden = false;
    $('q').focus();
  }

  async function create() {
    if (busy) return;
    const name = $('name').value.trim();
    if (!name) {
      message('A code needs a name.');
      return;
    }
    busy = true;
    message('');
    try {
      await word.action('newCode', { name, description: $('desc').value.trim(), color: chosenColor });
      word.close();
    } catch (err) {
      message(cleanError(err));
    } finally {
      busy = false;
    }
  }

  // ─── Keys and buttons ──────────────────────────────────────────────────────────────────────

  $('q').addEventListener('input', () => {
    selected = 0;
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('new').hidden) closeNew();
      else word.close();
      e.preventDefault();
    } else if (!$('find').hidden && e.key === 'ArrowDown') {
      select(selected + 1);
      e.preventDefault();
    } else if (!$('find').hidden && e.key === 'ArrowUp') {
      select(selected - 1);
      e.preventDefault();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (!$('find').hidden) apply(selected);
      else if (document.activeElement !== $('desc')) create();
      else return;
      e.preventDefault();
    }
  });
  $('create').addEventListener('click', create);
  $('back').addEventListener('click', closeNew);
  $('full').addEventListener('click', () => word.action('showWindow').catch(() => {}).then(() => word.close()));

  async function start() {
    const mode = new URLSearchParams(location.search).get('mode');
    message('Loading codes…');
    try {
      const r = await word.action('codes');
      codes = (r && r.codes) || [];
      // Why codes cannot be applied here, as the host page says it (host.js codingNote).
      message((r && r.note) || '');
    } catch (err) {
      message(cleanError(err));
    }
    render();
    if (mode === 'new') openNew('');
    else $('q').focus();
  }

  start();
})();
