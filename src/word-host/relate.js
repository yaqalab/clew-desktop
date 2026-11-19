/**
 * Add to relationship, as a window (Word's right-click, Add to relationship › More…): the coded
 * passage's codes, each with the categories it is in and their parents, as a tree on the left;
 * on the right, every relationship and its instances for the one chosen, ticked when it is in
 * them (a click puts it in or takes it out at once), New instance, and New relationship. The
 * right-click menu offers the codes and the categories they are directly in; parents are here.
 * Every action goes to the document's own Yaqatw (its Word window, src/word-host/host.js),
 * through window.clewWord.action.
 */
(function () {
  'use strict';

  const word = window.clewWord;
  const { wordColor } = window.ClewWordColors;
  const $ = (id) => document.getElementById(id);
  const hid = new URLSearchParams(location.search).get('hid') || '';

  let items = []; // { kind, id, name, color?, depth }
  let chosen = 0; // index in items
  let relationships = [];
  let busy = false;

  function message(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }

  function cleanError(err) {
    const msg = err && err.message ? err.message : String(err);
    const m = /^Error invoking remote method '[^']+': (?:Error: )?(.*)$/s.exec(msg);
    return m ? m[1] : msg;
  }

  /** Runs `fn` with the window's controls disabled; says what it did, or what went wrong. */
  async function work(fn) {
    if (busy) return;
    busy = true;
    document.body.classList.add('busy');
    message('');
    try {
      const r = await fn();
      if (r && r.status) message(r.status);
    } catch (err) {
      message(cleanError(err));
    } finally {
      busy = false;
      document.body.classList.remove('busy');
    }
  }

  const item = () => items[chosen];
  const what = (it) => (it.kind === 'category' ? `the category “${it.name}”` : `“${it.name}”`);
  const about = (it) => ({ itemId: it.id, kind: it.kind });

  // ─── The passage's codes and categories ────────────────────────────────────────────────────

  function renderItems() {
    const list = $('items');
    list.replaceChildren();
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === chosen));
      li.style.paddingLeft = `${8 + it.depth * 18}px`;
      const mark = document.createElement('span');
      if (it.kind === 'code') {
        mark.className = 'dot';
        mark.style.background = wordColor(it.color) || 'transparent';
      } else {
        mark.className = 'kind';
        // The categories the code is in, then their parents.
        mark.textContent = it.depth > 1 ? 'parent' : 'category';
      }
      const name = document.createElement('span');
      name.textContent = it.name;
      li.append(mark, name);
      li.addEventListener('click', () => choose(i));
      list.append(li);
    });
  }

  async function choose(i) {
    if (busy || !items[i]) return;
    chosen = i;
    renderItems();
    $('rels-for').textContent = `Relationships of ${what(item())}`;
    $('create-for').textContent = `Its first instance will hold ${what(item())}.`;
    await work(loadRelationships);
  }

  // ─── Its relationships ─────────────────────────────────────────────────────────────────────

  async function loadRelationships() {
    const r = await word.action('itemRelationships', { itemId: item().id });
    relationships = r.relationships || [];
    renderRelationships();
  }

  function renderRelationships() {
    const list = $('rels');
    list.replaceChildren();
    if (!relationships.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No relationships yet: create one below.';
      list.append(li);
    }
    for (const rel of relationships) {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'rel';
      head.textContent = rel.name;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'link';
      more.textContent = '+ New instance';
      more.title = `A new instance of “${rel.name}” holding ${what(item())}`;
      more.addEventListener('click', () =>
        work(async () => {
          const r = await word.action('newInstance', { relationshipId: rel.id, ...about(item()) });
          await loadRelationships();
          return r;
        }),
      );
      head.append(more);
      li.append(head);
      for (const inst of rel.instances) {
        const label = document.createElement('label');
        label.className = 'inst';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = inst.holds;
        box.addEventListener('change', () =>
          work(async () => {
            const args = { relationshipId: rel.id, instanceId: inst.id, ...about(item()) };
            const r = await word.action(box.checked ? 'addToRelationship' : 'removeFromRelationship', args);
            await loadRelationships();
            return r;
          }).then(renderRelationships),
        );
        label.append(box, document.createTextNode(inst.name));
        li.append(label);
      }
      list.append(li);
    }
  }

  // ─── A new relationship ────────────────────────────────────────────────────────────────────

  function create() {
    const name = $('name').value.trim();
    if (!name) {
      message('A relationship needs a name.');
      $('name').focus();
      return;
    }
    work(async () => {
      await word.action('newRelationship', { name, description: $('desc').value.trim(), ...about(item()) });
      $('name').value = '';
      $('desc').value = '';
      await loadRelationships();
      return { status: `“${name}” holds ${what(item())}.` };
    });
  }

  $('create').addEventListener('click', create);
  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      create();
      e.preventDefault();
    }
  });
  $('close').addEventListener('click', () => word.close());
  $('full').addEventListener('click', () => word.action('showWindow').catch(() => {}).then(() => word.close()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      word.close();
      e.preventDefault();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement.tagName !== 'TEXTAREA') {
      if (document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') return;
      choose(chosen + (e.key === 'ArrowDown' ? 1 : -1));
      e.preventDefault();
    }
  });

  // ─── Start ─────────────────────────────────────────────────────────────────────────────────

  async function start() {
    message('Loading…');
    try {
      const r = await word.action('relateItems', { hid });
      items = r.items || [];
      if (!items.length) throw new Error('This passage has no code.');
      message('');
      await choose(0);
      if (!r.categories) message('This Yaqatw puts codes in relationships, not categories: update Clew Desktop for them.');
    } catch (err) {
      message(cleanError(err));
      document.querySelector('.cols').hidden = true;
    }
  }

  start();
})();
