'use strict';
// The app's own texts are English: CJK characters in a source file mean it was read in a legacy
// code page and written back as UTF-8 ("…" became "窶ｦ" once, in the menus of a release).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GARBLED = /[　-鿿＀-￯]/;

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|cjs|mjs|html|css|json|nsh|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('source files are clean UTF-8, with no text garbled through a legacy code page', () => {
  const checked = [
    ...files(path.join(ROOT, 'src')),
    ...files(path.join(ROOT, 'scripts')),
    ...files(path.join(ROOT, 'build')),
    ...files(path.join(ROOT, 'docs')),
    ...['README.md', 'package.json', 'desktop.config.json', 'sites.config.json'].map((f) => path.join(ROOT, f)),
  ].filter((f) => fs.existsSync(f));
  const bad = [];
  for (const f of checked) {
    const bytes = fs.readFileSync(f);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bad.push(`${path.relative(ROOT, f)}: byte order mark`);
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      if (GARBLED.test(line) || line.includes('�')) bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, []);
  assert.ok(checked.length > 40, `only ${checked.length} files checked`);
});
