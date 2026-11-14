#!/usr/bin/env node
// `npm run sources [-- <name>…]`: clone or update each app into `.sources/<name>/` at its
// configured ref (shallow). A site with a local override (`<NAME>_PATH`, `sites.local.json`)
// is left exactly as it is: only its commit is reported.
import { existsSync, mkdirSync } from 'node:fs';
import { git, loadSites, fail } from './lib.mjs';

function update(site) {
  if (!existsSync(site.dir)) {
    mkdirSync(site.dir, { recursive: true });
    git(['init', '--quiet'], site.dir);
    git(['remote', 'add', 'origin', site.repo], site.dir);
  } else if (!existsSync(`${site.dir}/.git`)) {
    fail(`${site.dir} exists but is not a Git checkout; remove it and run again.`);
  } else {
    git(['remote', 'set-url', 'origin', site.repo], site.dir);
  }
  console.log(`[${site.name}] fetching ${site.repo} @ ${site.ref}`);
  git(['fetch', '--depth', '1', '--quiet', 'origin', site.ref], site.dir);
  git(['checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD'], site.dir);
  // Untracked files go; ignored ones (node_modules, .env) stay, so rebuilds are fast.
  git(['clean', '-fdq'], site.dir);
}

for (const site of loadSites(process.argv.slice(2))) {
  if (site.local) {
    if (!existsSync(site.dir)) fail(`[${site.name}] local checkout not found: ${site.dir}`);
    const sha = git(['rev-parse', 'HEAD'], site.dir);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], site.dir);
    const dirty = git(['status', '--porcelain'], site.dir) !== '';
    console.log(
      `[${site.name}] using local checkout ${site.dir} (${branch} @ ${sha.slice(0, 12)}${dirty ? ', local changes' : ''})`,
    );
    continue;
  }
  try {
    update(site);
  } catch (err) {
    fail(`[${site.name}] ${err.message}`);
  }
  console.log(`[${site.name}] ${git(['rev-parse', 'HEAD'], site.dir)}`);
}
