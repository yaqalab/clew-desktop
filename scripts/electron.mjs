#!/usr/bin/env node
// Starts Electron on this app with the given arguments. Clears ELECTRON_RUN_AS_NODE first:
// terminals inside VS Code (and other Electron hosts) set it, and it makes Electron start as
// plain Node, without `app`, `BrowserWindow` or `ipcMain`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron'); // the binary's path, when required from Node
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function launchElectron(args = [], extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(electron, [root, ...args], { stdio: 'inherit', env, windowsHide: false });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const child = launchElectron(process.argv.slice(2));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
