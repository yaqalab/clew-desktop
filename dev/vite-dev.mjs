#!/usr/bin/env node
// Runs a Vite app's dev server for clew-desktop, without touching the app's repo:
// `node dev/vite-dev.mjs <appDir> <devRoot> <port>`.
//
// The app's own `vite.config.*` is loaded as usual; this only overrides the server: a fixed
// port, and HMR pointed straight at `ws://localhost:<port>`. The page runs at
// `https://<real host>`, and WebSockets are not routed to the in-app server, so the default
// (same host as the page) would reach the real domain instead.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appDir, devRoot = '.', portText] = process.argv.slice(2);
const port = Number(portText);
if (!appDir || !port) {
  console.error('usage: vite-dev.mjs <appDir> <devRoot> <port>');
  process.exit(2);
}
const root = resolve(appDir, devRoot);

// Vite from the app's own node_modules (ESM-only, so resolve its entry by hand).
const require = createRequire(join(root, 'package.json'));
const pkgPath = require.resolve('vite/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const pick = (e) => (typeof e === 'string' ? e : e && (pick(e.import) || pick(e.default)));
const entry = pick(pkg.exports?.['.']) || pkg.module || pkg.main;
const vite = await import(pathToFileURL(join(dirname(pkgPath), entry)).href);

process.chdir(root);
const server = await vite.createServer({
  root,
  server: {
    host: 'localhost',
    port,
    strictPort: true,
    hmr: { protocol: 'ws', host: 'localhost', clientPort: port },
  },
});
await server.listen();
server.printUrls();
