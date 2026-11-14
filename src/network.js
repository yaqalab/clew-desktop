'use strict';
/**
 * Routes the bundled hosts of the app's session to the in-app server, and leaves every other
 * request to Chromium.
 *
 * - A PAC script sends only `clew.alefa.net` and `yaqatw.alefa.net` (http and https) to the
 *   loopback proxy. Every other host gets what the system's proxy settings give it
 *   (resolved once at start-up from the default session; usually DIRECT).
 * - The in-app certificate is accepted for those hostnames only, and only that exact
 *   certificate: a bundled host presenting anything else is refused. All other hosts go
 *   through Chromium's normal verification.
 */
const path = require('node:path');
const { app, session } = require('electron');
const tls = require('./tls');
const { createSiteServer } = require('./local-server');

async function systemProxyFallback() {
  try {
    const value = await session.defaultSession.resolveProxy('https://www.google.com/');
    return value && value.trim() ? value.trim() : 'DIRECT';
  } catch {
    return 'DIRECT';
  }
}

async function install(ses, sites) {
  const hosts = sites.list.map((s) => s.host);
  const { key, cert } = await tls.loadOrCreate(path.join(app.getPath('userData'), 'tls'), hosts);
  const server = createSiteServer({ sites, key, cert });
  const port = await server.listen();
  server.setPacFallback(await systemProxyFallback());

  const ours = tls.normalizePem(cert);
  ses.setCertificateVerifyProc((request, callback) => {
    if (!sites.byHost(request.hostname)) {
      callback(-3); // Chromium's own verification
      return;
    }
    callback(tls.normalizePem(request.certificate.data) === ours ? 0 : -2);
  });

  await ses.setProxy({ mode: 'pac_script', pacScript: `http://127.0.0.1:${port}/proxy.pac` });
  await ses.closeAllConnections();
  return server;
}

module.exports = { install };
