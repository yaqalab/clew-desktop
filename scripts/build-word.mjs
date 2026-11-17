#!/usr/bin/env node
// `npm run build:word`: builds Yaqatw for Word, the Word template (`word-plugin/`), into
// `word-plugin/dist/yaqatw.dotm`, which the Windows installer ships as
// `resources/word-plugin/yaqatw.dotm`. Needs Windows with Word (word-plugin/build.ps1); skipped
// elsewhere: the template is for Windows only.
import { join } from 'node:path';
import { ROOT, fail, run } from './lib.mjs';

if (process.platform !== 'win32') {
  console.log('[word] skipped: the Word template is built on Windows only');
  process.exit(0);
}
const script = join(ROOT, 'word-plugin', 'build.ps1');
try {
  await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`, { cwd: ROOT, label: 'word' });
} catch (err) {
  fail(`the Word template did not build (${err.message}); it needs Word on this computer`);
}
