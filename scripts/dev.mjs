#!/usr/bin/env node
// `npm run dev`: each app's own dev server (with hot reload) behind its real origin, then
// Electron. Electron restarts when main-process code or config changes; closing the app
// window stops everything.
//
// Sources come from the same place as for a build: `.sources/<name>` (run `npm run sources`
// first), or a local checkout (`CLEW_PATH=../ariadne`, `sites.local.json`). Install the app's
// dependencies there first (`npm run build:sites` does, or `npm ci` in the app).
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { ROOT, childEnv, fail, loadSites, run, upperDrive } from './lib.mjs';
import { launchElectron } from './electron.mjs';

const RUNNERS = {
  vite: (site) => [join(ROOT, 'dev', 'vite-dev.mjs'), site.dir, site.devRoot || '.', String(site.devPort)],
  webpack: (site) => [join(ROOT, 'dev', 'webpack-dev.cjs'), site.dir, String(site.devPort)],
};

const children = new Set();
let electron = null;
let stopping = false;

function prefixed(stream, label) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) console.log(`[${label}] ${line}`);
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, 'localhost');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(site, child, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) fail(`[${site.name}] dev server exited (${child.exitCode})`);
    if (await portOpen(site.devPort)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`[${site.name}] dev server did not open port ${site.devPort}`);
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  if (electron) electron.kill();
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 500);
}

function startElectron() {
  electron = launchElectron([], { CLEW_DESKTOP_DEV: '1' });
  const self = electron;
  self.on('exit', () => {
    if (electron === self && !stopping) {
      console.log('[dev] app closed, stopping dev servers');
      stopAll(0);
    }
  });
}

let restartTimer = null;
function restartElectron(reason) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[dev] ${reason} changed, restarting Electron`);
    const old = electron;
    electron = null;
    if (old) {
      old.once('exit', startElectron);
      old.kill();
    } else startElectron();
  }, 300);
}

process.on('SIGINT', () => stopAll(130));
process.on('SIGTERM', () => stopAll(143));

const sites = loadSites(process.argv.slice(2).filter((a) => !a.startsWith('--')));
for (const site of sites) {
  if (!existsSync(join(site.dir, 'node_modules'))) {
    fail(`[${site.name}] no node_modules in ${site.dir}: run "npm run sources && npm run build:sites" or install it.`);
  }
  const runner = RUNNERS[site.devServer];
  if (!runner) fail(`[${site.name}] unknown devServer "${site.devServer}"`);
  if (await portOpen(site.devPort)) fail(`[${site.name}] port ${site.devPort} is already in use`);
  if (site.devPrepare) await run(site.devPrepare, { cwd: site.dir, label: site.name });

  console.log(`[dev] starting ${site.name} (${site.devServer}) on http://localhost:${site.devPort} → https://${site.host}`);
  const child = spawn(process.execPath, runner(site), {
    cwd: upperDrive(site.dir),
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  prefixed(child.stdout, site.name);
  prefixed(child.stderr, site.name);
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[${site.name}] dev server exited (${code})`);
      stopAll(1);
    }
  });
  await waitForPort(site, child);
}

startElectron();

for (const target of ['src', 'sites.config.json', 'desktop.config.json']) {
  const full = join(ROOT, target);
  watch(full, { recursive: target === 'src' }, (_event, file) => restartElectron(file ? `${target}/${file}` : target));
}
