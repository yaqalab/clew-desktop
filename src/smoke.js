'use strict';
/**
 * `npm run smoke`: opens the app hidden, checks the things that matter under the intercept,
 * prints one line per check and exits non-zero if any failed.
 */
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

function echoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url.startsWith('/nocors')) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('no cors headers');
          return;
        }
        if (req.url.startsWith('/redirect')) {
          res.writeHead(302, { location: '/echo?from=redirect', 'access-control-allow-origin': '*' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'set-cookie': 'smoke=1; Path=/',
        });
        res.end(
          JSON.stringify({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A GET as a program sends it: no Origin, no browser headers. */
function programGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

async function finalUrl(ses, url) {
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
  try {
    await win.loadURL(url).catch(() => {});
    return win.webContents.getURL();
  } finally {
    win.destroy();
  }
}

async function run(win, ses, server, tools, folder, db, api) {
  const { stats } = server;
  setTimeout(() => {
    console.error('smoke: timed out');
    app.exit(2);
  }, 120000).unref();
  const pageErrors = [];
  win.webContents.on('console-message', (event, level, message) => {
    // Electron ≥ 35 passes one event object; older versions pass (event, level, message).
    const lvl = event?.level ?? level;
    const msg = event?.message ?? message;
    if (lvl === 'error' || lvl === 3) pageErrors.push(String(msg));
  });
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const echoSrv = await echoServer();
  const echo = `http://127.0.0.1:${echoSrv.address().port}`;

  try {
    await new Promise((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once('did-finish-load', resolve);
    });

    await check('main window has the real origin', async () => {
      const origin = await js('location.origin');
      assert(origin === 'https://clew.alefa.net', origin);
      return origin;
    });

    await check('Clew renders, with no uncaught errors', async () => {
      let children = 0;
      for (let i = 0; i < 20 && !children; i++) {
        children = await js("document.getElementById('app')?.childElementCount ?? 0");
        if (!children) await wait(250);
      }
      const uncaught = pageErrors.filter((m) => /Uncaught|Invalid hook call/i.test(m));
      assert(uncaught.length === 0, uncaught[0]?.slice(0, 160));
      assert(children > 0, '#app is empty');
      return `#app has ${children} element(s)`;
    });

    await check('window.alefaDesktop is exposed', async () => {
      const v = await js('window.alefaDesktop && window.alefaDesktop.version');
      assert(v, 'missing');
      return v;
    });

    await check('yaqatw is served locally (no network)', async () => {
      const before = stats.local;
      const status = await js("fetch('https://yaqatw.alefa.net/embed').then(r => r.status)");
      assert(status === 200, `status ${status}`);
      assert(stats.local > before, JSON.stringify(stats));
      return `status ${status}, served from disk`;
    });

    await check('yaqatw iframe loads at its origin and sees alefaDesktop', async () => {
      await js(`new Promise((resolve, reject) => {
        const f = document.createElement('iframe');
        f.src = 'https://yaqatw.alefa.net/embed';
        f.onload = resolve; f.onerror = reject;
        f.style.cssText = 'position:fixed;width:10px;height:10px;opacity:0';
        document.body.appendChild(f);
      })`);
      const frame = win.webContents.mainFrame.framesInSubtree.find(
        (f) => f.origin === 'https://yaqatw.alefa.net',
      );
      assert(frame, 'no yaqatw frame');
      const seen = await frame.executeJavaScript('typeof window.alefaDesktop');
      assert(seen === 'object', `alefaDesktop in frame: ${seen}`);
      return frame.url;
    });

    await check('Clew has its folder (write, list, read, remove), yaqatw does not', async () => {
      const r = await js(`(async () => {
        const f = window.alefaDesktop.folder;
        const bytes = new Uint8Array([1, 2, 3, 250]);
        await f.write('Smoke vault/research/memo/x.bin', bytes);
        const listed = (await f.list('Smoke vault')).map((i) => i.path);
        const back = Array.from(await f.read('Smoke vault/research/memo/x.bin'));
        let escaped = 'refused';
        try { await f.write('../outside.bin', bytes); escaped = 'written'; } catch {}
        await f.remove('Smoke vault/research/memo/x.bin');
        const after = (await f.list('', { recursive: false })).map((i) => i.path);
        return { listed, back, escaped, after, root: await f.root() };
      })()`);
      assert(r.listed.join() === 'research/memo/x.bin', `listed ${r.listed}`);
      assert(r.back.join() === '1,2,3,250', `read ${r.back}`);
      assert(r.escaped === 'refused', 'a path outside the folder was written');
      assert(r.after.length === 0, `left behind: ${r.after}`);
      assert(r.root === folder.root, r.root);
      const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.origin === 'https://yaqatw.alefa.net');
      const inFrame = frame ? await frame.executeJavaScript('typeof window.alefaDesktop.folder') : 'no frame';
      assert(inFrame === 'undefined', `yaqatw sees folder: ${inFrame}`);
      return `round trip in ${r.root}; refused ../; yaqatw: none`;
    });

    await check('each site has its own encrypted databases (alefaDesktop.db)', async () => {
      assert(db, 'the database did not load (probe failed)');
      const r = await js(`(async () => {
        const d = window.alefaDesktop.db;
        const info = await d.info();
        const key = crypto.getRandomValues(new Uint8Array(32));
        let h = await d.open('smoke', key);
        await h.batch([
          { sql: 'create table notes (body text, data blob)' },
          { sql: 'insert into notes values (?, ?)', params: ['smoke-secret', new Uint8Array([7, 250])] },
        ]);
        const rows = await h.query('select body, data from notes');
        const refused = [];
        for (const sql of ["attach 'x.db' as o", "pragma rekey = 'x'", 'begin']) {
          try { await h.run(sql); refused.push('ran: ' + sql); } catch (e) { refused.push(window.alefaDesktop.db.codeOf(e)); }
        }
        await h.close();
        let afterClose = 'ran';
        try { await h.query('select 1'); } catch (e) { afterClose = window.alefaDesktop.db.codeOf(e); }
        let wrong = 'opened';
        try { await d.open('smoke', crypto.getRandomValues(new Uint8Array(32))); } catch (e) { wrong = window.alefaDesktop.db.codeOf(e); }
        h = await d.open('smoke', key);
        const again = (await h.query('select count(*) n from notes'))[0].n;
        const listed = (await d.list()).map((x) => x.name + ':' + x.open);
        return { info, body: rows[0].body, data: Array.from(rows[0].data), refused, afterClose, wrong, again, listed };
      })()`);
      assert(r.info.engine === 'sqlcipher', JSON.stringify(r.info));
      assert(r.body === 'smoke-secret' && r.data.join() === '7,250', JSON.stringify(r));
      assert(r.refused.join() === 'refused,refused,refused', r.refused.join());
      assert(r.afterClose === 'locked', `after close: ${r.afterClose}`);
      assert(r.wrong === 'wrong-key', `wrong key: ${r.wrong}`);
      assert(r.again === 1 && r.listed.join() === 'smoke:true', JSON.stringify(r));
      const fs = require('node:fs');
      const file = require('node:path').join(db.root, 'clew.alefa.net', 'smoke.db');
      assert(fs.existsSync(file), `no ${file}`);

      // The yaqatw frame: its own folder; Clew's open database is not its to use.
      const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.origin === 'https://yaqatw.alefa.net');
      assert(frame, 'no yaqatw frame');
      const y = await frame.executeJavaScript(`(async () => {
        const d = window.alefaDesktop.db;
        const before = (await d.list()).map((x) => x.name);
        let borrowed = 'ran';
        try { await window.alefaDesktop.db.open('smoke', new Uint8Array(32)).then((h) => h.query('select * from notes')); } catch (e) { borrowed = window.alefaDesktop.db.codeOf(e); }
        const h = await d.open('smoke', new Uint8Array(32));
        await h.close();
        await d.remove('smoke');
        return { before, borrowed, after: (await d.list()).map((x) => x.name) };
      })()`);
      assert(y.before.length === 0, `yaqatw sees ${y.before}`);
      assert(y.borrowed === 'sqlite', `yaqatw reading Clew's notes: ${y.borrowed}`);
      assert(y.after.length === 0, `left in yaqatw's folder: ${y.after}`);

      // Still open in Clew: not removable.
      const inUse = await js(`window.alefaDesktop.db.remove('smoke').then(() => 'removed', (e) => window.alefaDesktop.db.codeOf(e))`);
      assert(inUse === 'in-use', `remove while open: ${inUse}`);
      for (const f of [file, `${file}-wal`]) {
        if (fs.existsSync(f)) assert(!fs.readFileSync(f).includes('smoke-secret'), `the text is readable in ${f}`);
      }
      return `${r.info.engine} ${r.info.cipher}, SQLite ${r.info.sqlite}; refused attach/rekey/begin; wrong key caught; yaqatw kept apart`;
    });

    await check('the local API answers programs on loopback, refuses pages and unpaired calls', async () => {
      const st = api?.status();
      assert(st?.listening, `not listening: ${st?.error}`);
      const base = `http://127.0.0.1:${st.port}`;
      const hello = await programGet(`${base}/v1/hello`);
      assert(hello.status === 200 && JSON.parse(hello.body).app === 'clew-desktop', `hello: ${hello.status} ${hello.body}`);
      const me = await programGet(`${base}/v1/me`);
      assert(me.status === 401, `unpaired /v1/me: ${me.status}`);
      // Clew's page is a web page like any other here: refused, and nobody is asked anything.
      const page = await js(`fetch('${base}/v1/hello').then(r => 'status ' + r.status, () => 'blocked')`);
      assert(page === 'blocked', `page: ${page}`);
      const pair = await js(
        `fetch('${base}/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"page"}' }).then(r => 'status ' + r.status, () => 'blocked')`,
      );
      assert(pair === 'blocked', `page pairing: ${pair}`);
      return `port ${st.port}; hello, 401 unpaired; Clew's page refused`;
    });

    await check('external requests reach the network with Origin/Referer as a browser sends them', async () => {
      const before = stats.local;
      const r = await js(`fetch('${echo}/echo', { method: 'POST', body: 'hello', referrerPolicy: 'unsafe-url' }).then(r => r.json())`);
      assert(stats.local === before, 'went through the local server');
      assert(r.method === 'POST' && r.body === 'hello', `body ${JSON.stringify(r.body)}`);
      assert(r.headers.origin === 'https://clew.alefa.net', `origin ${r.headers.origin}`);
      assert(String(r.headers.referer || '').startsWith('https://clew.alefa.net/'), `referer ${r.headers.referer}`);
      return `origin ${r.headers.origin}, referer ${r.headers.referer}`;
    });

    await check('external redirects are followed by the page (fetch)', async () => {
      const r = await js(`fetch('${echo}/redirect').then(async r => ({ url: r.url, redirected: r.redirected, body: await r.json() }))`);
      assert(r.redirected && r.url.endsWith('/echo?from=redirect'), JSON.stringify(r));
      return r.url;
    });

    await check('external redirects are followed by the page (navigation)', async () => {
      const url = await finalUrl(ses, `${echo}/redirect`);
      assert(url.endsWith('/echo?from=redirect'), url);
      return url;
    });

    await check('http:// for a bundled host redirects to https://', async () => {
      const url = await finalUrl(ses, 'http://clew.alefa.net/about');
      assert(url === 'https://clew.alefa.net/about', url);
      return url;
    });

    await check('CORS is enforced on external responses, as in a browser', async () => {
      const r = await js(`fetch('${echo}/nocors').then(() => 'allowed', () => 'blocked')`);
      assert(r === 'blocked', r);
      return r;
    });

    await check('real external host over the network (googleapis, CORS)', async () => {
      const status = await js(
        "fetch('https://www.googleapis.com/discovery/v1/apis?name=drive&preferred=true').then(r => r.status)",
      );
      assert(status === 200, `status ${status}`);
      return `status ${status}`;
    });

    await check('microphone permission is granted to the bundled origin', async () => {
      const state = await js("navigator.permissions.query({ name: 'microphone' }).then(p => p.state)");
      assert(state === 'granted', state);
      return state;
    });

    await check('service worker registers and controls the page', async () => {
      let state = null;
      for (let i = 0; i < 20 && !state; i++) {
        state = await js(
          'navigator.serviceWorker.getRegistration().then(r => r && r.active ? r.active.state : null)',
        );
        if (!state) await wait(500);
      }
      assert(state, 'no active registration');
      await new Promise((resolve) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.reload();
      });
      const controlled = await js('Boolean(navigator.serviceWorker.controller)');
      assert(controlled, 'not controlling after reload');
      const origin = await js('location.origin');
      return `${state}, controlling ${origin}`;
    });

    if (tools) {
      await check('the audio server runs as a hidden child, driven over --control', async () => {
        for (let i = 0; i < 40 && tools.engine.state !== 'running'; i++) await wait(250);
        assert(tools.engine.state === 'running', `${tools.engine.state} ${tools.engine.problem}`);
        const st = await tools.engine.call('status');
        const where = st.server.running ? `on ${st.server.port}` : `stopped (${st.server.problem})`;
        return `version ${tools.engine.info.version}, server ${where}`;
      });

      await check('the tray icon is there', async () => {
        assert(tools.tray && !tools.tray.isDestroyed(), 'no tray');
        return tools.tooltip();
      });

      await check('the settings window renders the server state, without errors', async () => {
        tools.openSettings();
        const sw = tools.settingsWin;
        const errors = [];
        sw.webContents.on('console-message', (event, level, message) => {
          const lvl = event?.level ?? level;
          if (lvl === 'error' || lvl === 3) errors.push(String(event?.message ?? message));
        });
        await new Promise((r) => (sw.webContents.isLoading() ? sw.webContents.once('did-finish-load', r) : r()));
        let text = '';
        for (let i = 0; i < 20 && !text; i++) {
          text = await sw.webContents.executeJavaScript("document.getElementById('server-state').textContent");
          if (!text) await wait(250);
        }
        const tabs = await sw.webContents.executeJavaScript("document.querySelectorAll('[role=tab]').length");
        // Settings › General lists the app and each bundled site under Updates.
        const updateCells = await sw.webContents.executeJavaScript("document.getElementById('update-sites').children.length");
        const updateText = await sw.webContents.executeJavaScript("document.getElementById('update-sites').textContent");
        // The app itself first, then each bundled site: a label and a cell each.
        assert(updateCells === 6, `updates section: ${updateCells} cells`);
        assert(updateText.startsWith('Clew DesktopVersion '), `updates section: ${updateText.slice(0, 60)}`);
        assert(text, 'no server state shown');
        assert(errors.length === 0, errors.join(' | '));
        sw.destroy();
        return `"${text}", ${tabs} tabs`;
      });
    }

    await check('no uncaught errors in any page or frame during the run', async () => {
      await wait(1500);
      const uncaught = pageErrors.filter((m) => /Uncaught|Invalid hook call/i.test(m));
      assert(uncaught.length === 0, uncaught.map((m) => m.slice(0, 160)).join(' | '));
      return `${pageErrors.length} console error(s), none uncaught`;
    });
  } finally {
    echoSrv.close();
    if (folder) require('node:fs').rmSync(folder.root, { recursive: true, force: true });
    if (db) {
      await db.stop();
      require('node:fs').rmSync(db.root, { recursive: true, force: true });
    }
    if (api) {
      await api.close();
      require('node:fs').rmSync(require('node:path').dirname(api.clients.file), { recursive: true, force: true });
    }
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed; requests: ${JSON.stringify(stats)}`);
  app.exit(failed ? 1 : 0);
}

module.exports = { run };
