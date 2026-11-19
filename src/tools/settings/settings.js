'use strict';
/* The settings window of Clew's local tools. Everything goes through window.tools (preload.js),
   which drives the audio server's --control pipe; this page keeps no state of its own beyond what
   the server last said. */

const $ = (id) => document.getElementById(id);
let settings = null; // settings.get
let snap = null; // tools:snapshot (state, problem, status, dictationProgram, installing…)
let models = null; // dictation.models

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

// Explanations sit behind an (i) button (`.info`, its text in data-tip), shown on hover or focus
// in one floating tip. In an open modal dialog the tip moves into the dialog: the dialog is in the
// top layer, above anything in the page.
const tip = el('div', { class: 'tip', role: 'tooltip' });
tip.hidden = true;

function setTip(button, text) {
  button.dataset.tip = text;
  button.setAttribute('aria-label', text);
}

function showTip(button) {
  if (!button.dataset.tip) return;
  (button.closest('dialog[open]') ?? document.body).append(tip);
  tip.textContent = button.dataset.tip;
  tip.hidden = false;
  const r = button.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = tip;
  tip.style.left = `${Math.max(8, Math.min(r.left - 8, innerWidth - w - 8))}px`;
  tip.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? r.top - 6 - h : r.bottom + 6}px`;
}
const hideTip = () => (tip.hidden = true);

for (const b of document.querySelectorAll('.info[data-tip]')) setTip(b, b.dataset.tip);
document.addEventListener('mouseover', (e) => {
  const b = e.target.closest?.('.info');
  if (b) showTip(b);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.info') && document.activeElement !== e.target.closest('.info')) hideTip();
});
// Focus from the keyboard only: a dialog focusing its first button on opening shows nothing.
document.addEventListener('focusin', (e) => (e.target.matches('.info:focus-visible') ? showTip(e.target) : hideTip()));
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', (e) => e.key === 'Escape' && hideTip());
document.addEventListener('scroll', hideTip, true);

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
  for (const b of document.querySelectorAll('main button:not(.info), main input, main select')) {
    // The app's own rows (`data-app`) do not depend on the audio server; explanations never do.
    if (!b.closest('[data-app]')) b.disabled = snap.state !== 'running';
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
  // A newer speech server in the latest clew-tools release (checked when this window opens).
  $('dict-update').hidden = !snap.dictationUpdate || Boolean(snap.installing);
  if (snap.dictationUpdate) {
    $('dict-update-text').textContent = `Version ${snap.dictationUpdate} is available (one download, about 200 MB).`;
  }
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
        el('td', { class: 'nowrap' }, mb(m.bytes)),
        el('td', {}, use[m.use] + note),
        el('td', {}, action),
      ),
    );
  }
  setTip($('dict-models-tip'), `small suits most computers. Models are kept in ${models.modelsDir}.`);
  $('dict-models-note').textContent = d?.downloadProblem ? `Last download failed: ${d.downloadProblem}` : '';
  $('dict-models-note').hidden = !d?.downloadProblem;
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
        el('td', { class: 'nowrap' }, b.name),
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
/**
 * A value to paste elsewhere (the secret, the dictation and analysis keys): masked until Show,
 * then selectable; Copy; New makes another one at once (`<id>`, `<id>-show`, `-copy`, `-new`).
 */
function bindMasked(id, { get, reset, pick, name, ask }) {
  const MASK = '••••••••••••••••';
  let shown = false;
  const read = async () => {
    const r = await run(() => window.tools.call(get));
    return r && pick(r);
  };
  $(`${id}-show`).addEventListener('click', async () => {
    const value = shown ? null : await read();
    if (!shown && !value) return;
    shown = !shown;
    $(id).textContent = shown ? value : MASK;
    $(`${id}-show`).textContent = shown ? 'Hide' : 'Show';
  });
  $(`${id}-copy`).addEventListener('click', async () => {
    const value = await read();
    if (!value) return;
    await window.tools.copy(value);
    toast(`${name} copied`);
  });
  $(`${id}-new`).addEventListener('click', async () => {
    if (!confirm(ask)) return;
    if (!(await run(() => window.tools.call(reset)))) return;
    if (shown) $(id).textContent = (await read()) ?? MASK;
    toast(`A new ${name.toLowerCase()} was made`);
  });
}
bindMasked('secret', {
  get: 'secret.get',
  reset: 'secret.reset',
  pick: (r) => r.secret,
  name: 'Secret',
  ask: 'Make a new secret? The old one stops working at once; Clew will ask for the new one.',
});
bindMasked('stt-key', {
  get: 'sttKey.get',
  reset: 'sttKey.reset',
  pick: (r) => r.key,
  name: 'Dictation key',
  ask: 'Make a new dictation key? The old one stops working at once.',
});
bindMasked('ana-key', {
  get: 'analysisKey.get',
  reset: 'analysisKey.reset',
  pick: (r) => r.key,
  name: 'Analysis key',
  ask: 'Make a new analysis key? The old one stops working at once.',
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
$('dict-update-button').addEventListener('click', () => run(() => window.tools.installDictation()));
// Quietly: nothing is said when the release cannot be read.
void window.tools.checkDictationUpdate().catch(() => {});
$('dict-uninstall').addEventListener('click', async () => {
  if (!confirm('Remove the speech server? Downloaded models stay; installing it again takes one download.')) return;
  await run(() => window.tools.uninstallDictation());
});
$('dict-toggle').addEventListener('click', () =>
  run(() => window.tools.call(snap.status?.dictation.wanted ? 'dictation.stop' : 'dictation.start')),
);

$('ana-toggle').addEventListener('click', () =>
  run(() => window.tools.call(snap.status?.analysis.wanted ? 'analysis.stop' : 'analysis.start')),
);
$('ana-look').addEventListener('click', () => run(() => window.tools.call('analysis.lookAgain')));
$('scripts-pick').addEventListener('click', async () => {
  const p = await window.tools.pickFolder('Choose the folder of your R scripts');
  if (p) await apply({ analysisScripts: p });
});
$('scripts-clear').addEventListener('click', () => apply({ analysisScripts: '' }));

$('login').addEventListener('change', async () => {
  $('login').checked = await window.tools.setLoginItem($('login').checked);
});
$('open-app').addEventListener('click', () => window.tools.openApp());

// Remove all Clew data from this computer (main.js `wipeData`, src/wipe.js)
let wipePlanNow = null;
let wiping = false;
const size = (bytes) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : mb(bytes));

function wipeProblem(text) {
  $('wipe-problem').textContent = text || '';
  $('wipe-problem').hidden = !text;
}

function renderWipePlan(p) {
  const list = $('wipe-items');
  list.replaceChildren();
  for (const item of p.items) {
    const li = el('li');
    if (item.optional) {
      const box = el('input', { type: 'checkbox', id: `wipe-item-${item.id}`, checked: item.exists });
      box.disabled = !item.exists;
      li.append(box);
    }
    const where = el('button', { type: 'button', class: 'info' }, 'i');
    setTip(where, item.path);
    li.append(el('span', { class: 'grow' }, item.label), where);
    li.append(el('span', { class: 'muted size' }, item.exists ? size(item.bytes) : 'not there'));
    list.append(li);
  }
  $('wipe-kept').replaceChildren(...p.kept.map((k) => el('span', {}, k.label)));
  setTip($('wipe-kept-tip'), p.kept.map((k) => k.detail).join('\n'));
  $('wipe-word').hidden = !p.word;
  $('wipe-pass').placeholder = `at least ${p.minPassphrase} characters`;
  setTip(
    $('wipe-pass-tip'),
    `At least ${p.minPassphrase} characters: letters without accents, digits, spaces and punctuation (other characters open differently in different archivers).`,
  );
}

function wipeBackupShown() {
  $('wipe-backup-fields').hidden = !$('wipe-backup').checked;
  $('wipe-go').textContent = $('wipe-backup').checked ? 'Back up and remove…' : 'Remove without a backup…';
}

$('wipe-open').addEventListener('click', async () => {
  const p = await run(() => window.tools.wipePlan());
  if (!p) return;
  wipePlanNow = p;
  renderWipePlan(p);
  $('wipe-pass').value = '';
  $('wipe-pass2').value = '';
  $('wipe-backup').checked = true;
  wipeBackupShown();
  wipeProblem('');
  $('wipe-progress').hidden = true;
  $('wipe-go').disabled = Boolean(p.smoke);
  $('wipe-dialog').showModal();
});
$('wipe-backup').addEventListener('change', wipeBackupShown);
// Cancel is a plain button: the form's submit handler below only ever runs the removal.
$('wipe-cancel').addEventListener('click', () => {
  if (!wiping) $('wipe-dialog').close();
});
$('wipe-dialog').addEventListener('cancel', (e) => {
  if (wiping) e.preventDefault();
});

$('wipe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (wiping || e.submitter?.value !== 'go') return;
  const backup = $('wipe-backup').checked;
  const pass = $('wipe-pass').value;
  if (backup) {
    if (pass.length < wipePlanNow.minPassphrase) return wipeProblem(`The passphrase needs at least ${wipePlanNow.minPassphrase} characters.`);
    if (!/^[\x20-\x7e]+$/.test(pass)) return wipeProblem('Use letters without accents, digits, spaces and punctuation only.');
    if (pass !== $('wipe-pass2').value) return wipeProblem('The two passphrases differ.');
  }
  wipeProblem('');
  wiping = true;
  $('wipe-go').disabled = true;
  $('wipe-cancel').disabled = true;
  const box = $('wipe-item-folder');
  const r = await run(() => window.tools.wipe({ includeFolder: box ? box.checked : false, passphrase: backup ? pass : null }));
  if (r?.status === 'quitting') return;
  wiping = false;
  $('wipe-go').disabled = false;
  $('wipe-cancel').disabled = false;
  $('wipe-progress').hidden = true;
  if (r?.message) wipeProblem(r.message);
});

const WIPE_PHASES = {
  closing: 'Closing Clew’s windows…',
  listing: 'Listing what to back up…',
  checking: 'Checking the backup with its passphrase…',
  quitting: 'Clew closes now; the folders are deleted right after.',
};
window.tools.onWipe((p) => {
  if (p.phase === 'idle') {
    $('wipe-progress').hidden = true;
    return;
  }
  $('wipe-progress').hidden = false;
  const bar = $('wipe-progress-bar');
  if (p.phase === 'backup') {
    $('wipe-progress-text').textContent = `Backing up: ${p.done} of ${p.total} files, ${size(p.bytes)}`;
    bar.value = p.total ? p.done / p.total : 0;
  } else {
    $('wipe-progress-text').textContent = WIPE_PHASES[p.phase] ?? p.phase;
    if (p.phase === 'quitting') bar.value = 1;
    else bar.removeAttribute('value');
  }
});

// Clew's folder (main.js, src/folder-location.js)
function renderFolder(f) {
  if (!f) return;
  $('folder-root').textContent = f.root;
  $('folder-move').disabled = f.fixed;
  const notes = [];
  if (f.synced) notes.push(`It is in ${f.synced}: what the files hold stays encrypted, but ${f.synced} sees their names, sizes and times.`);
  if (f.fixed) notes.push('Set for this run (CLEW_FOLDER_ROOT or a test run): it cannot be moved from here.');
  $('folder-note').textContent = notes.join(' ');
  $('folder-note').hidden = !notes.length;
}
$('folder-open').addEventListener('click', () => run(() => window.tools.openFolder()));
$('folder-move').addEventListener('click', async () => {
  $('folder-move').disabled = true;
  renderFolder((await run(() => window.tools.moveFolder())) ?? (await window.tools.folder()));
});
window.tools.onFolder(renderFolder);
window.tools.folder().then(renderFolder);

// The app's own preferences (main.js, src/app-settings.js)
function renderAppPrefs(p) {
  if (!p) return;
  $('devtools').checked = p.devTools || p.devToolsAlways;
  $('devtools').disabled = p.devToolsAlways;
  if (p.devToolsAlways) $('devtools-note').textContent = 'Always shown in a development run.';
  $('devtools-note').hidden = !p.devToolsAlways;
}
$('devtools').addEventListener('change', async () => {
  renderAppPrefs(await run(() => window.tools.setDevTools($('devtools').checked)));
});
window.tools.appPrefs().then(renderAppPrefs);

// Updates (src/site-updates.js, driven from main.js)
const SITE_NAMES = { clew: 'Clew', yaqatw: 'yaqatw' };
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const short = (commit) => (commit ? commit.slice(0, 8) : '?');

function textEl(tag, text, cls) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** The app's own line: its version, and a newer release being fetched or ready. */
function appUpdateText(a) {
  if (a.status === 'downloading') return `Downloading ${a.version}${a.percent != null ? ` · ${a.percent}%` : ''}`;
  if (a.status === 'ready') return `Ready: ${a.version}, installed when Clew restarts`;
  if (a.status === 'error') return `Last check failed: ${a.error}`;
  return '';
}

/** Tell only (macOS): a newer release, to download from its page. */
function appAvailableLink(a) {
  if (a.status !== 'available' || !a.url) return null;
  const line = textEl('div', `Version ${a.version} is out: `, 'muted');
  const link = document.createElement('a');
  link.href = a.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'download it';
  line.append(link);
  return line;
}

function renderUpdates(u) {
  if (!u) return;
  if (u.releasesUrl) {
    $('releases-link').href = u.releasesUrl;
    $('releases-note').hidden = false;
  }
  const appOn = Boolean(u.app?.enabled);
  setTip(
    $('updates-tip'),
    u.app?.tellOnly
      ? `Clew and yaqatw update themselves from their websites; Clew Desktop says when a new version is out, to download from its releases (on macOS it cannot install one itself). Checked when Clew starts and every ${u.intervalHours} hours.`
      : `Clew Desktop updates itself from its releases, Clew and yaqatw from their websites: checked when Clew starts and every ${u.intervalHours} hours.`,
  );
  const grid = $('update-sites');
  grid.replaceChildren();
  if (u.app) {
    grid.append(textEl('span', 'Clew Desktop', 'label'));
    const cell = textEl('div', '', 'wide');
    cell.append(textEl('div', `Version ${u.app.current}`));
    const more = appUpdateText(u.app);
    if (more) cell.append(textEl('div', more, 'muted'));
    const available = appAvailableLink(u.app);
    if (available) cell.append(available);
    grid.append(cell);
  }
  for (const s of u.sites) {
    grid.append(textEl('span', SITE_NAMES[s.name] ?? s.name, 'label'));
    const cell = textEl('div', '', 'wide');
    const date = s.committedAt || s.builtAt;
    cell.append(
      textEl('div', `${short(s.commit)}${date ? ` · ${when(date)}` : ''} · ${s.from === 'update' ? 'updated' : 'from the installer'}`),
    );
    if (s.waiting) {
      cell.append(textEl('div', `Ready: ${short(s.waiting.commit)} · ${when(s.waiting.committedAt)}, used from the next start`, 'muted'));
    }
    if (s.last?.status === 'needs-app') {
      cell.append(textEl('div', `A newer build needs Clew Desktop ${s.last.minDesktop}: install the new version`, 'muted'));
    } else if (s.last?.status === 'error') {
      cell.append(textEl('div', `Last check failed: ${s.last.error}`, 'muted'));
    } else if (s.last?.signed) {
      cell.append(textEl('div', 'Latest build on the site: signed', 'muted'));
    }
    grid.append(cell);
  }
  const appReady = u.app?.status === 'ready';
  const ready = appReady || u.sites.some((s) => s.waiting);
  const failed = u.sites.some((s) => s.last?.status === 'error') || u.app?.status === 'error';
  const busy = u.checking || u.app?.status === 'checking';
  const checkedAt = [u.checkedAt, u.app?.checkedAt].filter(Boolean).sort().at(-1);
  $('restart-update').hidden = !ready;
  $('check-updates').disabled = !(u.enabled || appOn) || busy;
  $('update-state').textContent = busy
    ? 'Checking…'
    : !checkedAt
      ? u.enabled || appOn
        ? 'Not checked yet'
        : 'Off in this run (development or test)'
      : `Checked ${when(checkedAt)}${
          ready ? ' · update ready' : u.app?.status === 'available' ? ' · a new version is out' : failed ? '' : ' · up to date'
        }`;
}

$('check-updates').addEventListener('click', async () => {
  $('check-updates').disabled = true;
  $('update-state').textContent = 'Checking…';
  const u = await run(() => window.tools.checkUpdates());
  if (u) renderUpdates(u);
  else renderUpdates(await window.tools.updates());
});
$('restart-update').addEventListener('click', () => window.tools.restartToUpdate());
window.tools.onUpdates(renderUpdates);
window.tools.updates().then(renderUpdates);

// ---------------------------------------------------------------------------------------------
// Word and the programs connected to Clew (main.js: Yaqatw for Word, the local API's clients)

const WORD_KIND = 'word-template';

function renderWord(w) {
  if (!w) return;
  const { plugin, clients } = w;
  // One form: Yaqatw for Word first (its connection in its own row), then the other programs.
  const grid = $('clients');
  grid.replaceChildren();
  const wordClient = plugin.installed ? clients.find((c) => c.kind === WORD_KIND) : null;
  if (plugin.available || plugin.installed) {
    const button = el(
      'button',
      {
        on: {
          click: async () => {
            button.disabled = true;
            const next = await run(() => (plugin.installed ? window.tools.removeWord() : window.tools.installWord()));
            renderWord(next ?? (await window.tools.word()));
          },
        },
      },
      plugin.installed ? 'Remove…' : 'Install',
    );
    const status =
      (!plugin.installed
        ? 'Not installed'
        : plugin.connected
          ? `Installed · connected${wordClient ? ` ${when(wordClient.pairedAt)}` : ''}`
          : 'Installed, not connected yet') +
      // Word holds the template while it runs: the new one goes in once Word is closed.
      (plugin.waiting ? ' · an update is waiting: close Word to install it' : '');
    grid.append(textEl('span', 'Yaqatw for Word', 'label'), textEl('span', status), el('span', { class: 'actions' }, button));
  }
  const others = clients.filter((c) => c !== wordClient);
  if (!grid.children.length && !others.length) grid.append(textEl('span', 'None', 'lead muted'));
  for (const c of others) {
    grid.append(textEl('span', c.name, 'label'), textEl('span', `Connected ${when(c.pairedAt)}`, 'muted'));
    if (c.kind === WORD_KIND) {
      // A Word template paired earlier: removing Yaqatw for Word takes it away, not this list.
      grid.append(textEl('span', 'installed with Clew', 'muted actions'));
    } else {
      const forget = el(
        'button',
        {
          on: {
            click: async () => {
              forget.disabled = true;
              const next = await run(() => window.tools.forgetClient(c.id));
              renderWord(next ?? (await window.tools.word()));
            },
          },
        },
        'Disconnect',
      );
      grid.append(el('span', { class: 'actions' }, forget));
    }
  }
}

window.tools.onWord(renderWord);
window.tools.word().then(renderWord);

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
