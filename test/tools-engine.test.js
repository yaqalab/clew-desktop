'use strict';
// The engine client against the real audio server built by `npm run build:tools`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolsEngine } = require('../src/tools/engine');

const EXE = path.join(__dirname, '..', 'tools-dist', process.platform === 'win32' ? 'clew-audio-server.exe' : 'clew-audio-server');
const skip = fs.existsSync(EXE) ? false : 'tools-dist not built (npm run build:tools)';

function once(emitter, event, pred = () => true, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
    const on = (...args) => {
      if (!pred(...args)) return;
      clearTimeout(timer);
      emitter.off(event, on);
      resolve(args);
    };
    emitter.on(event, on);
  });
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  fs.mkdirSync(path.join(dir, 'audio'));
  fs.writeFileSync(path.join(dir, 'audio', 'one.mp3'), Buffer.alloc(2048));
  return dir;
}

test('drives the audio server: settings, secret, Clew listing, status, stop', { skip }, async () => {
  const dir = fresh();
  const engine = new ToolsEngine({ exe: EXE, args: ['--config', path.join(dir, 'settings.json')] });
  const running = once(engine, 'state', (s) => s === 'running');
  engine.start();
  await running;
  assert.match(engine.info.version, /^\d+\.\d+\.\d+$/);

  const port = 42000 + Math.floor(Math.random() * 8000);
  const applied = await engine.call('settings.apply', {
    settings: { folders: [{ path: path.join(dir, 'audio'), enabled: true }], port },
  });
  assert.equal(applied.problem, '');
  const { secret } = await engine.call('secret.get');
  const res = await fetch(`http://127.0.0.1:${port}/api/files`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(res.status, 200);
  const listed = JSON.stringify(await res.json());
  assert.match(listed, /one\.mp3/);

  await assert.rejects(engine.call('nope'), /unknown command/);
  const st = await engine.call('status');
  assert.equal(st.server.running, true);
  assert.equal(st.server.port, port);

  await engine.stop();
  assert.equal(engine.state, 'stopped');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/ping`));
});

test('starts the server again when it dies unasked', { skip }, async () => {
  const dir = fresh();
  const engine = new ToolsEngine({ exe: EXE, args: ['--config', path.join(dir, 'settings.json')] });
  engine.start();
  await once(engine, 'state', (s) => s === 'running');
  const first = engine.child.pid;
  const again = once(engine, 'state', (s) => s === 'running', 20000);
  engine.child.kill('SIGKILL'); // a crash: the server catches SIGTERM on macOS and Linux
  await again;
  assert.notEqual(engine.child.pid, first);
  await engine.stop();
});

test('a missing program is reported, not thrown', () => {
  const engine = new ToolsEngine({ exe: path.join(os.tmpdir(), 'no-such-server.exe') });
  engine.start();
  assert.equal(engine.state, 'missing');
  return assert.rejects(engine.call('status'));
});
