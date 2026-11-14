'use strict';
/* The settings window of Clew's local tools. Everything goes through window.tools (preload.js),
   which drives the audio server's --control pipe; this page keeps no state of its own beyond what
   the server last said. */

const $ = (id) => document.getElementById(id);
let settings = null; // settings.get
let snap = null; // tools:snapshot (state, problem, status, dictationProgram, installing…)
let models = null; // dictation.models
let secretShown = false;

const BACKENDS = [
  { id: 'r', name: 'R', key: 'analysisRscript', pick: 'Choose Rscript' },
  { id: 'python', name: 'Python (Conda)', key: 'analysisPython', pick: 'Choose a Python with pandas, scipy and statsmodels' },
  { id: 'pspp', name: 'PSPP', key: 'analysisPspp', pick: 'Choose pspp' },
  { id: 'spss', name: 'SPSS Statistics', key: 'analysisSpss', pick: "Choose SPSS Statistics' folder or its Python" },
];

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2500);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function setState(node, text, kind) {
  node.textContent = text;
  node.className = `state ${kind}`;
}

const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

// ---------------------------------------------------------------------------------------------
// Settings in and out

async function apply(patch) {
  const r = await run(() => window.tools.call('settings.apply', { settings: patch }));
  if (!r) return;
  settings = r.settings;
  if (r.problem) toast(r.problem);
  renderSettings();
}

async function load() {
  snap = await window.tools.snapshot();
  if (snap.state === 'running') {
    settings = await run(() => window.tools.call('settings.get'));
    models = await run(() => window.tools.call('dictation.models'));
  }
  $('login').checked = await window.tools.loginItem();
  renderAll();
  const lines = await window.tools.log();
  $('log').textContent = lines.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

// ---------------------------------------------------------------------------------------------
// Rendering

function renderAll() {
  const banner = $('engine-problem');
  if (snap.state !== 'running') {
    banner.hidden = false;
    banner.textContent =
      snap.state === 'missing'
        ? 'The audio server is not installed with this copy of Clew. Reinstall Clew.'
        : `The audio server is ${snap.state}${snap.problem ? `: ${snap.problem}` : ''}.`;
  } else banner.hidden = true;
  for (const b of document.querySelectorAll('main button, main input, main select')) {
    if (b.id !== 'open-app' && b.id !== 'login') b.disabled = snap.state !== 'running';
  }
  renderSettings();
  renderStatus();
  $('about').textContent = `Clew tools ${snap.version || ''}${snap.settingsFile ? ` · settings: ${snap.settingsFile}` : ''}`;
}

function renderSettings() {
  if (!settings) return;
  // Folders
  const ul = $('folders');
  ul.replaceChildren();
  if (!settings.folders.length) ul.append(el('li', { class: 'empty' }, 'No folder yet. Add the folder of your recordings.'));
  settings.folders.forEach((f, i) => {
    const box = el('input', {
      type: 'checkbox',
      checked: f.enabled,
      title: 'Served when ticked',
      on: {
        change: () => apply({ folders: settings.folders.map((g, j) => (j === i ? { ...g, enabled: !g.enabled } : g)) }),
      },
    });
    ul.append(
      el(
        'li',
        {},
        box,
        el('span', { class: 'grow', title: f.path }, f.path),
        el('button', { on: { click: () => window.tools.openPath(f.path) } }, 'Open'),
        el('button', { on: { click: () => apply({ folders: settings.folders.filter((_, j) => j !== i) }) } }, 'Remove'),
      ),
    );
  });
  // Origins
  const ol = $('origins');
  ol.replaceChildren();
  if (!settings.origins.length) ol.append(el('li', { class: 'empty' }, 'None'));
  settings.origins.forEach((o, i) =>
    ol.append(
      el(
        'li',
        {},
        el('span', { class: 'grow' }, o),
        el('button', { on: { click: () => apply({ origins: settings.origins.filter((_, j) => j !== i) }) } }, 'Remove'),
      ),
    ),
  );
  for (const id of ['port', 'linkHours', 'cacheMb', 'sttPort', 'analysisPort', 'analysisTimeout']) {
    if (document.activeElement !== $(id)) $(id).value = settings[id];
  }
  for (const id of ['convert', 'prepare', 'systemCodecs', 'sttEnabled', 'analysisEnabled']) $(id).checked = settings[id];
  $('ffmpeg').textContent = settings.ffmpeg || 'none';
  $('analysisScripts').textContent = settings.analysisScripts || 'none';
  $('sttLanguage').value = settings.sttLanguage;
  renderModels();
  renderBackends();
}

function renderStatus() {
  const s = snap.status;
  if (!s) return;
  // Audio server
  if (s.server.running) setState($('server-state'), `Running on port ${s.server.port}`, 'ok');
  else setState($('server-state'), `Stopped${s.server.problem ? `: ${s.server.problem}` : ''}`, s.server.problem ? 'warn' : 'off');
  $('server-toggle').textContent = s.server.running ? 'Stop' : 'Start';
  $('address').textContent = `http://127.0.0.1:${s.server.port}`;
  $('converting').textContent = s.server.converting ? `Converting ${s.server.converting}…` : '';

  // Dictation
  const installed = Boolean(snap.dictationProgram) || (s.dictation.state !== 'missing' && s.dictation.state !== 'off');
  $('dict-installing').hidden = !snap.installing;
  $('dict-missing').hidden = installed || Boolean(snap.installing);
  $('dict-ready').hidden = !installed || Boolean(snap.installing);
  if (snap.installing) {
    const p = snap.installing;
    $('dict-install-text').textContent =
      p.phase === 'downloading'
        ? `Downloading the speech server… ${mb(p.received)} of ${mb(p.size)}`
        : p.phase === 'unpacking'
          ? 'Unpacking…'
          : 'Looking for the latest version…';
    if (p.size) $('dict-install-bar').value = p.received / p.size;
    else $('dict-install-bar').removeAttribute('value');
  }
  const d = s.dictation;
  const dictText = {
    off: ['Off', 'off'],
    missing: ['Not installed', 'warn'],
    'no-model': ['Waiting for its model: download it below', 'warn'],
    loading: [`Loading ${d.model}…`, 'warn'],
    ready: [`Ready on port ${settings?.sttPort ?? ''} (${d.model})`, 'ok'],
    failed: [`Stopped: ${d.problem}`, 'bad'],
  }[d.state] || [d.state, 'off'];
  setState($('dict-state'), dictText[0], dictText[1]);
  $('dict-toggle').textContent = d.wanted ? 'Stop' : 'Start';
  renderModels();

  // Analysis
  const a = s.analysis;
  const anaText = {
    off: ['Off', 'off'],
    missing: ['The engine is missing from this copy of Clew', 'bad'],
    starting: ['Starting…', 'warn'],
    ready: [`Ready on port ${settings?.analysisPort ?? ''}`, 'ok'],
    failed: [`Stopped: ${a.problem}`, 'bad'],
  }[a.state] || [a.state, 'off'];
  setState($('ana-state'), anaText[0], anaText[1]);
  $('ana-toggle').textContent = a.wanted ? 'Stop' : 'Start';
  renderBackends();
}

function renderModels() {
  const t = $('models');
  if (!models || !settings) return;
  const d = snap.status?.dictation;
  t.replaceChildren(
    el('tr', {}, el('th', {}, ''), el('th', {}, 'Model'), el('th', {}, 'Size'), el('th', {}, 'Good for'), el('th', {}, '')),
  );
  const use = { live: 'dictation, on the CPU', files: 'recordings (seconds a sentence)', gpu: 'an NVIDIA GPU only' };
  for (const m of models.models) {
    const downloading = d?.downloading === m.name;
    let action;
    if (m.present) action = '✓ downloaded';
    else if (downloading) action = `${d.percent} %`;
    else
      action = el(
        'button',
        { on: { click: () => run(() => window.tools.call('dictation.download', { model: m.name })) } },
        'Download',
      );
    const note =
      m.blocker === 'memory' ? ` · needs ${m.memoryGb} GB of memory` : m.blocker === 'gpu' ? ' · needs an NVIDIA GPU' : '';
    t.append(
      el(
        'tr',
        {},
        el(
          'td',
          {},
          el('input', {
            type: 'radio',
            name: 'model',
            checked: settings.sttModel === m.name,
            on: { change: () => apply({ sttModel: m.name }) },
          }),
        ),
        el('td', {}, m.name + (m.englishOnly ? ' (English only)' : '')),
        el('td', {}, mb(m.bytes)),
        el('td', {}, use[m.use] + note),
        el('td', {}, action),
      ),
    );
  }
  $('dict-models-note').textContent =
    `small suits most computers. Models are kept in ${models.modelsDir}.` +
    (d?.downloadProblem ? ` Last download failed: ${d.downloadProblem}` : '');
}

function renderBackends() {
  const t = $('backends');
  if (!settings) return;
  const programs = snap.status?.analysis.programs || {};
  t.replaceChildren(el('tr', {}, el('th', {}, ''), el('th', {}, 'Program'), el('th', {}, 'On this computer'), el('th', {}, '')));
  for (const b of BACKENDS) {
    const p = programs[b.id] || { look: 'unknown' };
    const found =
      p.look === 'found'
        ? `${p.version !== 'found' ? `${p.version} ` : ''}at ${p.path}`
        : p.look === 'not-found'
          ? `not found${p.why ? ` (${p.why})` : ''}`
          : p.look === 'looking'
            ? 'looking…'
            : '—';
    t.append(
      el(
        'tr',
        {},
        el(
          'td',
          {},
          el('input', {
            type: 'radio',
            name: 'backend',
            checked: settings.analysisBackend === b.id,
            on: { change: () => apply({ analysisBackend: b.id }) },
          }),
        ),
        el('td', {}, b.name),
        el('td', { title: settings[b.key] || '' }, settings[b.key] ? `chosen: ${settings[b.key]}` : found),
        el(
          'td',
          {},
          el(
            'button',
            {
              on: {
                click: async () => {
                  const p2 = await window.tools.pickFile(b.pick);
                  if (p2) await apply({ [b.key]: p2 });
                },
              },
            },
            'Change…',
          ),
          settings[b.key] ? el('button', { on: { click: () => apply({ [b.key]: '' }) } }, 'Find by itself') : '',
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Controls

function bindNumber(id) {
  $(id).addEventListener('change', () => {
    const n = Number($(id).value);
    if (Number.isInteger(n)) apply({ [id]: n });
  });
}
for (const id of ['port', 'linkHours', 'cacheMb', 'sttPort', 'analysisPort', 'analysisTimeout']) bindNumber(id);
for (const id of ['convert', 'prepare', 'systemCodecs', 'sttEnabled', 'analysisEnabled']) {
  $(id).addEventListener('change', () => apply({ [id]: $(id).checked }));
}
$('sttLanguage').addEventListener('change', () => apply({ sttLanguage: $('sttLanguage').value }));

$('folder-add').addEventListener('click', async () => {
  const p = await window.tools.pickFolder('Choose the folder of your recordings');
  if (p) await apply({ folders: [...settings.folders, { path: p, enabled: true }] });
});
$('server-toggle').addEventListener('click', () =>
  run(() => window.tools.call(snap.status?.server.running ? 'server.stop' : 'server.start')),
);
$('secret-show').addEventListener('click', async () => {
  if (secretShown) {
    $('secret').textContent = '••••••••••••••••';
    $('secret-show').textContent = 'Show';
    secretShown = false;
    return;
  }
  const r = await run(() => window.tools.call('secret.get'));
  if (!r) return;
  $('secret').textContent = r.secret;
  $('secret-show').textContent = 'Hide';
  secretShown = true;
});
$('secret-copy').addEventListener('click', async () => {
  const r = await run(() => window.tools.call('secret.get'));
  if (r) {
    await window.tools.copy(r.secret);
    toast('Secret copied');
  }
});
$('secret-new').addEventListener('click', async () => {
  if (!confirm('Make a new secret? The old one stops working at once; Clew will ask for the new one.')) return;
  const r = await run(() => window.tools.call('secret.reset'));
  if (!r) return;
  if (secretShown) $('secret').textContent = r.secret;
  toast('A new secret was made');
});
$('address-copy').addEventListener('click', async () => {
  await window.tools.copy($('address').textContent);
  toast('Address copied');
});
$('origin-add').addEventListener('click', () => {
  const v = $('origin-new').value.trim();
  if (!v) return;
  apply({ origins: [...settings.origins, v] }).then(() => ($('origin-new').value = ''));
});
$('ffmpeg-pick').addEventListener('click', async () => {
  const p = await window.tools.pickFile('Choose ffmpeg');
  if (p) await apply({ ffmpeg: p });
});
$('ffmpeg-clear').addEventListener('click', () => apply({ ffmpeg: '' }));

$('dict-install').addEventListener('click', () => run(() => window.tools.installDictation()));
$('dict-uninstall').addEventListener('click', async () => {
  if (!confirm('Remove the speech server? Downloaded models stay; installing it again takes one download.')) return;
  await run(() => window.tools.uninstallDictation());
});
$('dict-toggle').addEventListener('click', () =>
  run(() => window.tools.call(snap.status?.dictation.wanted ? 'dictation.stop' : 'dictation.start')),
);
$('stt-key-copy').addEventListener('click', async () => {
  const r = await run(() => window.tools.call('sttKey.get'));
  if (r) {
    await window.tools.copy(r.key);
    toast('Dictation key copied');
  }
});
$('stt-key-new').addEventListener('click', async () => {
  if (!confirm('Make a new dictation key? The old one stops working at once.')) return;
  if (await run(() => window.tools.call('sttKey.reset'))) toast('A new dictation key was made');
});

$('ana-toggle').addEventListener('click', () =>
  run(() => window.tools.call(snap.status?.analysis.wanted ? 'analysis.stop' : 'analysis.start')),
);
$('ana-look').addEventListener('click', () => run(() => window.tools.call('analysis.lookAgain')));
$('scripts-pick').addEventListener('click', async () => {
  const p = await window.tools.pickFolder('Choose the folder of your R scripts');
  if (p) await apply({ analysisScripts: p });
});
$('scripts-clear').addEventListener('click', () => apply({ analysisScripts: '' }));
$('ana-key-copy').addEventListener('click', async () => {
  const r = await run(() => window.tools.call('analysisKey.get'));
  if (r) {
    await window.tools.copy(r.key);
    toast('Analysis key copied');
  }
});
$('ana-key-new').addEventListener('click', async () => {
  if (!confirm('Make a new analysis key? The old one stops working at once.')) return;
  if (await run(() => window.tools.call('analysisKey.reset'))) toast('A new analysis key was made');
});

$('login').addEventListener('change', async () => {
  $('login').checked = await window.tools.setLoginItem($('login').checked);
});
$('open-app').addEventListener('click', () => window.tools.openApp());

// Tabs
function showTab(name) {
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[role=tabpanel]')) p.hidden = p.id !== name;
  if (name === 'dictation') run(async () => (models = await window.tools.call('dictation.models'))).then(renderModels);
}
for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
window.tools.onTab(showTab);

// Live updates
let wasRunning = false;
window.tools.onStatus(async (s) => {
  const downloadsBefore = snap?.status?.dictation.downloading;
  snap = s;
  if (s.state === 'running' && !wasRunning) await load();
  wasRunning = s.state === 'running';
  // A model finished downloading: its row changes.
  if (downloadsBefore && !s.status?.dictation.downloading) {
    models = await run(() => window.tools.call('dictation.models'));
  }
  renderAll();
});
window.tools.onLog((line) => {
  const log = $('log');
  log.textContent += `${log.textContent ? '\n' : ''}${new Date().toLocaleTimeString()}  ${line}`;
  log.scrollTop = log.scrollHeight;
});

load().then(() => {
  wasRunning = snap.state === 'running';
  if (location.hash) showTab(location.hash.slice(1));
});
