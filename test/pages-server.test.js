'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolve, readBody, invalidate } = require('../src/pages-server');

/** Writes `files` ({ 'a/b.html': 'text' }) into a fresh folder and returns its path. */
function site(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const get = (root, p, headers = {}, method = 'GET') =>
  resolve(root, { method, url: `https://clew.alefa.net${p}`, headers });
const text = (r) => readBody(r).toString('utf8');

// ---------------------------------------------------------------------------------------------

test('clean URLs serve and redirect like Pages (308, query kept)', () => {
  const root = site({
    'index.html': 'home',
    'about.html': 'about',
    'docs/index.html': 'docs',
    'docs/intro.html': 'intro',
  });
  assert.equal(text(get(root, '/')), 'home');
  assert.equal(text(get(root, '/about')), 'about');
  assert.equal(text(get(root, '/docs/')), 'docs');
  assert.equal(text(get(root, '/docs/intro')), 'intro');

  const cases = [
    ['/about.html', '/about'],
    ['/about.html?x=1', '/about?x=1'],
    ['/about/', '/about'],
    ['/index.html', '/'],
    ['/index', '/'],
    ['/docs', '/docs/'],
    ['/docs/index.html', '/docs/'],
    ['/docs/index', '/docs/'],
    ['/docs/intro.html', '/docs/intro'],
  ];
  for (const [from, to] of cases) {
    const r = get(root, from);
    assert.equal(r.status, 308, from);
    assert.equal(r.headers.location, to, from);
  }
});

test('non-HTML assets are served as-is with the right content type', () => {
  const root = site({
    'index.html': '<p>',
    'assets/app.js': 'js',
    'assets/app.css': 'css',
    'm.wasm': 'w',
    'x.webmanifest': '{}',
    '.well-known/thing.json': '{}',
  });
  assert.equal(get(root, '/assets/app.js').headers['content-type'], 'application/javascript');
  assert.equal(get(root, '/assets/app.css').headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(get(root, '/m.wasm').headers['content-type'], 'application/wasm');
  assert.equal(get(root, '/').headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(get(root, '/.well-known/thing.json').status, 200);
});

test('default headers match Pages', () => {
  const root = site({ 'index.html': 'home' });
  const h = get(root, '/').headers;
  assert.equal(h['access-control-allow-origin'], '*');
  assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['cache-control'], 'public, max-age=0, must-revalidate');
  assert.match(h.etag, /^"[0-9a-f]+"$/);
  assert.equal(get(root, '/', { Authorization: 'x' }).headers['cache-control'], undefined);
});

test('SPA fallback without a top-level 404.html', () => {
  const root = site({ 'index.html': 'app', 'assets/a.js': 'a' });
  for (const p of ['/nope', '/nope/deep/', '/assets/missing.js']) {
    const r = get(root, p);
    assert.equal(r.status, 200, p);
    assert.equal(text(r), 'app', p);
  }
});

test('404.html: nearest one up the tree, status 404', () => {
  const root = site({
    'index.html': 'app',
    '404.html': 'top 404',
    'blog/404.html': 'blog 404',
    'blog/post.html': 'post',
  });
  let r = get(root, '/nope');
  assert.equal(r.status, 404);
  assert.equal(text(r), 'top 404');
  r = get(root, '/blog/nope/deeper');
  assert.equal(r.status, 404);
  assert.equal(text(r), 'blog 404');
  r = get(root, '/blog/missing');
  assert.equal(text(r), 'blog 404');
});

test('no index.html and no 404.html: a bare 404 (like yaqatw)', () => {
  const root = site({ 'embed.html': 'embed', 'public/index.html': 'pub' });
  assert.equal(text(get(root, '/embed')), 'embed');
  assert.equal(get(root, '/public').headers.location, '/public/');
  const r = get(root, '/');
  assert.equal(r.status, 404);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.body, null);
  assert.equal(get(root, '/public/nothing-here').status, 404);
});

test('paths are case-sensitive, as on Pages', () => {
  const root = site({ 'index.html': 'i', '404.html': 'nf', 'About.html': 'A' });
  assert.equal(text(get(root, '/About')), 'A');
  assert.equal(get(root, '/about').status, 404);
});

test('_redirects: static, splat, placeholders, codes, order, 200 rewrites, external proxy', () => {
  const root = site({
    'index.html': 'home',
    'b.html': 'b',
    'c.html': 'c',
    'new/x.html': 'x',
    _redirects: [
      '# comment',
      '/old /new 301',
      '/old /second 302',
      '/default /target',
      '/blog/* https://blog.example.com/:splat',
      '/movies/:title /media/:title 307',
      '/a /b 200',
      '/b /c 200',
      '/ext/* https://api.example.com/v1/:splat 200',
      '/home /index.html 200',
      '/bad /x 404',
      'https://other.host/* /y 301',
      '/c /should-not-apply-to-assets-only 303',
    ].join('\n'),
  });
  let r = get(root, '/old');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/new');
  r = get(root, '/default');
  assert.equal(r.status, 302);
  assert.equal(get(root, '/blog/2024/post').headers.location, 'https://blog.example.com/2024/post');
  r = get(root, '/movies/dune');
  assert.equal(r.status, 307);
  assert.equal(r.headers.location, '/media/dune');
  assert.equal(get(root, '/movies/dune/extra').status, 200, 'placeholder spans one segment only');

  // 200: renders /b, and /b's own rule is not re-applied.
  r = get(root, '/a');
  assert.equal(r.status, 200);
  assert.equal(text(r), 'b');
  assert.equal(text(get(root, '/home')), 'home');

  // External 200 goes to the caller as a proxy target, query kept.
  assert.deepEqual(get(root, '/ext/items?q=1'), { proxy: 'https://api.example.com/v1/items?q=1' });

  // Unsupported codes and domain-level sources are ignored.
  assert.equal(get(root, '/bad').status, 200);
  // Redirects win over existing assets.
  assert.equal(get(root, '/c').status, 303);
});

test('_headers: matching, joining, detaching, placeholders, absolute URLs, overrides defaults', () => {
  const root = site({
    'index.html': 'home',
    'secure/page.html': 's',
    'static/a.jpg': 'j',
    'movies/dune.html': 'd',
    _headers: [
      '# comment',
      '/*',
      '  Content-Security-Policy: default-src self',
      '  X-Robots-Tag: one',
      '/static/*',
      '  X-Robots-Tag: two',
      '  Cache-Control: public, max-age=31556952, immutable',
      '/*.jpg',
      '  ! Content-Security-Policy',
      '/movies/:title',
      '  X-Movie: watching ":title"',
      'https://clew.alefa.net/secure/*',
      '  X-Frame-Options: DENY',
      'https://other.example/*',
      '  X-Other: no',
    ].join('\n'),
  });
  let h = get(root, '/static/a.jpg').headers;
  assert.equal(h['x-robots-tag'], 'one, two');
  assert.equal(h['content-security-policy'], undefined);
  assert.equal(h['cache-control'], 'public, max-age=31556952, immutable');
  h = get(root, '/movies/dune').headers;
  assert.equal(h['x-movie'], 'watching "dune"');
  assert.equal(h['content-security-policy'], 'default-src self');
  h = get(root, '/secure/page').headers;
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['x-other'], undefined);
  // Not applied to redirects.
  assert.equal(get(root, '/secure/page.html').headers['x-frame-options'], undefined);
});

test('_redirects and _headers are not served', () => {
  const root = site({ 'index.html': 'i', '404.html': 'nf', _headers: '/*\n  X: y', _redirects: '' });
  assert.equal(get(root, '/_headers').status, 404);
  assert.equal(get(root, '/_redirects').status, 404);
});

test('HEAD, other methods, ETag/304', () => {
  const root = site({ 'index.html': 'hello' });
  const head = get(root, '/', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers['content-length'], '5');
  assert.equal(get(root, '/', {}, 'POST').status, 405);
  const etag = get(root, '/').headers.etag;
  assert.equal(get(root, '/', { 'If-None-Match': etag }).status, 304);
  assert.equal(get(root, '/', { 'If-None-Match': `W/${etag}` }).status, 304);
});

test('Range requests', () => {
  const root = site({ 'index.html': 'i', 'media.bin': '0123456789' });
  let r = get(root, '/media.bin', { Range: 'bytes=2-5' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 2-5/10');
  assert.equal(r.headers['content-length'], '4');
  assert.equal(text(r), '2345');
  assert.equal(r.headers['cache-control'], undefined);
  assert.equal(text(get(root, '/media.bin', { Range: 'bytes=7-' })), '789');
  assert.equal(text(get(root, '/media.bin', { Range: 'bytes=-3' })), '789');
  assert.equal(text(get(root, '/media.bin', { Range: 'bytes=8-100' })), '89');
  r = get(root, '/media.bin', { Range: 'bytes=10-' });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], 'bytes */10');
  assert.equal(get(root, '/media.bin', { Range: 'bytes=0-1,4-5' }).status, 200, 'multi-range ignored');
});

test('path traversal stays inside the root', () => {
  const parent = site({ 'secret.txt': 'SECRET', 'site/index.html': 'app', 'site/404.html': 'nf' });
  const root = path.join(parent, 'site');
  const attempts = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/%5c..%5csecret.txt',
    '/foo/..%2f..%2fsecret.txt',
    '/secret.txt%00.html',
    '//secret.txt',
    '/%2f%2fsecret.txt',
    '/C:%5cWindows%5cwin.ini',
  ];
  for (const p of attempts) {
    const r = get(root, p);
    assert.notEqual(text(r), 'SECRET', p);
    assert.ok(r.status === 404 || r.status === 308, `${p} → ${r.status}`);
  }
});

test('symlinks pointing outside the root are refused', (t) => {
  const parent = site({ 'secret.txt': 'SECRET', 'site/index.html': 'app', 'site/404.html': 'nf' });
  const root = path.join(parent, 'site');
  try {
    fs.symlinkSync(path.join(parent, 'secret.txt'), path.join(root, 'link.txt'));
  } catch {
    t.skip('symlinks need extra rights on this system');
    return;
  }
  invalidate(root);
  assert.equal(get(root, '/link.txt').status, 404);
});
