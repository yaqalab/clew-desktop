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

/** A POST with a JSON body as a program sends it. */
function programPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** What a fake Word answers to an operation: an empty document. */
function fakeWord(op) {
  const a = op.args || {};
  switch (op.op) {
    case 'readXmlPart':
    case 'ensureXmlPart':
      return `<${a.root} xmlns="${a.ns}"></${a.root}>`;
    case 'getAllText':
      return '';
    case 'getParagraphs':
      return [];
    case 'isEmpty':
      return true;
    case 'getDocumentTitle':
      return 'Smoke';
    default:
      return null;
  }
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
  // Yaqatw for Word is Windows only: elsewhere nothing opens a Word window, so its check is skipped.
  const windowsOnly = (name, fn) => {
    if (process.platform === 'win32') return check(name, fn);
    console.log(`SKIP  ${name}  — Windows only`);
    return Promise.resolve();
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

    await check('the folder moves: files arrive, Clew sees the new place, writes during the move wait', async () => {
      const fsx = require('node:fs');
      const before = folder.root;
      await js(`window.alefaDesktop.folder.write('Moving/a.bin', new Uint8Array([7, 8, 9]))`);
      const target = `${before}-moved`;
      // A write sent while the move runs lands in the new place.
      const moving = folder.moveTo(target);
      const during = js(`window.alefaDesktop.folder.write('Moving/b.bin', new Uint8Array([1]))`);
      const result = await moving;
      await during;
      const seen = await js(`(async () => ({ root: await window.alefaDesktop.folder.root(),
        files: (await window.alefaDesktop.folder.list('Moving')).map((i) => i.path).sort().join() }))()`);
      assert(seen.root === target, `root ${seen.root}`);
      assert(seen.files === 'a.bin,b.bin', `files ${seen.files}`);
      assert(!fsx.existsSync(before), 'the old folder is still there');
      assert(result.files === 1, `moved ${result.files}`);
      // Back where the rest of the run expects it.
      await folder.moveTo(before);
      await js(`window.alefaDesktop.folder.remove('Moving/a.bin').then(() => window.alefaDesktop.folder.remove('Moving/b.bin'))`);
      return `${before} → ${target} and back`;
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

    await windowsOnly('a Word window: host page, yaqatw in its frame, its calls reach Word (a fake one)', async () => {
      const base = `http://127.0.0.1:${api.status().port}`;
      const auth = { authorization: `Bearer ${api.clients.add('Smoke Word', { kind: 'word-template' }).token}` };
      const opened = await programPost(`${base}/v1/word/open`, { title: 'Smoke.docx', path: 'C:\\Smoke.docx' }, auth);
      assert(opened.status === 200 && opened.body.session, `open: ${opened.status} ${JSON.stringify(opened.body)}`);
      const session = opened.body.session;
      const ops = [];
      let closed = false;
      const pump = (async () => {
        let result;
        while (!closed) {
          const r = await programPost(`${base}/v1/word/next`, { session, waitMs: 300, result }, auth);
          result = undefined;
          if (r.body?.closed) closed = true;
          else if (r.body?.op) {
            ops.push(r.body.op.op);
            result = { id: r.body.op.id, ok: true, value: fakeWord(r.body.op) };
          }
        }
      })();
      let wordWin = null;
      for (let i = 0; i < 40 && !wordWin; i++) {
        wordWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('clew-word://bridge/'));
        if (!wordWin) await wait(250);
      }
      assert(wordWin, 'no Word window');
      for (let i = 0; i < 80 && !ops.includes('readXmlPart'); i++) await wait(250);
      const frame = wordWin.webContents.mainFrame.framesInSubtree.find((f) => f.origin === 'https://yaqatw.alefa.net');
      const status = await wordWin.webContents.executeJavaScript("document.getElementById('status').textContent");

      // A ribbon action: yaqatw's codes (the fake document has none), then the code picker.
      const codes = await programPost(`${base}/v1/word/action`, { session, action: 'codes' }, auth);
      const picker = await programPost(`${base}/v1/word/action`, { session, action: 'openPicker', args: { mode: 'find' } }, auth);
      let pickerWin = null;
      for (let i = 0; i < 40 && !pickerWin; i++) {
        pickerWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('clew-word://bridge/picker.html'));
        if (!pickerWin) await wait(250);
      }
      const pickerErrors = [];
      pickerWin?.webContents.on('console-message', (event) => {
        if (event.level === 'error') pickerErrors.push(event.message);
      });
      let list = '';
      for (let i = 0; i < 40 && pickerWin && !/New code/.test(list); i++) {
        await wait(250);
        list = await pickerWin.webContents.executeJavaScript("document.getElementById('list').textContent");
      }
      pickerWin?.destroy();

      // The insert window (Writing group): it loads, searches where it was asked, and says why
      // there is nothing (the fake document has no type).
      const insert = await programPost(`${base}/v1/word/action`, { session, action: 'openPicker', args: { mode: 'insert', source: 'highlights' } }, auth);
      let insertWin = null;
      for (let i = 0; i < 40 && !insertWin; i++) {
        insertWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('clew-word://bridge/insert.html'));
        if (!insertWin) await wait(250);
      }
      const insertErrors = [];
      insertWin?.webContents.on('console-message', (event) => {
        if (event.level === 'error') insertErrors.push(event.message);
      });
      let insertState = { msg: '' };
      for (let i = 0; i < 40 && insertWin && (!insertState.msg || insertState.msg === 'Loading…'); i++) {
        await wait(250);
        insertState = await insertWin.webContents.executeJavaScript(
          "({ msg: document.getElementById('msg').textContent, source: document.getElementById('source').value })",
        );
      }
      insertWin?.destroy();

      // Highlight info (ribbon, right-click): its window loads, asks yaqatw for the passage and
      // says why there is nothing (the fake document has no type); a bad id is refused first.
      const badInfo = await programPost(`${base}/v1/word/action`, { session, action: 'openPicker', args: { mode: 'info', hid: '../x' } }, auth);
      const info = await programPost(`${base}/v1/word/action`, { session, action: 'openPicker', args: { mode: 'info', hid: 'h-smoke' } }, auth);
      let infoWin = null;
      for (let i = 0; i < 40 && !infoWin; i++) {
        infoWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('clew-word://bridge/info.html'));
        if (!infoWin) await wait(250);
      }
      const infoErrors = [];
      infoWin?.webContents.on('console-message', (event) => {
        if (event.level === 'error') infoErrors.push(event.message);
      });
      let infoMsg = '';
      for (let i = 0; i < 40 && infoWin && (!infoMsg || infoMsg === 'Loading…'); i++) {
        await wait(250);
        infoMsg = await infoWin.webContents.executeJavaScript("document.getElementById('msg').textContent");
      }
      const infoUrl = infoWin?.webContents.getURL() ?? '';
      infoWin?.destroy();

      // An AI request yaqatw is about to send (its AI gate): the review window shows it in front;
      // Send answers true, Cancel false.
      const askReview = () =>
        wordWin.webContents.executeJavaScript(
          "window.clewWord.review({ feature: 'Translate', provider: 'openai', model: 'gpt', host: 'api.openai.com', kind: 'json', texts: ['I wrote to them one by one.'] })",
        );
      const findReview = async () => {
        for (let i = 0; i < 40; i++) {
          const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('clew-word://bridge/review.html'));
          if (w) {
            for (let j = 0; j < 40; j++) {
              const text = await w.webContents.executeJavaScript("document.getElementById('texts').textContent").catch(() => '');
              if (text) return { w, text };
              await wait(150);
            }
          }
          await wait(250);
        }
        return { w: null, text: '' };
      };
      const sending = askReview();
      const firstReview = await findReview();
      await firstReview.w?.webContents.executeJavaScript("document.getElementById('send').click()");
      const reviewSent = await sending;
      const cancelling = askReview();
      const secondReview = await findReview();
      await secondReview.w?.webContents.executeJavaScript("document.getElementById('cancel').click()");
      const reviewCancelled = await cancelling;

      // Add to relationship › More… (the window): it loads and says why there is nothing.
      const relate = await programPost(`${base}/v1/word/action`, { session, action: 'openPicker', args: { mode: 'relate', hid: 'h-smoke' } }, auth);
      let relateWin = null;
      for (let i = 0; i < 40 && !relateWin; i++) {
        relateWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('clew-word://bridge/relate.html?hid=h-smoke'));
        if (!relateWin) await wait(250);
      }
      const relateErrors = [];
      relateWin?.webContents.on('console-message', (event) => {
        if (event.level === 'error') relateErrors.push(event.message);
      });
      let relateMsg = '';
      for (let i = 0; i < 40 && relateWin && (!relateMsg || relateMsg === 'Loading…'); i++) {
        await wait(250);
        relateMsg = await relateWin.webContents.executeJavaScript("document.getElementById('msg').textContent");
      }
      relateWin?.destroy();

      // New category and New relationship (right-click › Add to category / Add to relationship):
      // the form window, titled for its kind, for a code.
      const forms = {};
      for (const kind of ['category', 'relationship']) {
        const opened = await programPost(`${base}/v1/word/action`, { session, action: 'openPicker', args: { mode: kind, code: 'c-smoke' } }, auth);
        let formWin = null;
        for (let i = 0; i < 40 && !formWin; i++) {
          formWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(`form.html?kind=${kind}&code=c-smoke`));
          if (!formWin) await wait(250);
        }
        const errors = [];
        formWin?.webContents.on('console-message', (event) => {
          if (event.level === 'error') errors.push(event.message);
        });
        let state = null;
        for (let i = 0; i < 40 && formWin && !state?.heading; i++) {
          await wait(250);
          state = await formWin.webContents.executeJavaScript(
            "({ heading: document.getElementById('heading').textContent, button: document.getElementById('create').textContent, focused: document.activeElement.id })",
          );
        }
        formWin?.destroy();
        forms[kind] = { ok: opened.body?.ok === true, found: Boolean(formWin), state, errors };
      }

      wordWin.destroy();
      for (let i = 0; i < 20 && !closed; i++) await wait(250);
      closed = true;
      await pump.catch(() => {});
      assert(frame, 'no yaqatw frame in the Word window');
      assert(ops.includes('readXmlPart'), `yaqatw did not read its parts; ops: ${ops.join(', ') || 'none'}`);
      assert(codes.body?.ok === true && Array.isArray(codes.body.value?.codes), `codes action: ${JSON.stringify(codes.body)}`);
      assert(picker.body?.ok === true, `openPicker: ${JSON.stringify(picker.body)}`);
      assert(pickerWin, 'no code picker window');
      assert(/New code/.test(list), `picker list: "${list}"`);
      assert(pickerErrors.length === 0, `picker errors: ${pickerErrors.join(' | ')}`);
      assert(insert.body?.ok === true, `openPicker insert: ${JSON.stringify(insert.body)}`);
      assert(insertWin, 'no insert window');
      assert(insertState.source === 'highlights', `insert window searches ${insertState.source}`);
      assert(/type first|writing|Nothing/.test(insertState.msg), `insert window says "${insertState.msg}"`);
      assert(insertErrors.length === 0, `insert window errors: ${insertErrors.join(' | ')}`);
      assert(badInfo.body?.ok === false, `openPicker info with a bad id: ${JSON.stringify(badInfo.body)}`);
      assert(info.body?.ok === true, `openPicker info: ${JSON.stringify(info.body)}`);
      assert(infoWin, 'no Highlight info window');
      assert(infoUrl.endsWith('info.html?hid=h-smoke'), `Highlight info window at ${infoUrl}`);
      assert(/type first|writing|no record/.test(infoMsg), `Highlight info window says "${infoMsg}"`);
      assert(infoErrors.length === 0, `Highlight info window errors: ${infoErrors.join(' | ')}`);
      assert(firstReview.w, 'no review window for an AI request');
      assert(/one by one/.test(firstReview.text), `review window shows "${firstReview.text}"`);
      assert(reviewSent === true, `Send answered ${reviewSent}`);
      assert(secondReview.w && reviewCancelled === false, `Cancel answered ${reviewCancelled}`);
      assert(relate.body?.ok === true && relateWin, `openPicker relate: ${JSON.stringify(relate.body)}`);
      assert(/type first|writing|no record/.test(relateMsg), `Add to relationship window says "${relateMsg}"`);
      assert(relateErrors.length === 0, `Add to relationship window errors: ${relateErrors.join(' | ')}`);
      for (const [kind, heading] of [
        ['category', 'New category'],
        ['relationship', 'New relationship'],
      ]) {
        const f = forms[kind];
        assert(f.ok && f.found, `openPicker ${kind}: ${JSON.stringify(f)}`);
        assert(f.state?.heading === heading && f.state.focused === 'name', `${heading} window: ${JSON.stringify(f.state)}`);
        assert(f.errors.length === 0, `${heading} window errors: ${f.errors.join(' | ')}`);
      }
      return `ops from yaqatw: ${[...new Set(ops)].join(', ')}; codes action ok (${codes.body.value.codes.length}); picker "${list}"; insert window "${insertState.msg}"; info window "${infoMsg}"${status ? `; status "${status}"` : ''}`;
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
        // The programs connected to Clew: in a smoke run, the fake Word of the Word window check.
        const clients = await sw.webContents.executeJavaScript("document.getElementById('clients').textContent");
        assert(clients.length > 0, 'no list of connected programs');
        // Developer tools: always on in a development run, so the switch is ticked and locked; in
        // the packaged app (a smoke run of a built package) off by default, and free to change.
        const want = app.isPackaged ? 'c.checked === false && c.disabled === false' : 'c.checked && c.disabled';
        const devtools = await sw.webContents.executeJavaScript(
          `window.tools.appPrefs().then((p) => { const c = document.getElementById('devtools'); return ${want} ? '' : \`checked \${c.checked}, disabled \${c.disabled}, prefs \${JSON.stringify(p)}\`; })`,
        );
        assert(!devtools, `the developer tools switch is not as expected (packaged: ${app.isPackaged}): ${devtools}`);
        // Clew's folder: shown, and not movable in a smoke run (a throwaway folder).
        const folderRow = await sw.webContents.executeJavaScript(
          "window.tools.folder().then(() => [document.getElementById('folder-root').textContent, document.getElementById('folder-move').disabled])",
        );
        assert(folderRow[0] === folder.root && folderRow[1] === true, `folder row: ${folderRow}`);
        // Remove all Clew data: the dialog lists what goes and what stays; it cannot run here.
        const wipeShown = await sw.webContents.executeJavaScript(`(async () => {
          document.getElementById('wipe-open').click();
          for (let i = 0; i < 40 && !document.getElementById('wipe-dialog').open; i++) await new Promise((r) => setTimeout(r, 100));
          const r = { open: document.getElementById('wipe-dialog').open,
            items: document.querySelectorAll('#wipe-items li').length,
            kept: document.querySelectorAll('#wipe-kept span').length,
            go: document.getElementById('wipe-go').disabled };
          document.getElementById('wipe-cancel').click();
          r.afterCancel = document.getElementById('wipe-dialog').open;
          document.getElementById('wipe-dialog').close();
          return r;
        })()`);
        assert(
          wipeShown.open && wipeShown.items === 2 && wipeShown.kept >= 2 && wipeShown.go && !wipeShown.afterCancel,
          `wipe dialog: ${JSON.stringify(wipeShown)}`,
        );
        // The analysis key: masked, shown on Show (to select and copy), masked again on Hide.
        const keyShown = await sw.webContents.executeJavaScript(`(async () => {
          const value = () => document.getElementById('ana-key').textContent;
          const masked = value();
          document.getElementById('ana-key-show').click();
          for (let i = 0; i < 40 && value() === masked; i++) await new Promise((r) => setTimeout(r, 100));
          const shown = value();
          document.getElementById('ana-key-show').click();
          return { masked, shown, hidden: value() };
        })()`);
        assert(
          /^•+$/.test(keyShown.masked) && keyShown.shown.length >= 16 && !/•/.test(keyShown.shown) && keyShown.hidden === keyShown.masked,
          `analysis key: ${JSON.stringify({ ...keyShown, shown: keyShown.shown.length })}`,
        );
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
