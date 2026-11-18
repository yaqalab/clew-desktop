'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClients } = require('../src/local-api');
const { createWordPlugin, KIND, NAME } = require('../src/word-plugin');

const quiet = { log() {}, warn() {} };

/** A template, an empty Startup folder, clients and a registry, all in a temp folder. */
function fresh(t, { port = 47830 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-word-plugin-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const template = path.join(dir, 'app', 'yaqatw.dotm');
  fs.mkdirSync(path.dirname(template));
  fs.writeFileSync(template, 'template v1');
  const startupDir = path.join(dir, 'STARTUP');
  const clients = createClients(path.join(dir, 'clients.json'));
  const values = new Map();
  const registry = {
    set: async (name, value) => void values.set(name, value),
    unset: async (name) => void values.delete(name),
    removeAll: async () => values.clear(),
  };
  const state = { port };
  const plugin = createWordPlugin({
    template,
    startupDir,
    clients,
    registry,
    port: () => state.port,
    defaultPort: 47830,
    log: quiet,
  });
  return { dir, template, startupDir, clients, values, plugin, state, installed: path.join(startupDir, 'yaqatw.dotm') };
}

test('install: copied to Startup, connected, token in the registry, no Port for the default', async (t) => {
  const { plugin, clients, values, installed } = fresh(t);
  assert.deepEqual(plugin.status(), { available: true, installed: false, connected: false });
  assert.deepEqual(await plugin.install(), { available: true, installed: true, connected: true });
  assert.equal(fs.readFileSync(installed, 'utf8'), 'template v1');
  const token = values.get('Token');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(values.has('Port'), false);
  const me = clients.find(token);
  assert.equal(me.name, NAME);
  assert.equal(me.kind, KIND);
});

test('installing again replaces the client: one client, the old token stops working', async (t) => {
  const { plugin, clients, values } = fresh(t);
  await plugin.install();
  const first = values.get('Token');
  clients.add('Something else');
  await plugin.install();
  assert.notEqual(values.get('Token'), first);
  assert.equal(clients.find(first), null);
  assert.equal(clients.list().filter((c) => c.kind === KIND).length, 1);
  assert.equal(clients.list().length, 2, 'other clients are kept');
});

test('another port is written as Port, and removed again once back to the default', async (t) => {
  const { plugin, values, state } = fresh(t, { port: 51234 });
  await plugin.install();
  assert.equal(values.get('Port'), '51234');
  state.port = 47830;
  await plugin.refresh();
  assert.equal(values.has('Port'), false);
});

test('remove: file, registry and client gone; other clients kept', async (t) => {
  const { plugin, clients, values, installed } = fresh(t);
  await plugin.install();
  clients.add('Something else');
  assert.deepEqual(await plugin.remove(), { available: true, installed: false, connected: false });
  assert.equal(fs.existsSync(installed), false);
  assert.equal(values.size, 0);
  assert.deepEqual(
    clients.list().map((c) => c.name),
    ['Something else'],
  );
});

test('refresh: updates an older template, reconnects a lost client, leaves an uninstalled one alone', async (t) => {
  const { plugin, template, clients, values, installed } = fresh(t);
  assert.deepEqual(await plugin.refresh(), { available: true, installed: false, connected: false });
  assert.equal(values.size, 0);

  await plugin.install();
  fs.writeFileSync(template, 'template v2');
  clients.removeKind(KIND);
  const old = values.get('Token');
  assert.deepEqual(await plugin.refresh(), { available: true, installed: true, connected: true });
  assert.equal(fs.readFileSync(installed, 'utf8'), 'template v2');
  assert.notEqual(values.get('Token'), old);
  assert.equal(clients.find(values.get('Token')).kind, KIND);

  // Up to date and connected: the token stays.
  const kept = values.get('Token');
  await plugin.refresh();
  assert.equal(values.get('Token'), kept);
});

test('refresh: a template removed from outside (uninstalled) takes its connection with it', async (t) => {
  const { plugin, clients, installed } = fresh(t);
  await plugin.install();
  clients.add('Something else');
  fs.rmSync(installed);
  assert.deepEqual(await plugin.refresh(), { available: true, installed: false, connected: false });
  assert.deepEqual(
    clients.list().map((c) => c.name),
    ['Something else'],
  );
});

test('no template in this build: install says so, nothing is written', async (t) => {
  const { plugin, template, values, installed } = fresh(t);
  fs.rmSync(template);
  await assert.rejects(plugin.install(), { code: 'no-template' });
  assert.equal(fs.existsSync(installed), false);
  assert.equal(values.size, 0);
  assert.equal(plugin.status().available, false);
});

test('a template Word holds open: install reports word-busy, refresh carries on', async (t) => {
  const { plugin, template, startupDir, installed } = fresh(t);
  await plugin.install();
  fs.writeFileSync(template, 'template v2');
  // What Word's lock looks like to the copy.
  const copy = fs.copyFileSync;
  fs.copyFileSync = () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
  t.after(() => (fs.copyFileSync = copy));
  await assert.rejects(plugin.install(), { code: 'word-busy' });
  const s = await plugin.refresh();
  assert.equal(s.installed, true);
  fs.copyFileSync = copy;
  assert.equal(fs.readFileSync(installed, 'utf8'), 'template v1');
  assert.ok(fs.existsSync(startupDir));
});
