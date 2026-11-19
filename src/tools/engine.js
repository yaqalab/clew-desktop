'use strict';
/**
 * The audio server (Clew's tools: audio files, dictation, analysis) as a hidden child process,
 * driven over its `--control` pipe: one JSON object per line each way (tools/native's
 * core/control.h in the Clew repository).
 *
 * - `call(cmd, args)` sends one request and resolves with its result (rejects with its error).
 * - Events: 'hello', 'status' (the latest is in `.status`), 'log', 'state' (this side's own:
 *   starting, running, stopped, missing, failed).
 * - The server ends by itself when its stdin closes, so it never outlives the app. If it dies
 *   unasked it is started again, a few times, further apart each time.
 *
 * Plain Node: no Electron here, so the tests drive it too.
 */
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const readline = require('node:readline');

const RESTART_DELAYS = [1000, 5000, 30000];

class ToolsEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.exe          clew-audio-server(.exe)
   * @param {string[]} [opts.args]     extra arguments (--config, --stt-program, --analysis-program)
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ exe, args = [], log = () => {} }) {
    super();
    this.exe = exe;
    this.args = args;
    this.logLine = log;
    this.child = null;
    this.state = 'stopped';
    this.status = null;
    this.info = null;
    this.problem = '';
    this.pending = new Map();
    this.nextId = 0;
    this.stopping = false;
    this.restarts = 0;
    this.restartTimer = null;
  }

  setState(state, problem = '') {
    this.state = state;
    this.problem = problem;
    this.emit('state', state, problem);
  }

  start() {
    if (this.child) return;
    this.stopping = false;
    if (!this.exe || !fs.existsSync(this.exe)) {
      this.setState('missing', `not installed: ${this.exe || 'no path'}`);
      return;
    }
    this.setState('starting');
    const child = spawn(this.exe, ['--control', ...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => this.logLine(line));
    child.on('error', (err) => {
      this.logLine(`could not start ${this.exe}: ${err.message}`);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logLine(line);
      return;
    }
    if (msg.event) {
      if (msg.event === 'hello') {
        this.info = msg;
        this.restarts = 0;
        this.setState('running');
      } else if (msg.event === 'status') {
        this.status = msg.status;
      } else if (msg.event === 'log') {
        this.logLine(msg.line);
      }
      this.emit(msg.event, msg.event === 'status' ? msg.status : msg);
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || 'failed'));
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(new Error('the audio server stopped'));
    }
    this.pending.clear();
    if (this.stopping) {
      this.setState('stopped');
      return;
    }
    const why = signal ? `ended by ${signal}` : `exited with code ${code}`;
    this.logLine(`the audio server ${why}`);
    if (this.restarts >= RESTART_DELAYS.length) {
      this.setState('failed', why);
      return;
    }
    const delay = RESTART_DELAYS[this.restarts++];
    this.setState('starting', `${why}; starting again`);
    this.restartTimer = setTimeout(() => this.start(), delay);
  }

  /** One request. Rejects when the server answers with an error, stops, or takes too long. */
  call(cmd, args = {}, timeoutMs = 20000) {
    if (!this.child || this.state !== 'running') {
      return Promise.reject(new Error(this.problem || 'the audio server is not running'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd}: no answer`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
    });
  }

  /**
   * Ends the server: "quit", then the end of its stdin; killed if it does not go within 5 s.
   * SIGKILL: on macOS and Linux the server catches SIGTERM, and in --control mode it then goes on
   * reading its stdin. (On Windows every kill ends the process at once.)
   */
  stop() {
    clearTimeout(this.restartTimer);
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
        child.stdin.end();
      } catch {
        child.kill('SIGKILL');
      }
    });
  }
}

module.exports = { ToolsEngine };
