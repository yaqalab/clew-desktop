/**
 * A small form of a Word document that creates something for a code (Word's right-click menu):
 * `?kind=category` (Add to category › New category…) or `?kind=relationship` (Add to
 * relationship › New relationship…), `&code=<id>` the code it will hold (with `&item=category`,
 * a new relationship holds the category of that id instead). A name and a
 * description; the document's own Yaqatw (its Word window, src/word-host/host.js) does the rest,
 * through window.clewWord.action.
 */
(function () {
  'use strict';

  const word = window.clewWord;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const codeId = params.get('code') || '';
  // A new relationship may hold a category instead (Add to relationship on a category).
  const forCategory = params.get('kind') === 'relationship' && params.get('item') === 'category';

  /** What each kind says and which action makes it. */
  const KINDS = {
    category: {
      title: 'New category',
      placeholder: 'Category name',
      button: 'Create category',
      action: 'newCategory',
      needsName: 'A category needs a name.',
    },
    relationship: {
      title: 'New relationship',
      placeholder: 'Relationship name',
      button: 'Create relationship',
      action: 'newRelationship',
      needsName: 'A relationship needs a name.',
      // A relationship's codes are in its instances: the first one is made with it.
      holds: (name) => `Its first instance will hold the code “${name}”.`,
    },
  };
  const kind = KINDS[params.get('kind')] || KINDS.category;
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

  async function create() {
    if (busy) return;
    const name = $('name').value.trim();
    if (!name) {
      message(kind.needsName);
      return;
    }
    busy = true;
    message('');
    try {
      const item = forCategory ? { itemId: codeId, kind: 'category' } : { codeId };
      await word.action(kind.action, { ...item, name, description: $('desc').value.trim() });
      word.close();
    } catch (err) {
      message(cleanError(err));
    } finally {
      busy = false;
    }
  }

  document.title = kind.title;
  $('heading').textContent = kind.title;
  $('name').placeholder = kind.placeholder;
  $('name').setAttribute('aria-label', kind.placeholder);
  $('create').textContent = kind.button;
  $('create').addEventListener('click', create);
  $('cancel').addEventListener('click', () => word.close());
  $('full').addEventListener('click', () => word.action('showWindow').catch(() => {}).then(() => word.close()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') word.close();
    else if (e.key === 'Enter' && !e.shiftKey && document.activeElement !== $('desc')) create();
    else return;
    e.preventDefault();
  });
  $('name').focus();

  // The code (or category) it will hold, by name (the window has its id only).
  (async () => {
    try {
      if (forCategory) {
        const r = await word.action('categories');
        const k = ((r && r.categories) || []).find((c) => c.id === codeId);
        if (k) $('for').textContent = `Its first instance will hold the category “${k.name}”.`;
        return;
      }
      const r = await word.action('codes');
      const code = ((r && r.codes) || []).find((c) => c.id === codeId);
      if (code) $('for').textContent = kind.holds ? kind.holds(code.name) : `It will hold the code “${code.name}”.`;
    } catch (err) {
      message(cleanError(err));
    }
  })();
})();
