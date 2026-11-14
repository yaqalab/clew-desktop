#!/usr/bin/env node
// `npm run build:sites [-- <name>…] [--install]`: for each app, install its dependencies from
// its own lockfile, run its build, and copy the output into `sites/<name>/` with a
// `.build-info.json` (repo, ref, commit) that the About dialog shows.
//
// - A clone in `.sources/` always gets `npm ci`, and its `.env` from `env/<name>.env` (or the
//   override; see lib.mjs). A local checkout is used as it is: its own `.env`, and `npm ci`
//   only when it has no node_modules yet or `--install` is given.
// - Fails loudly when the output folder is missing or empty.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, childEnv, fail, git, loadSites, run } from './lib.mjs';

const args = process.argv.slice(2);
const forceInstall = args.includes('--install');
const noInstall = args.includes('--no-install');
const names = args.filter((a) => !a.startsWith('--'));

/** Very small `engines.node` check (>=x.y.z, ^x, x.x); anything else is only printed. */
function checkNode(site) {
  let range;
  try {
    range = JSON.parse(readFileSync(join(site.dir, 'package.json'), 'utf8')).engines?.node;
  } catch {
    return;
  }
  if (!range) return;
  const have = process.versions.node.split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const m = /^\s*(>=|\^)?\s*v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?\s*$/.exec(range);
  if (!m) {
    console.log(`[${site.name}] engines.node "${range}" (not checked); running Node ${process.versions.node}`);
    return;
  }
  const want = [Number(m[2]), Number(m[3]) || 0, Number(m[4]) || 0];
  const ok = m[1] === '>=' ? cmp(have, want) >= 0 : have[0] === want[0] && cmp(have, want) >= 0;
  if (!ok) {
    console.warn(`[${site.name}] ⚠ needs Node ${range}, running ${process.versions.node}. The build may fail.`);
  }
}

function prepareEnv(site) {
  const target = join(site.dir, site.envFile || '.env');
  if (site.local) {
    console.log(`[${site.name}] local checkout: using its own ${site.envFile || '.env'}${existsSync(target) ? '' : ' (none found!)'}`);
    return;
  }
  if (existsSync(site.envSource)) {
    copyFileSync(site.envSource, target);
    console.log(`[${site.name}] build settings from ${site.envSource}`);
  } else {
    console.warn(
      `[${site.name}] ⚠ no build settings at ${site.envSource}: features that need keys (cloud sync, sign-in) will be off.`,
    );
  }
}

async function build(site) {
  if (!existsSync(join(site.dir, 'package.json'))) {
    fail(`[${site.name}] no source at ${site.dir}. Run "npm run sources" first.`);
  }
  checkNode(site);
  prepareEnv(site);

  if (noInstall && existsSync(join(site.dir, 'node_modules'))) {
    console.log(`[${site.name}] --no-install: using the existing node_modules`);
  } else if (!site.local || forceInstall || !existsSync(join(site.dir, 'node_modules'))) {
    await run(site.installCommand || 'npm ci', { cwd: site.dir, label: site.name });
  } else {
    console.log(`[${site.name}] node_modules present, skipping install (use --install to force)`);
  }
  await run(site.buildCommand, { cwd: site.dir, label: site.name, env: childEnv(site.buildEnv) });

  const out = join(site.dir, site.outputDir);
  if (!existsSync(out) || readdirSync(out).length === 0) {
    fail(`[${site.name}] build output ${out} is missing or empty.`);
  }

  const dest = join(ROOT, 'sites', site.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(out, dest, { recursive: true });

  const info = {
    name: site.name,
    host: site.host,
    repo: site.repo,
    ref: site.local ? git(['rev-parse', '--abbrev-ref', 'HEAD'], site.dir) : site.ref,
    commit: git(['rev-parse', 'HEAD'], site.dir),
    // What src/site-updates.js compares with the builds published between installers.
    committedAt: git(['log', '-1', '--format=%cI'], site.dir),
    dirty: site.local ? git(['status', '--porcelain'], site.dir) !== '' : false,
    source: site.local ? 'local checkout' : 'clone',
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dest, '.build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`[${site.name}] ✔ ${out} → sites/${site.name} (${info.commit.slice(0, 12)})`);
}

for (const site of loadSites(names)) {
  try {
    await build(site);
  } catch (err) {
    fail(`[${site.name}] ${err.message}`);
  }
}
