/**
 * Highlight info of a Word document (Yaqatw › Highlight info, or Word's right-click menu): the
 * coded passage at Word's cursor, as yaqatw shows it when a highlight is clicked. Its text, a
 * translation and notes (saved together, Save & close), its codes (detached or added at once,
 * as in yaqatw), and for each code: its categories (added or taken out at once), the
 * relationships it is in, its passages in Yaqatw, and Manage (deprecate, merge, remove from this
 * document, delete), each confirmed here with its reach and where to undo it. Remove highlight
 * sends the passage to Yaqatw's Trash. What the open Yaqatw cannot do is not shown (`features`).
 * Every action goes to the document's own Yaqatw (its Word window, src/word-host/host.js),
 * through window.clewWord.action.
 */
(function () {
  'use strict';

  const word = window.clewWord;
  const { PALETTE, wordColor } = window.ClewWordColors;
  const $ = (id) => document.getElementById(id);
  const hid = new URLSearchParams(location.search).get('hid') || '';

  let applied = []; // the passage's codes, each with its categories and relationships if known
  let allCodes = []; // the project's codes, to add one or merge into one
  let allCategories = []; // the project's categories, to put a code in one
  let features = [];
  let saved = { translation: '', comment: '' };
  let busy = false;
  // The code being edited (click or right-click on its chip): its id, and its colour as shown.
  let editing = null;
  // The code being managed: { id, name, step, usage, target } (step: null while choosing).
  let managing = null;
  // The category being edited (click on its tag): { id, name, description }.
  let editingCat = null;
  // A mark Yaqatw has no passage for: Remove takes the mark off, without asking again.
  let stray = false;

  const has = (f) => features.includes(f);

  function message(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }

  function cleanError(err) {
    const msg = err && err.message ? err.message : String(err);
    const m = /^Error invoking remote method '[^']+': (?:Error: )?(.*)$/s.exec(msg);
    return m ? m[1] : msg;
  }

  /** Runs `fn` with the window's controls disabled; says what went wrong, if anything. */
  async function work(fn) {
    if (busy) return undefined;
    busy = true;
    document.body.classList.add('busy');
    message('');
    try {
      return await fn();
    } catch (err) {
      message(cleanError(err));
      return undefined;
    } finally {
      busy = false;
      document.body.classList.remove('busy');
    }
  }

  const dirty = () => $('translation').value !== saved.translation || $('comment').value !== saved.comment;

  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    e.append(...children.filter((c) => c != null));
    return e;
  }

  function button(text, onClick, props) {
    const b = el('button', Object.assign({ type: 'button', textContent: text }, props || {}));
    b.addEventListener('click', onClick);
    return b;
  }

  // ─── Codes ─────────────────────────────────────────────────────────────────────────────────

  function renderCodes() {
    const list = $('codes');
    list.replaceChildren();
    for (const c of applied) list.append(codeItem(c));
    const add = $('add');
    add.replaceChildren(new Option('Add a code…', '', true, true));
    add.options[0].disabled = true;
    const on = new Set(applied.map((c) => c.id));
    for (const c of allCodes) if (!on.has(c.id)) add.append(new Option(c.name, c.id));
    add.disabled = add.options.length < 2;
  }

  /** A code of the passage: its chip and actions, its categories, its relationships, Manage. */
  function codeItem(c) {
    const li = el('li', { className: 'code' });
    const chip = el('span', { className: editing && editing.id === c.id ? 'chip editing' : 'chip' });
    chip.style.setProperty('--code', wordColor(c.color) || 'transparent');
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openEdit(c);
    });
    const name = button(c.name, () => openEdit(c), { className: 'name', title: `Edit “${c.name}”` });
    const x = button('×', () => detach(c), { title: `Detach “${c.name}”` });
    x.setAttribute('aria-label', x.title);
    chip.append(name, x);
    const acts = el('span', { className: 'acts' });
    if (has('showPassages')) {
      acts.append(button('Passages', () => showPassages(c), { className: 'link', title: `Show the passages of “${c.name}” in Yaqatw` }));
    }
    if (has('manage')) {
      const open = managing && managing.id === c.id;
      const m = button(open ? 'Manage ▴' : 'Manage ▾', () => (open ? closeManage() : openManage(c)), { className: 'link' });
      m.setAttribute('aria-expanded', String(Boolean(open)));
      acts.append(m);
    }
    li.append(el('div', { className: 'head' }, chip, acts));
    if (has('categories') && Array.isArray(c.categories)) li.append(categoryLine(c));
    if (has('relationships') && Array.isArray(c.relationships)) {
      const names = c.relationships.map((r) => (r.instanceName && r.instanceName !== r.name ? `${r.name} › ${r.instanceName}` : r.name));
      const text = names.length ? `Relationships: ${names.join(', ')}` : 'In no relationship.';
      // Add to relationship's window takes this one's place.
      const change = button(names.length ? 'Change…' : 'Add…', openRelate, {
        className: 'link',
        title: 'Put this passage’s codes or their categories in relationships',
      });
      li.append(el('p', { className: 'rels' }, el('span', { textContent: text }), ' ', change));
    }
    if (managing && managing.id === c.id) li.append(managePanel());
    return li;
  }

  /** The code's categories as tags (× takes it out), and a list to put it in another. */
  function categoryLine(c) {
    const line = el('div', { className: 'tags' });
    for (const k of c.categories) {
      const out = button('×', () => uncategorise(c, k), { title: `Take “${c.name}” out of “${k.name}”` });
      out.setAttribute('aria-label', out.title);
      // Its name edits the category, when this Yaqatw can.
      const name = has('editCategory')
        ? button(k.name, () => openCatEdit(k), { className: 'name', title: `Edit the category “${k.name}”` })
        : el('span', { textContent: k.name });
      const tag = el('span', { className: editingCat && editingCat.id === k.id ? 'tag editing' : 'tag' }, name, out);
      line.append(tag);
    }
    const inIds = new Set(c.categories.map((k) => k.id));
    const free = allCategories.filter((k) => !inIds.has(k.id));
    if (free.length) {
      const pick = el('select', { className: 'add-cat' });
      pick.setAttribute('aria-label', `Put “${c.name}” in a category`);
      pick.append(new Option('+ Category…', '', true, true), ...free.map((k) => new Option(k.name, k.id)));
      pick.options[0].disabled = true;
      pick.addEventListener('change', () => categorise(c, pick.value));
      line.append(pick);
    } else if (!c.categories.length) {
      line.append(el('span', { className: 'muted', textContent: 'No categories yet.' }));
    }
    return line;
  }

  async function reloadCodes() {
    const info = await word.action('highlightInfo', { hid });
    take(info);
    renderCodes();
  }

  function take(info) {
    applied = info.codes;
    allCategories = info.categories || [];
    features = info.features || [];
    if (managing && !applied.some((c) => c.id === managing.id)) managing = null;
  }

  const categorise = (c, categoryId) =>
    work(async () => {
      if (categoryId) await word.action('addToCategory', { categoryId, codeId: c.id });
      await reloadCodes();
    }).then(renderCodes);

  const uncategorise = (c, k) =>
    work(async () => {
      await word.action('removeFromCategory', { categoryId: k.id, codeId: c.id });
      await reloadCodes();
    });

  function openRelate() {
    if (dirty() && !confirm('Leave without saving the translation and notes?')) return;
    work(() => word.action('openRelate', { hid }));
  }

  // ─── Editing a category: its name and description (from its tag) ──────────────────────────

  function openCatEdit(k) {
    if (editing) closeEdit();
    managing = null;
    editingCat = { id: k.id, name: k.name, description: k.description || '' };
    $('cat-name').value = k.name;
    $('cat-desc').value = editingCat.description;
    $('cat-edit').hidden = false;
    renderCodes();
    $('cat-name').focus();
    $('cat-name').select();
  }

  function closeCatEdit() {
    editingCat = null;
    $('cat-edit').hidden = true;
    renderCodes();
  }

  const catDirty = () =>
    Boolean(editingCat) &&
    ($('cat-name').value.trim() !== editingCat.name || $('cat-desc').value.trim() !== editingCat.description.trim());

  const saveCat = () =>
    work(async () => {
      const name = $('cat-name').value.trim();
      if (!name) throw new Error('A category needs a name.');
      await word.action('editCategory', { categoryId: editingCat.id, name, description: $('cat-desc').value.trim() });
      editingCat = null;
      $('cat-edit').hidden = true;
      await reloadCodes();
    });

  $('cat-save').addEventListener('click', saveCat);
  $('cat-cancel').addEventListener('click', closeCatEdit);
  $('cat-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      saveCat();
      e.preventDefault();
    }
  });

  function showPassages(c) {
    if (dirty() && !confirm('Leave without saving the translation and notes?')) return;
    work(async () => {
      await word.action('showPassages', { codeId: c.id });
      word.close();
    });
  }

  // ─── Editing a code: name, Word's colours, description (yaqatw repaints its passages) ─────

  function renderSwatches() {
    const box = $('swatches');
    box.replaceChildren();
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', c.label);
      b.setAttribute('aria-checked', String(c.hex === editing.color));
      b.style.background = c.hex;
      b.addEventListener('click', () => {
        editing.color = c.hex;
        renderSwatches();
      });
      box.append(b);
    }
  }

  function openEdit(code) {
    managing = null;
    if (editingCat) {
      editingCat = null;
      $('cat-edit').hidden = true;
    }
    const full = allCodes.find((c) => c.id === code.id) || code;
    const shown = wordColor(code.color) || '';
    editing = { id: code.id, color: shown, shown, name: code.name, description: full.description || '' };
    $('code-name').value = code.name;
    $('code-desc').value = editing.description;
    renderSwatches();
    $('edit').hidden = false;
    renderCodes();
    $('code-name').focus();
    $('code-name').select();
  }

  function closeEdit() {
    editing = null;
    $('edit').hidden = true;
    renderCodes();
  }

  const editDirty = () =>
    Boolean(editing) &&
    ($('code-name').value.trim() !== editing.name ||
      $('code-desc').value.trim() !== editing.description.trim() ||
      editing.color !== editing.shown);

  async function reloadAllCodes() {
    const codes = await word.action('codes').catch(() => null);
    if (codes && codes.codes) allCodes = codes.codes;
  }

  const saveCode = () =>
    work(async () => {
      const name = $('code-name').value.trim();
      if (!name) throw new Error('A code needs a name.');
      // The colour only when another was chosen: the code keeps its own exact colour otherwise.
      // The description only when changed: a code the project's list leaves out (deprecated,
      // merged) opens with none shown, and saving its name must not erase its own.
      const changes = { codeId: editing.id, name };
      const description = $('code-desc').value.trim();
      if (description !== editing.description.trim()) changes.description = description;
      if (editing.color !== editing.shown) changes.color = editing.color;
      await word.action('editCode', changes);
      await reloadAllCodes();
      editing = null;
      $('edit').hidden = true;
      await reloadCodes();
    });

  $('code-save').addEventListener('click', saveCode);
  $('code-cancel').addEventListener('click', closeEdit);
  $('code-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      saveCode();
      e.preventDefault();
    }
  });

  async function detach(code) {
    if (editing && editing.id === code.id) closeEdit();
    if (
      applied.length === 1 &&
      !confirm(`“${code.name}” is this passage's only code: detaching it removes the highlight. Detach it?`)
    ) {
      return;
    }
    await work(async () => {
      const r = await word.action('detachCode', { hid, codeId: code.id });
      if (r && r.deleted) {
        word.close();
        return;
      }
      await reloadCodes();
    });
  }

  $('add').addEventListener('change', async () => {
    const codeId = $('add').value;
    if (!codeId) return;
    await work(async () => {
      await word.action('attachCode', { hid, codeId });
      await reloadCodes();
    });
    renderCodes();
  });

  // ─── Managing a code: what it reaches and where to undo it, before the button ─────────────

  const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

  /** "4 passages here and 12 in 3 other files". */
  function reach(u) {
    const here = `${count(u.here, 'passage')} here`;
    if (!u.elsewhere) return here;
    return `${here} and ${u.elsewhere} in ${u.files ? count(u.files, 'other file') : 'other files'}`;
  }

  /** Each step: what it says, its button, what it does, what is said after. */
  const STEPS = {
    deprecate: {
      label: 'Deprecate…',
      explain: (m) =>
        `“${m.name}” is used in ${reach(m.usage)}. Deprecated, it stays on them, marked as no longer in use. ` +
        'Undo: Reactivate, in Yaqatw.',
      confirm: 'Deprecate',
      run: (m) => word.action('deprecateCode', { codeId: m.id, reason: m.reason || '' }),
      done: (m) => `“${m.name}” is deprecated.`,
    },
    merge: {
      label: 'Merge into…',
      explain: (m) =>
        `Every passage of “${m.name}” (${reach(m.usage)}) will show the code chosen below instead. ` +
        'Undo: Unmerge, in Yaqatw.',
      confirm: 'Merge',
      run: (m) => word.action('mergeCode', { codeId: m.id, targetId: m.target && m.target.id }),
      done: (m) => `“${m.name}” is merged into “${m.target.name}”.`,
    },
    remove: {
      label: 'Remove from this document…',
      explain: (m) =>
        `“${m.name}” leaves its ${count(m.usage.here, 'passage')} in this document; other files keep it. ` +
        "A passage left without a code goes to Yaqatw's Trash.",
      confirm: 'Remove from this document',
      run: (m) => word.action('removeCodeFromFile', { codeId: m.id }),
      done: (m) => `“${m.name}” is no longer in this document.`,
      // This passage loses its only code: it goes too.
      ends: () => applied.length === 1,
    },
    delete: {
      label: 'Delete…',
      explain: (m) =>
        `“${m.name}” goes to Yaqatw's Trash and leaves its passages: ${reach(m.usage)}` +
        (m.usage.elsewhere ? ' (other files when they are next opened)' : '') +
        '. Undo: restore it from Trash, in Yaqatw.',
      confirm: 'Delete code',
      danger: true,
      run: (m) => word.action('deleteCode', { codeId: m.id }),
      done: (m) => `“${m.name}” is in Yaqatw's Trash.`,
      ends: () => applied.length === 1,
    },
  };

  function openManage(c) {
    if (editing) closeEdit();
    if (editingCat) {
      editingCat = null;
      $('cat-edit').hidden = true;
    }
    managing = { id: c.id, name: c.name, step: null, usage: null, target: null, reason: '', filter: '' };
    renderCodes();
  }

  function closeManage() {
    managing = null;
    renderCodes();
  }

  const chooseStep = (step) =>
    work(async () => {
      const m = managing;
      m.usage = await word.action('codeUsage', { codeId: m.id });
      if (managing !== m) return;
      m.step = step;
      if (step === 'merge') await reloadAllCodes();
    }).then(renderCodes);

  function managePanel() {
    const m = managing;
    const box = el('fieldset', { className: 'manage' }, el('legend', { textContent: `Manage “${m.name}”` }));
    if (!m.step) {
      const row = el('div', { className: 'choices' });
      for (const [step, s] of Object.entries(STEPS)) {
        row.append(button(s.label, () => chooseStep(step), s.danger ? { className: 'danger' } : null));
      }
      box.append(row, el('div', { className: 'row' }, button('Cancel', closeManage)));
      return box;
    }
    const s = STEPS[m.step];
    box.append(el('p', { className: 'explain', textContent: s.explain(m) }));
    const go = button(s.confirm, () => runStep(), { className: s.danger ? 'primary danger' : 'primary' });
    if (m.step === 'deprecate') {
      const reason = el('textarea', { rows: 2, placeholder: 'Reason (optional)', value: m.reason });
      reason.setAttribute('aria-label', 'Reason');
      reason.addEventListener('input', () => (m.reason = reason.value));
      box.append(reason);
    } else if (m.step === 'merge') {
      box.append(...mergePicker(m, go));
      go.disabled = !m.target;
    }
    box.append(el('div', { className: 'row' }, go, button('Back', () => ((m.step = null), renderCodes()))));
    return box;
  }

  /** Merge into: a filter and the other live codes; one is chosen. */
  function mergePicker(m, go) {
    const filter = el('input', { type: 'search', placeholder: 'Find a code…', value: m.filter });
    filter.setAttribute('aria-label', 'Find the code to merge into');
    const list = el('ul', { className: 'pick' });
    list.setAttribute('role', 'listbox');
    const fill = () => {
      const q = m.filter.trim().toLowerCase();
      list.replaceChildren();
      for (const c of allCodes) {
        if (c.id === m.id || (q && !c.name.toLowerCase().includes(q))) continue;
        const dot = el('span', { className: 'dot' });
        dot.style.background = wordColor(c.color) || 'transparent';
        const li = el('li', {}, dot, el('span', { textContent: c.name }));
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(Boolean(m.target && m.target.id === c.id)));
        li.addEventListener('click', () => {
          m.target = { id: c.id, name: c.name };
          go.disabled = false;
          fill();
        });
        list.append(li);
      }
      if (!list.children.length) list.append(el('li', { className: 'muted', textContent: 'No other code matches.' }));
    };
    filter.addEventListener('input', () => {
      m.filter = filter.value;
      fill();
    });
    fill();
    return [filter, list];
  }

  const runStep = () =>
    work(async () => {
      const m = managing;
      const s = STEPS[m.step];
      const ends = s.ends ? s.ends() : false;
      await s.run(m);
      const said = s.done(m);
      managing = null;
      if (ends) {
        word.close();
        return;
      }
      await reloadAllCodes();
      await reloadCodes();
      message(said);
    }).then(renderCodes);

  // ─── Translation, saving, removing, closing ───────────────────────────────────────────────

  $('translate').addEventListener('click', () =>
    work(async () => {
      const b = $('translate');
      b.textContent = 'Translating…';
      try {
        const r = await word.action('translateHighlight', { hid, provider: $('provider').value });
        $('translation').value = r.text;
      } finally {
        b.textContent = 'Translate';
      }
    }),
  );

  const save = () =>
    work(async () => {
      await word.action('saveHighlightInfo', { hid, translation: $('translation').value, comment: $('comment').value });
      saved = { translation: $('translation').value, comment: $('comment').value };
      word.close();
    });

  function remove() {
    if (
      !stray &&
      !confirm(
        "Remove this highlight? Its codes, translation and notes go with it to Yaqatw's Trash (restore it there); the text stays in the document.",
      )
    ) {
      return;
    }
    work(async () => {
      await word.action('removeHighlight', { hid });
      word.close();
    });
  }

  function close() {
    if (editDirty() && !confirm('Close without saving the code?')) return;
    if (catDirty() && !confirm('Close without saving the category?')) return;
    if (dirty() && !confirm('Close without saving the translation and notes?')) return;
    word.close();
  }

  $('form').addEventListener('submit', (e) => e.preventDefault());
  $('save').addEventListener('click', save);
  $('close').addEventListener('click', close);
  $('remove').addEventListener('click', remove);
  $('full').addEventListener('click', () => word.action('showWindow').catch(() => {}).then(() => word.close()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Esc leaves the code being edited or managed first, then the window.
      if (editing) closeEdit();
      else if (editingCat) closeCatEdit();
      else if (managing) closeManage();
      else close();
      e.preventDefault();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // The code or category being edited first; the passage's fields, and closing, after.
      if (editing) saveCode();
      else if (editingCat) saveCat();
      else save();
      e.preventDefault();
    }
  });

  // ─── Start ─────────────────────────────────────────────────────────────────────────────────

  async function start() {
    message('Loading…');
    document.body.classList.add('busy');
    try {
      const [info, codes, translators] = await Promise.all([
        word.action('highlightInfo', { hid }),
        word.action('codes').catch(() => null),
        // An older Yaqatw, or no translator set up: no Translate button, nothing said.
        word.action('translateProviders').catch(() => null),
      ]);
      $('text').textContent = info.text;
      $('translation').value = saved.translation = info.translation;
      $('comment').value = saved.comment = info.comment;
      take(info);
      allCodes = (codes && codes.codes) || [];
      const providers = (translators && translators.providers) || [];
      $('provider').replaceChildren(...providers.map((p) => new Option(p.label, p.key)));
      $('translate-row').hidden = !providers.length;
      $('remove').hidden = !has('removeHighlight');
      renderCodes();
      message('');
      document.body.classList.remove('busy');
      $('comment').focus();
    } catch (err) {
      // Nothing to show: the window stays to say why (no type, no record of the passage…).
      const why = cleanError(err);
      message(why);
      $('form').hidden = true;
      $('save').hidden = true;
      document.body.classList.remove('busy');
      // A mark in the document that Yaqatw has no passage for (deleted elsewhere, never saved):
      // Yaqatw takes it off when asked to remove it (its deleteHighlight).
      if (/no record of this passage/.test(why)) {
        const r = await word.action('features').catch(() => null);
        if (r && (r.features || []).includes('removeHighlight')) {
          message(`${why} Remove its mark from the document? The text stays.`);
          $('remove').textContent = 'Remove the mark';
          $('remove').hidden = false;
          stray = true;
        }
      }
    }
  }

  start();
})();
