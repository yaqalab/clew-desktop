#!/usr/bin/env node
// `npm run package:dictation [-- <dist folder>]`: packs a built dictation server
// (the output of tools/stt-server's build_exe.ps1 on Windows, build_dist.sh on macOS and Linux:
// `dist/clew-stt-server/`) into what Clew Desktop
// fetches on demand (src/tools/dictation-install.js), for the public clew-tools release:
//
//   release-dictation/clew-stt-server-<version>-<platform>-<arch>.tar.gz
//   release-dictation/dictation.json     { version, packages: { "<platform>-<arch>": { file, sha256, size } } }
//
// Run it once per system (Windows, macOS, Linux) into the same folder: each run adds its own
// package to dictation.json. Then attach every file to the release `v<version>` of
// yaqalab/clew-tools (this script publishes nothing).
//
// The version is tools/VERSION of the Clew source; the default folder is that source's
// tools/stt-server/dist/clew-stt-server. Its THIRD-PARTY-NOTICES.txt travels inside the package.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ROOT, fail, loadSites } from './lib.mjs';

const [clew] = loadSites(['clew']);
const tools = process.env.TOOLS_PATH || join(clew.dir, 'tools');
const dist = process.argv[2] || join(tools, 'stt-server', 'dist', 'clew-stt-server');
const program = process.platform === 'win32' ? 'clew-stt-server.exe' : 'clew-stt-server';
if (basename(dist) !== 'clew-stt-server' || !existsSync(join(dist, program))) {
  fail(`no built dictation server at ${dist} (expected clew-stt-server/${program}); run tools/stt-server/${process.platform === 'win32' ? 'build_exe.ps1' : 'build_dist.sh'}`);
}
const version = readFileSync(join(tools, 'VERSION'), 'utf8').trim();
const key = `${process.platform}-${process.arch}`;
const file = `clew-stt-server-${version}-${key}.tar.gz`;
const out = join(ROOT, 'release-dictation');
mkdirSync(out, { recursive: true });

const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
console.log(`[dictation] packing ${dist} → release-dictation/${file}`);
execFileSync(tar, ['-czf', join(out, file), '-C', dirname(dist), 'clew-stt-server'], { stdio: 'inherit' });

const bytes = readFileSync(join(out, file));
const entry = { file, sha256: createHash('sha256').update(bytes).digest('hex'), size: statSync(join(out, file)).size };
const manifestFile = join(out, 'dictation.json');
let manifest = { version, packages: {} };
if (existsSync(manifestFile)) {
  const old = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (old.version === version) manifest = old;
}
manifest.packages[key] = entry;
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[dictation] ✔ ${file} (${Math.round(entry.size / 1e6)} MB, sha256 ${entry.sha256.slice(0, 16)}…) and dictation.json`);
