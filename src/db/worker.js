'use strict';
/**
 * The database process (an Electron utility process): every open database lives here, so a
 * long query never holds up the windows, and a crash takes down only this process.
 * Messages from the main process: `{ id, op, args }`; answers: `{ id, ok, value }` or
 * `{ id, ok: false, code, message }`.
 */
const { Store } = require('./store');

const OPS = new Set(['info', 'list', 'open', 'query', 'run', 'batch', 'rekey', 'close', 'remove', 'closeAll']);
const store = new Store(process.argv[2]);

process.parentPort.on('message', ({ data }) => {
  const { id, op, args } = data;
  try {
    if (!OPS.has(op)) throw Object.assign(new Error(`unknown: ${op}`), { code: 'bad-args' });
    const value = store[op](...(args ?? []));
    process.parentPort.postMessage({ id, ok: true, value });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, code: err.code || 'sqlite', message: err.message });
  }
});
