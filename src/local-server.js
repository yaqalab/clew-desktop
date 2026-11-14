'use strict';
/**
 * The in-app server for the bundled hosts. Plain Node: no Electron here.
 *
 * Two parts:
 * - `handle(req, res)`: answers one HTTPS request for a bundled host, from its folder through
 *   `pages-server`, or in dev from the app's own dev server.
 * - a loopback HTTP proxy that the app's session reaches through a PAC script. Only the
 *   bundled hosts are routed to it: a `CONNECT host:443` is answered by ending TLS here with
 *   the app's own certificate; a plain `http://` request gets a 308 to `https://`. It refuses
 *   every other host. The proxy also serves the PAC script itself.
 *
 * Everything not routed here is ordinary Chromium networking, so Origin, Referer, CORS and
 * cookies behave exactly as in a browser.
 */
const http = require('node:http');
const https = require('node:https');
const { pipeline, Readable } = require('node:stream');
const pages = require('./pages-server');

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(target, req, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: target.host };
    const up = http.request(target, { method: req.method, headers }, resolve);
    up.on('error', reject);
    up.end(body.length ? body : undefined);
  });
}

function createSiteServer({ sites, key, cert, log = console }) {
  const stats = { local: 0, dev: 0, proxied: 0, errors: 0 };
  let pacFallback = 'DIRECT';
  let port = 0;

  /**
   * Dev: the app's own dev server answers, under the real origin. A 404 on an extension-less
   * path is retried as `.html`, which is what Pages would serve (`/embed` → `embed.html`).
   */
  async function proxyToDev(site, req, res) {
    stats.dev++;
    const dev = new URL(site.devUrl);
    const body = await readAll(req);
    let target = new URL(req.url, dev);
    let up = await forward(target, req, body);
    const last = target.pathname.split('/').pop();
    if (up.statusCode === 404 && last && !last.includes('.') && /^(GET|HEAD)$/.test(req.method)) {
      const html = new URL(`${target.pathname}.html${target.search}`, dev);
      const retry = await forward(html, req, body);
      if (retry.statusCode < 400) {
        up.resume();
        up = retry;
        target = html;
      } else retry.resume();
    }
    const headers = { ...up.headers };
    if (headers.location) {
      const loc = new URL(headers.location, target);
      if (loc.host === dev.host) headers.location = site.origin + loc.pathname + loc.search + loc.hash;
    }
    res.writeHead(up.statusCode, up.statusMessage, headers);
    pipeline(up, res, () => {});
  }

  /** An external `200` rewrite from `_redirects` (Pages itself cannot do this). */
  async function proxyExternal(url, req, res) {
    stats.proxied++;
    const headers = { ...req.headers };
    delete headers.host;
    const hasBody = !/^(GET|HEAD)$/.test(req.method);
    const r = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? await readAll(req) : undefined,
      redirect: 'manual',
    });
    const out = {};
    r.headers.forEach((v, k) => {
      if (k !== 'content-encoding' && k !== 'content-length') out[k] = v;
    });
    res.writeHead(r.status, out);
    if (r.body) pipeline(Readable.fromWeb(r.body), res, () => {});
    else res.end();
  }

  async function handle(req, res) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const site = sites.byHost(host);
    if (!site) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Misdirected request');
      return;
    }
    try {
      if (site.devUrl) {
        await proxyToDev(site, req, res);
        return;
      }
      const result = pages.resolve(site.root, {
        method: req.method,
        url: `https://${host}${req.url}`,
        headers: req.headers,
      });
      if (result.proxy) {
        await proxyExternal(result.proxy, req, res);
        return;
      }
      stats.local++;
      res.writeHead(result.status, result.headers);
      const body = pages.bodyStream(result);
      if (body) pipeline(body, res, () => {});
      else res.end();
    } catch (err) {
      stats.errors++;
      log.error(`[server] ${req.method} https://${host}${req.url}:`, err.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`clew-desktop: ${err.message}`);
    }
  }

  const tlsServer = https.createServer({ key, cert }, handle);
  tlsServer.on('tlsClientError', () => {});

  function pac() {
    const test = sites.list.map((s) => `host == ${JSON.stringify(s.host.toLowerCase())}`).join(' || ');
    return [
      'function FindProxyForURL(url, host) {',
      '  host = host.toLowerCase();',
      `  if (${test}) return "PROXY 127.0.0.1:${port}";`,
      `  return ${JSON.stringify(pacFallback)};`,
      '}',
      '',
    ].join('\n');
  }

  const proxy = http.createServer((req, res) => {
    if (req.url === '/proxy.pac') {
      res.writeHead(200, {
        'content-type': 'application/x-ns-proxy-autoconfig',
        'cache-control': 'no-store',
      });
      res.end(pac());
      return;
    }
    // A proxied plain-http request carries an absolute URL.
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.protocol === 'http:' && sites.byHost(url.hostname)) {
      url.protocol = 'https:';
      url.port = '';
      res.writeHead(308, { location: url.href });
      res.end();
      return;
    }
    res.writeHead(403);
    res.end();
  });

  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    if (!m || !sites.byHost(m[1]) || m[2] !== '443') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) socket.unshift(head);
    tlsServer.emit('connection', socket);
  });

  return {
    stats,
    handle,
    pac,
    get port() {
      return port;
    },
    setPacFallback(value) {
      pacFallback = value || 'DIRECT';
    },
    listen(listenPort = 0, hostname = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(listenPort, hostname, () => {
          port = proxy.address().port;
          resolve(port);
        });
      });
    },
    close() {
      proxy.close();
      tlsServer.close();
    },
  };
}

module.exports = { createSiteServer };
