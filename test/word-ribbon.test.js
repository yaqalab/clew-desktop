'use strict';
/**
 * Yaqatw for Word's ribbon and right-click menus (word-plugin/customUI/customUI14.xml) against
 * its VBA (word-plugin/src/*.bas), without Word: Word says nothing of a duplicate id or a missing
 * callback until someone clicks, and then only with "Show add-in user interface errors" on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'word-plugin');
const XML = fs.readFileSync(path.join(DIR, 'customUI', 'customUI14.xml'), 'utf8');
const SOURCES = fs
  .readdirSync(path.join(DIR, 'src'))
  .filter((f) => /\.(bas|cls)$/.test(f))
  .map((f) => fs.readFileSync(path.join(DIR, 'src', f), 'utf8'));
const RIBBON = fs.readFileSync(path.join(DIR, 'src', 'Ribbon.bas'), 'utf8');

const attrs = (name) => [...XML.matchAll(new RegExp(`\\s${name}="([^"]+)"`, 'g'))].map((m) => m[1]);

test('the ribbon XML is well-formed (Word drops the whole ribbon, silently, when it is not)', () => {
  const body = XML.replace(/^<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const [tag] of body.matchAll(/<[^>]*>/g)) {
    // A tag, its attributes each name="value" with white space before it.
    const m = /^<(\/?)([\w:]+)((?:\s+[\w:]+="[^"<]*")*)\s*(\/?)>$/.exec(tag);
    assert.ok(m, `malformed tag: ${tag}`);
    if (m[1]) assert.equal(stack.pop(), m[2], `closing ${tag}`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, []);
  // Nothing but tags and white space between them.
  assert.equal(body.replace(/<[^>]*>/g, '').trim(), '');
});

test('every id in the ribbon XML is unique', () => {
  const ids = attrs('id');
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
  );
});

test('every callback the ribbon XML names is a public procedure of the VBA', () => {
  const callbacks = new Set(
    ['onLoad', 'onAction', 'getContent', 'getVisible', 'getImage', 'getLabel', 'getEnabled'].flatMap(attrs),
  );
  assert.ok(callbacks.has('Ribbon_HighlightInfo'));
  const missing = [...callbacks].filter(
    (name) => !SOURCES.some((src) => new RegExp(`^Public Sub ${name}\\(`, 'm').test(src)),
  );
  assert.deepEqual(missing, []);
});

test("the callbacks the VBA's own menus name are public procedures too", () => {
  // Menus filled when they open (getContent) are XML written in the VBA, with "" for ".
  const named = new Set([...RIBBON.matchAll(/(?:onAction|getPressed|getImage|getVisible)=""(\w+)""/g)].map((m) => m[1]));
  for (const name of ['Ribbon_CategoryToggle', 'Ribbon_CategoryPressed', 'Ribbon_InstanceToggle', 'Ribbon_NewInstance', 'Ribbon_NewRelationship', 'Ribbon_RelateWindow']) {
    assert.ok(named.has(name), `${name} not in ${[...named].join(', ')}`);
  }
  const missing = [...named].filter((name) => !SOURCES.some((src) => new RegExp(`^Public Sub ${name}\\(`, 'm').test(src)));
  assert.deepEqual(missing, []);
});

test('each Apply code, Add to category and Add to relationship menu fills itself with ids of its own', () => {
  const menus = [
    ...XML.matchAll(/<dynamicMenu id="([^"]+)"[^>]*getContent="Ribbon_(?:Codes|Categories|Relationships)Menu"/g),
  ].map((m) => m[1]);
  assert.ok(menus.length >= 8, `menus: ${menus}`);
  // Each menu is named in its builder's Select, but one per builder, which takes the Case Else
  // prefix: the ribbon's Apply code (yc) and the text menu's Add to category (zx) and Add to
  // relationship (rx).
  const named = [...RIBBON.matchAll(/Case "([^"]+)": pre = "([^"]+)"/g)];
  const prefixes = [...named.map((m) => m[2]), 'yc', 'zx', 'rx'];
  assert.equal(new Set(prefixes).size, prefixes.length, 'prefixes differ');
  // A prefix may not start another (yx and yxa…: ids would meet).
  for (const a of prefixes) for (const b of prefixes) if (a !== b) assert.ok(!b.startsWith(a), `${a} / ${b}`);
  for (const id of menus.filter((m) => !['yaqatwApply', 'yaqatwCtxCat', 'yaqatwCtxRel'].includes(m))) {
    assert.ok(
      named.some((m) => m[1] === id),
      `${id} has no prefix of its own`,
    );
  }
});

test('right-click: before Cut in the text, list and misspelled-word menus, then a separator', () => {
  const menus = Object.fromEntries(
    [...XML.matchAll(/<contextMenu idMso="([^"]+)">([\s\S]*?)<\/contextMenu>/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(Object.keys(menus).sort(), ['ContextMenuList', 'ContextMenuSpell', 'ContextMenuText']);
  for (const name of ['ContextMenuText', 'ContextMenuList', 'ContextMenuSpell']) {
    const controls = [...menus[name].matchAll(/<(dynamicMenu|button) [^>]*>/g)].map((m) => m[0]);
    // Four at most: the menu is long already, and Word's own entries follow.
    assert.ok(controls.length === 4 && controls.every((c) => c.includes('insertBeforeMso="Cut"')), name);
    // Apply code anywhere in the text; Add to category, Add to relationship (when the document's
    // Yaqatw can) and Highlight info in a coded passage.
    assert.deepEqual(
      controls.map((c) => /getVisible="([^"]+)"/.exec(c)[1]),
      ['Ribbon_GetVisible', 'Ribbon_PassageVisible', 'Ribbon_RelationsVisible', 'Ribbon_PassageVisible'],
      name,
    );
    // One separator, after the entries and before Cut (in other documents it meets Word's own).
    const seps = [...menus[name].matchAll(/<menuSeparator [^>]*>/g)].map((m) => m[0]);
    assert.ok(seps.length === 1 && seps[0].includes('insertBeforeMso="Cut"'), `${name} separator`);
    assert.ok(menus[name].lastIndexOf('<menuSeparator') > menus[name].lastIndexOf('<button'), `${name}: separator last`);
  }
  // Analysis documents only: each of the twelve entries (Ribbon_PassageVisible checks the type
  // too, and Ribbon_RelationsVisible goes through it).
  const entries = [...XML.slice(XML.indexOf('<contextMenus>')).matchAll(/<(dynamicMenu|button) [^>]*>/g)].map((m) => m[0]);
  assert.equal(entries.length, 12);
  for (const e of entries) assert.ok(e.includes('tag="analyze"'), e);
  assert.match(RIBBON, /Public Sub Ribbon_PassageVisible[\s\S]*?If DocType\(\) <> "analyze" Then Exit Sub/);
  assert.match(RIBBON, /Public Sub Ribbon_RelationsVisible[\s\S]*?HasFeature\("relationships"\)[\s\S]*?Ribbon_PassageVisible control, visible/);
});

test('the Yaqatw tab comes before Help, placed as Zotero places its own', () => {
  assert.match(XML, /<tab id="yaqatwTab"[^>]*insertBeforeMso="TabAddIns"/);
});

test("the ribbon's own pictures are there, under names the build accepts", () => {
  const names = attrs('image');
  assert.ok(names.includes('yaqatw'), 'Open Yaqatw has the yaqatw logo');
  for (const name of names) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/);
    assert.ok(fs.existsSync(path.join(DIR, 'customUI', 'images', `${name}.png`)), `${name}.png`);
  }
});

test("the template names Word's 16 colours exactly as the host page's palette, and decides no other", () => {
  // The colour a code gets is yaqatw's rule, applied by the host page (colors.js); the template
  // only turns those 16 into Word's own names.
  const vba = fs.readFileSync(path.join(DIR, 'src', 'Highlights.bas'), 'utf8');
  const hexes = /hexes = Array\(([\s\S]*?)\)\r?\n/.exec(vba)[1].match(/#[0-9A-F]{6}/g);
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'word-host', 'colors.js'), 'utf8');
  const palette = /const PALETTE = \[([\s\S]*?)\]\.map/.exec(js)[1].match(/#[0-9A-F]{6}/g);
  assert.deepEqual(hexes, palette);
  assert.doesNotMatch(vba, /\bhue\b/i);
});

test('the VBA sources are ASCII, as the build requires', () => {
  for (const src of SOURCES) assert.doesNotMatch(src, /[^\x00-\x7F]/);
});
