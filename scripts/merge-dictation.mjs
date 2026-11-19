#!/usr/bin/env node
// `node scripts/merge-dictation.mjs <out folder> <folder or dictation.json>…`: one dictation.json
// from several (package:dictation's, one per system, and the release's live one), with every
// package file beside it. All must name the same version; a later one's entry for a system
// replaces an earlier one's. Publishes nothing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fail } from './lib.mjs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) fail('usage: merge-dictation.mjs <out folder> <folder or dictation.json>…');
mkdirSync(out, { recursive: true });

let merged = null;
for (const input of inputs) {
  const file = statSync(input).isDirectory() ? join(input, 'dictation.json') : input;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (!merged) merged = { version: manifest.version, packages: {} };
  if (manifest.version !== merged.version) fail(`${file} is version ${manifest.version}, not ${merged.version}`);
  for (const [key, entry] of Object.entries(manifest.packages || {})) {
    const archive = join(dirname(file), entry.file);
    if (existsSync(archive)) {
      if (statSync(archive).size !== entry.size) fail(`${archive} is not the size ${file} gives`);
      copyFileSync(archive, join(out, basename(entry.file)));
    }
    merged.packages[key] = entry;
    console.log(`[dictation] ${key}: ${entry.file}${existsSync(archive) ? '' : ' (already on the release)'}`);
  }
}
merged.packages = Object.fromEntries(Object.entries(merged.packages).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(out, 'dictation.json'), `${JSON.stringify(merged, null, 2)}\n`);
console.log(`[dictation] ✔ ${join(out, 'dictation.json')}: ${Object.keys(merged.packages).join(', ')}`);
