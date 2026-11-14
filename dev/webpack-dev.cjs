#!/usr/bin/env node
// Runs a webpack app's dev server for clew-desktop, without touching the app's repo:
// `node dev/webpack-dev.cjs <appDir> <port>`.
//
// The app's own `webpack.config.js` is loaded with the arguments `webpack serve --mode
// development` would give it; only the dev server is overridden: plain http on a fixed port
// (the in-app server provides the real https origin, so no dev certificate is needed), and the
// HMR client pointed straight at `ws://localhost:<port>/ws`.
'use strict';
const path = require('node:path');

const [appDir, portText] = process.argv.slice(2);
const port = Number(portText);
if (!appDir || !port) {
  console.error('usage: webpack-dev.cjs <appDir> <port>');
  process.exit(2);
}
const dir = path.resolve(appDir);
process.chdir(dir);
const fromApp = (id) => require(require.resolve(id, { paths: [dir] }));

(async () => {
  const webpack = fromApp('webpack');
  const WebpackDevServer = fromApp('webpack-dev-server');
  const exported = require(path.join(dir, 'webpack.config.js'));
  // `https: false` also keeps yaqatw's config from asking for Office dev certificates.
  const config =
    typeof exported === 'function'
      ? await exported({ WEBPACK_SERVE: true }, { mode: 'development', https: false })
      : exported;
  const devServer = { ...(config.devServer || {}) };
  delete config.devServer;
  config.mode = 'development';

  Object.assign(devServer, {
    server: { type: 'http' },
    host: 'localhost',
    port,
    open: false,
    allowedHosts: 'all',
    client: { ...(devServer.client || {}), webSocketURL: `ws://localhost:${port}/ws` },
  });

  const server = new WebpackDevServer(devServer, webpack(config));
  await server.start();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
