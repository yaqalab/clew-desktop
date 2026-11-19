#!/usr/bin/env node
//   npm run smoke:dictation [-- <dist folder> | --release <folder>] [--wav <file> --expect <word>]
//
// Checks a built dictation server (tools/stt-server's build output, `dist/clew-stt-server/`) on
// this computer, the way the audio server uses it: download the tiny model and the speaker model, serve on
// 127.0.0.1 with a key read from stdin, transcribe a file over HTTP, then a recording over the
// `/v1/transcribe` WebSocket with voices (sherpa-onnx). Downloads about 80 MB.
//
// Without --wav it sends a generated tone: that checks every library loads and answers, not that
// the words come out right. With --wav and --expect, the transcript must contain that word.
//
// `--release <folder>` (package:dictation's release-dictation/) installs the package for this
// computer first, the way the app does (src/tools/dictation-install.js, from a local stand-in
// for the clew-tools release), and checks the program it unpacked.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fail, loadSites } from './lib.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const wavFile = option('--wav');
const expect = option('--expect');
const release = option('--release');

function defaultDist() {
  const [clew] = loadSites(['clew']);
  return join(process.env.TOOLS_PATH || join(clew.dir, 'tools'), 'stt-server', 'dist', 'clew-stt-server');
}

const models = mkdtempSync(join(tmpdir(), 'clew-stt-smoke-'));
const installDir = release ? mkdtempSync(join(tmpdir(), 'clew-stt-install-')) : null;
const log = (line) => console.log(`[dictation smoke] ${line}`);

/** Installs from `folder` as the app would from the clew-tools release; the program's path. */
async function installFrom(folder) {
  const dictation = createRequire(import.meta.url)('../src/tools/dictation-install.js');
  const manifest = JSON.parse(readFileSync(join(folder, 'dictation.json'), 'utf8'));
  const http = createHttpServer((req, res) => {
    const file = req.url === '/latest/download/dictation.json' ? 'dictation.json'
      : req.url.startsWith(`/download/v${manifest.version}/`) ? basename(req.url) : null;
    if (!file || !existsSync(join(folder, file))) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(readFileSync(join(folder, file)));
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${http.address().port}`;
    const done = await dictation.install(installDir, { base });
    log(`installed ${done.version} (${dictation.platformKey()}) into ${installDir}`);
    return done.program;
  } finally {
    http.close();
  }
}

const program = release ? await installFrom(release)
  : join(args[0] || defaultDist(), process.platform === 'win32' ? 'clew-stt-server.exe' : 'clew-stt-server');
if (!existsSync(program)) fail(`no built dictation server at ${program}`);

/** Runs the program to the end; its output lines, or a failure with the last of them. */
function run(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${basename(program)} ${argv[0]} exited with ${code}:\n${out.slice(-2000)}`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** One second of a 440 Hz tone, 16 kHz mono 16-bit WAV. */
function tone() {
  const rate = 16000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

/** Sends the recording over /v1/transcribe; the messages, up to `Done`. */
function transcribeLive(port, key, audio) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/transcribe?source=upload&language=en`, ['alefa-stt', key]);
    const messages = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error(`no Done in time: ${JSON.stringify(messages)}`)); }, 180_000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'Start', voices: [] }));
      ws.send(audio);
      ws.send(JSON.stringify({ type: 'EndOfFile' }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      messages.push(m);
      if (m.type === 'Error') { clearTimeout(timer); ws.close(); reject(new Error(m.description)); }
      if (m.type === 'Done') { clearTimeout(timer); ws.close(); resolve(messages); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('the WebSocket failed')); };
    ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005) { clearTimeout(timer); reject(new Error(`closed ${e.code} ${e.reason}`)); } };
  });
}

let server;
try {
  log(`program: ${program}`);
  for (const model of ['tiny', 'speakers']) {
    const out = await run(['download', model, '--models-dir', models], 600_000);
    if (!/^done /m.test(out)) throw new Error(`download ${model} did not finish:\n${out.slice(-1000)}`);
    log(`downloaded ${model}`);
  }

  const port = await freePort();
  const key = `stt.smoke.${randomUUID()}`;
  server = spawn(program, ['serve', '--local', '--engine', 'whisper', '--model', 'tiny', '--device', 'cpu',
    '--models-dir', models, '--port', String(port), '--key-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.stdin.end(`${key}\n`);
  const exited = new Promise((resolve) => server.on('exit', resolve));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))]);
    if (gone) throw new Error(`the server stopped:\n${serverLog.slice(-3000)}`);
    const ping = await fetch(`${base}/api/ping`).then((r) => r.json()).catch(() => null);
    if (ping?.ready) break;
    if (Date.now() > deadline) throw new Error(`the server did not get ready:\n${serverLog.slice(-3000)}`);
  }
  const auth = { authorization: `Bearer ${key}` };
  const me = await fetch(`${base}/api/me`, { headers: auth }).then((r) => r.json());
  log(`ready: ${me.model} on ${me.device}, ${me.languages?.length} languages, speakers ${me.speakers}`);
  if (me.model !== 'whisper-tiny' || !me.speakers) throw new Error('unexpected /api/me');

  const audio = wavFile ? readFileSync(wavFile) : tone();
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'smoke.wav');
  form.append('language', 'en');
  const res = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`/v1/audio/transcriptions answered ${res.status}: ${body}`);
  const { text } = JSON.parse(body);
  log(`file: ${JSON.stringify(text)}`);
  if (expect && !text.toLowerCase().includes(expect.toLowerCase())) throw new Error(`"${expect}" is not in the transcript`);

  const messages = await transcribeLive(port, key, audio);
  const turns = messages.filter((m) => m.type === 'Turn');
  log(`live: ${turns.length} turn(s): ${JSON.stringify(turns.map((t) => [t.text, t.voice]))}`);
  if (wavFile) {
    if (!turns.length) throw new Error('no turn from the recording');
    if (!turns.some((t) => t.voice)) throw new Error('no voice on any turn (speakers did not run)');
    if (expect && !turns.some((t) => t.text.toLowerCase().includes(expect.toLowerCase()))) {
      throw new Error(`"${expect}" is not in the live transcript`);
    }
  }
  log('✔ the dictation server works');
} catch (err) {
  console.error(`[dictation smoke] ✖ ${err.message}`);
  process.exitCode = 1;
} finally {
  server?.kill();
  for (const dir of [models, installDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
