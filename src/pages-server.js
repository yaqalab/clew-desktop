'use strict';
/**
 * A Cloudflare Pages look-alike for one built site folder.
 *
 * `resolve(root, request)` answers a request the way Pages would answer it for the same
 * deployment, and returns `{ status, headers, body }` — or `{ proxy }` for an external `200`
 * rewrite. It never touches Electron, so the protocol handler, the optional localhost server
 * and the unit tests all share it.
 *
 * Behaviour, from the Pages docs (serving-pages, redirects, headers; read 2026-11-14) and
 * checked against clew.alefa.net and yaqatw.alefa.net where the docs are silent:
 *
 * - Clean URLs, all with 308 and the query string kept: `/a.html` → `/a`, `/a/` → `/a` when
 *   only `a.html` exists, `/d/index.html` and `/d/index` → `/d/`, `/d` → `/d/` when
 *   `d/index.html` exists. `/a` serves `a.html`, `/d/` serves `d/index.html`.
 * - Not found: with a top-level `404.html`, the nearest `404.html` up the tree, status 404.
 *   Without one, the site is a single-page app: `/index.html` with status 200. Neither → 404.
 * - `_redirects`: `source destination [code]`, default 302, codes 200/301/302/303/307/308,
 *   one `*` splat (`:splat`), `:placeholders` (one segment), first match in file order,
 *   applied before assets. A 200 rule renders the destination without re-matching rules.
 *   Pages cannot proxy an external 200; here it is passed on as `{ proxy }`, per the brief.
 * - `_headers`: indented `Name: value` under an unindented URL pattern (path or `https://host/path`,
 *   with splats and placeholders); every matching rule contributes, in file order; the same
 *   header twice is joined with ", "; `! Name` drops what earlier rules added. Custom headers
 *   replace the defaults below. Not applied to redirects.
 * - Defaults on every response: `Access-Control-Allow-Origin: *`,
 *   `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`;
 *   assets add `Content-Type`, `ETag` and, without `Authorization`/`Range`,
 *   `Cache-Control: public, max-age=0, must-revalidate`. A bare 404 is `Cache-Control: no-store`.
 * - GET and HEAD only (405 otherwise). `If-None-Match` → 304. A single `Range` → 206 (the
 *   docs still say 200, production already answers 206). `_redirects`/`_headers` are not served.
 * - Paths are matched case-sensitively, as on Pages, even on a case-insensitive disk, and a
 *   resolved path must stay inside the root: `..`, encoded separators, NUL and links that
 *   point outside the root are all "not found".
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { contentType } = require('./mime');

const DEFAULT_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
});
const CACHEABLE = 'public, max-age=0, must-revalidate';
const REDIRECT_CODES = new Set([200, 301, 302, 303, 307, 308]);
const HIDDEN_AT_ROOT = new Set(['_redirects', '_headers', '.build-info.json']);

// ---------------------------------------------------------------------------------------------
// Patterns shared by _redirects and _headers

const PLACEHOLDER = /:([A-Za-z]\w*)/g;

function escapeRegex(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Turns one side of a pattern into a regex; `delim` is what a placeholder may not cross. */
function partToRegex(part, delim) {
  let out = '';
  let last = 0;
  const re = /\*|:([A-Za-z]\w*)/g;
  let m;
  while ((m = re.exec(part))) {
    out += escapeRegex(part.slice(last, m.index));
    out += m[0] === '*' ? '(?<splat>.*)' : `(?<${m[1]}>[^${delim}]+)`;
    last = m.index + m[0].length;
  }
  return out + escapeRegex(part.slice(last));
}

/** `{ host: RegExp|null, path: RegExp }`, or null for a pattern Pages would refuse. */
function compilePattern(source) {
  if ((source.match(/\*/g) || []).length > 1) return null;
  const names = [...source.matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (new Set(names).size !== names.length || names.includes('splat')) return null;
  try {
    const abs = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(source);
    if (abs) {
      return {
        host: new RegExp(`^${partToRegex(abs[1].replace(/:\d+$/, ''), './')}$`, 'i'),
        path: new RegExp(`^${partToRegex(abs[2] || '/', '/')}$`),
      };
    }
    if (!source.startsWith('/')) return null;
    return { host: null, path: new RegExp(`^${partToRegex(source, '/')}$`) };
  } catch {
    return null;
  }
}

function matchPattern(pattern, host, pathname) {
  if (pattern.host) {
    const h = pattern.host.exec(host);
    if (!h) return null;
    const p = pattern.path.exec(pathname);
    return p ? { ...h.groups, ...p.groups } : null;
  }
  const p = pattern.path.exec(pathname);
  return p ? { ...p.groups } : null;
}

function substitute(template, params) {
  return template.replace(/:([A-Za-z]\w*)/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] ?? '' : whole,
  );
}

// ---------------------------------------------------------------------------------------------
// Rule files

function parseRedirects(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) continue;
    const [source, destination, codeText] = parts;
    const status = codeText === undefined ? 302 : Number(codeText);
    if (!REDIRECT_CODES.has(status)) continue;
    // Domain-level redirects are not supported by Pages.
    if (!source.startsWith('/')) continue;
    const pattern = compilePattern(source.split('#')[0]);
    if (!pattern) continue;
    rules.push({ source, destination, status, pattern });
  }
  return rules;
}

function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const pattern = compilePattern(raw.trim());
      current = pattern ? { source: raw.trim(), pattern, ops: [] } : null;
      if (current) rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (line.startsWith('!')) {
      const name = line.slice(1).trim().toLowerCase();
      if (name) current.ops.push({ detach: true, name });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current.ops.push({
      detach: false,
      name: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim(),
    });
  }
  return rules;
}

/** The headers every matching `_headers` rule adds, in file order. */
function customHeaders(rules, host, pathname) {
  const out = {};
  for (const rule of rules) {
    const params = matchPattern(rule.pattern, host, pathname);
    if (!params) continue;
    for (const op of rule.ops) {
      if (op.detach) delete out[op.name];
      else {
        const value = substitute(op.value, params);
        out[op.name] = op.name in out ? `${out[op.name]}, ${value}` : value;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The site: an exact-case, root-confined view of one folder

class Site {
  constructor(root) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
    this.listings = new Map();
    this.rulesStamp = null;
    this.redirects = [];
    this.headers = [];
  }

  /** Entries of a directory, by exact name; cached, since a bundled site never changes. */
  listing(dir) {
    let entries = this.listings.get(dir);
    if (!entries) {
      entries = new Map();
      try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) entries.set(d.name, d);
      } catch {
        /* not a directory */
      }
      this.listings.set(dir, entries);
    }
    return entries;
  }

  /**
   * The absolute path of a file at a decoded URL path, or null. Every segment must exist with
   * this exact case, and the real path must stay inside the root.
   */
  file(urlPath) {
    const segments = urlPath.split('/').slice(1);
    if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
      return null;
    }
    if (segments.length === 1 && HIDDEN_AT_ROOT.has(segments[0])) return null;
    let dir = this.root;
    for (let i = 0; i < segments.length; i++) {
      const entry = this.listing(dir).get(segments[i]);
      if (!entry) return null;
      const full = path.join(dir, segments[i]);
      const last = i === segments.length - 1;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(full);
        } catch {
          return null;
        }
        if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) return null;
        const st = fs.statSync(real);
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (last ? !isFile : !isDir) return null;
      dir = full;
    }
    return dir;
  }

  /** Re-reads `_redirects` and `_headers` when either changes (cheap: two stats). */
  rules() {
    const stamp = ['_redirects', '_headers']
      .map((n) => {
        try {
          return fs.statSync(path.join(this.root, n)).mtimeMs;
        } catch {
          return 0;
        }
      })
      .join('|');
    if (stamp !== this.rulesStamp) {
      this.rulesStamp = stamp;
      const read = (n) => {
        try {
          return fs.readFileSync(path.join(this.root, n), 'utf8');
        } catch {
          return '';
        }
      };
      this.redirects = parseRedirects(read('_redirects'));
      this.headers = parseHeaders(read('_headers'));
      this.listings.clear();
    }
    return this;
  }
}

const sites = new Map();
function siteFor(root) {
  const key = path.resolve(root);
  let site = sites.get(key);
  if (!site) {
    site = new Site(key);
    sites.set(key, site);
  }
  return site.rules();
}

// ---------------------------------------------------------------------------------------------
// Resolution

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? null : headers[key];
}

/** Decodes a URL path segment by segment; null if a segment hides a separator or NUL. */
function decodePath(pathname) {
  const out = [];
  for (const seg of pathname.split('/')) {
    let d;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (d.includes('/') || d.includes('\\') || d.includes('\0')) return null;
    out.push(d);
  }
  return out.join('/');
}

/**
 * What the decoded path is, before any 404 handling:
 * `{ file }`, `{ redirect: newEncodedPath }` or null.
 */
function route(site, decoded, encoded) {
  const has = (p) => site.file(p) !== null;
  if (decoded.endsWith('/index.html') && has(decoded)) {
    return { redirect: encoded.slice(0, -'index.html'.length) };
  }
  if (decoded.endsWith('/index') && has(`${decoded}.html`)) {
    return { redirect: encoded.slice(0, -'index'.length) };
  }
  if (decoded.endsWith('.html') && has(decoded)) {
    return { redirect: encoded.slice(0, -'.html'.length) };
  }
  if (decoded.endsWith('/')) {
    const index = site.file(`${decoded}index.html`);
    if (index) return { file: index };
    if (decoded !== '/' && has(`${decoded.slice(0, -1)}.html`)) {
      return { redirect: encoded.slice(0, -1) };
    }
    return null;
  }
  const exact = site.file(decoded);
  if (exact) return { file: exact };
  const html = site.file(`${decoded}.html`);
  if (html) return { file: html };
  if (has(`${decoded}/index.html`)) return { redirect: `${encoded}/` };
  return null;
}

function notFoundFile(site, decoded) {
  if (!site.file('/404.html')) {
    const index = site.file('/index.html');
    return index ? { file: index, status: 200 } : null;
  }
  let dir = decoded.endsWith('/') ? decoded : decoded.slice(0, decoded.lastIndexOf('/') + 1);
  for (;;) {
    const page = site.file(`${dir}404.html`);
    if (page) return { file: page, status: 404 };
    if (dir === '/' || dir === '') return null;
    dir = dir.slice(0, dir.slice(0, -1).lastIndexOf('/') + 1);
  }
}

function etagFor(file, stat) {
  const h = crypto.createHash('sha1');
  h.update(`${file}\0${stat.size}\0${stat.mtimeMs}`);
  return `"${h.digest('hex').slice(0, 32)}"`;
}

/** `{ start, end }` (inclusive), `'unsatisfiable'`, or null to ignore the header. */
function parseRange(value, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((value || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

function serveFile(site, file, status, req, url) {
  const stat = fs.statSync(file);
  const etag = etagFor(file, stat);
  const headers = { ...DEFAULT_HEADERS, 'content-type': contentType(file), etag };
  const range = header(req.headers, 'range');
  if (!header(req.headers, 'authorization') && !range) headers['cache-control'] = CACHEABLE;
  Object.assign(headers, customHeaders(site.headers, url.hostname, url.pathname));

  const inm = header(req.headers, 'if-none-match');
  if (status === 200 && inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    delete headers['content-type'];
    return { status: 304, headers, body: null };
  }

  let start = 0;
  let end = stat.size - 1;
  if (status === 200 && range) {
    const r = parseRange(range, stat.size);
    if (r === 'unsatisfiable') {
      return {
        status: 416,
        headers: { ...DEFAULT_HEADERS, 'content-range': `bytes */${stat.size}` },
        body: null,
      };
    }
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  if (status === 200 || status === 206) headers['accept-ranges'] = 'bytes';
  headers['content-length'] = String(stat.size === 0 ? 0 : end - start + 1);
  const isHead = req.method === 'HEAD';
  return {
    status,
    headers,
    body: isHead || stat.size === 0 ? null : { file, start, end },
  };
}

function redirectTo(location, status) {
  return { status, headers: { ...DEFAULT_HEADERS, location }, body: null };
}

/**
 * @param {string} root  the site's folder
 * @param {{ method?: string, url: string, headers?: Headers|Record<string,string> }} req
 *        `url` is absolute (`https://clew.alefa.net/a?b`)
 * @returns {{ status: number, headers: Record<string,string>,
 *            body: null | Buffer | { file: string, start: number, end: number },
 *            proxy?: string }}
 */
function resolve(root, req) {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url);
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { ...DEFAULT_HEADERS, allow: 'GET, HEAD' }, body: null };
  }
  const site = siteFor(root);
  const encoded = url.pathname;

  // _redirects first: "always followed, regardless of whether an asset matches".
  let target = { decoded: decodePath(encoded), encoded };
  for (const rule of site.redirects) {
    const params = matchPattern(rule.pattern, url.hostname, encoded);
    if (!params) continue;
    const destination = substitute(rule.destination, params);
    if (rule.status !== 200) return redirectTo(destination, rule.status);
    if (/^https?:\/\//i.test(destination)) {
      const proxied = new URL(destination);
      if (!proxied.search && url.search) proxied.search = url.search;
      return { proxy: proxied.href };
    }
    const internal = new URL(destination, url);
    target = { decoded: decodePath(internal.pathname), encoded: internal.pathname, rewritten: true };
    break;
  }

  if (target.decoded !== null) {
    const r = route(site, target.decoded, target.encoded);
    if (r?.file) return serveFile(site, r.file, 200, { ...req, method }, url);
    if (r?.redirect && !target.rewritten) return redirectTo(r.redirect + url.search, 308);
  }

  const fallback = target.decoded === null ? notFoundFile(site, '/') : notFoundFile(site, target.decoded);
  if (fallback) return serveFile(site, fallback.file, fallback.status, { ...req, method }, url);
  return {
    status: 404,
    headers: { ...DEFAULT_HEADERS, 'cache-control': 'no-store' },
    body: null,
  };
}

/** The body as a Node readable stream, or null. */
function bodyStream(result) {
  const b = result.body;
  if (!b) return null;
  if (Buffer.isBuffer(b)) return require('node:stream').Readable.from([b]);
  return fs.createReadStream(b.file, { start: b.start, end: b.end });
}

/** The whole body as a Buffer (tests, small files). */
function readBody(result) {
  const b = result.body;
  if (!b) return Buffer.alloc(0);
  if (Buffer.isBuffer(b)) return b;
  const fd = fs.openSync(b.file, 'r');
  try {
    const buf = Buffer.alloc(b.end - b.start + 1);
    fs.readSync(fd, buf, 0, buf.length, b.start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** Forget cached listings and rules (a site folder was replaced). */
function invalidate(root) {
  if (root) sites.delete(path.resolve(root));
  else sites.clear();
}

module.exports = {
  resolve,
  bodyStream,
  readBody,
  invalidate,
  // exported for tests
  parseRedirects,
  parseHeaders,
  compilePattern,
};
