'use strict';
/**
 * "Remove all Clew data from this computer" (Settings › General), for shared and lab computers:
 * what goes, what a backup holds, and the helper that deletes once the app has quit.
 *
 * The profile folder is in use while the app runs (Chromium, the databases, the tools), so the
 * deleting is done by a small Node script (`HELPER`), run detached by the app's own executable
 * (`ELECTRON_RUN_AS_NODE`) from the temporary folder: it waits for the app to be gone, deletes,
 * writes a log, and says how it went.
 *
 * Plain Node, so it runs under `node --test`.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

/** Folders of the profile left out of a backup: caches and downloads the app gets again. */
const NOT_BACKED_UP = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'shadercache',
  'grshadercache',
  'cachestorage',
  'scriptcache',
  'crashpad',
  'site-updates',
  'dictation',
]);

/** Total size of a folder or file; 0 when missing. Links are not followed. */
async function sizeOf(p) {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  let total = 0;
  for (const e of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) {
    total += await sizeOf(path.join(p, e.name));
  }
  return total;
}

/**
 * What goes, with sizes: the profile, Clew's folder (when chosen), the update downloads.
 * @param {{ profile: string, folder: string, updaterCache?: string | null }} where
 */
async function plan(where) {
  const items = [
    { id: 'profile', label: 'Clew’s vaults, yaqatw’s storage, settings, downloaded updates', path: where.profile },
    { id: 'folder', label: 'Clew’s folder: the encrypted copy of each vault', path: where.folder, optional: true },
  ];
  if (where.updaterCache) items.push({ id: 'updates', label: 'Downloaded installers of the app', path: where.updaterCache });
  for (const item of items) {
    item.bytes = await sizeOf(item.path);
    item.exists = await fs
      .access(item.path)
      .then(() => true)
      .catch(() => false);
  }
  return items;
}

/** A file can be read (a locked one, such as an open database's LOCK, cannot). */
async function readable(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    await fh.read(Buffer.alloc(1), 0, 1, 0);
    return true;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * The entries of a backup (for `zip-aes.js`): the profile under `profile/`, without caches, and
 * Clew's folder under `Clew folder/` when given; files that cannot be read are listed apart.
 * @returns {Promise<{ entries: object[], skipped: string[] }>}
 */
async function backupEntries({ profile, folder }) {
  const entries = [];
  const skipped = [];
  const walk = async (abs, name) => {
    let list;
    try {
      list = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.push({ name: `${name}/`, mtime: (await fs.stat(abs)).mtime });
    for (const e of list) {
      if (e.isDirectory() && NOT_BACKED_UP.has(e.name.toLowerCase())) continue;
      const a = path.join(abs, e.name);
      const n = `${name}/${e.name}`;
      if (e.isDirectory()) await walk(a, n);
      else if (e.isFile()) {
        if (await readable(a)) entries.push({ name: n, path: a, mtime: (await fs.stat(a)).mtime });
        else skipped.push(n);
      }
    }
  };
  await walk(profile, 'profile');
  if (folder) await walk(folder, 'Clew folder');
  return { entries, skipped };
}

/** The note at the top of a backup: what it is and how to put it back. */
function backupReadme({ profile, folder, made, appVersion, skipped = [] }) {
  return [
    `Clew Desktop backup, made ${made} by Clew Desktop ${appVersion}.`,
    '',
    'profile/      the app\'s data folder, without caches:',
    `              ${profile}`,
    ...(folder ? ['Clew folder/  Clew\'s folder (an encrypted copy of each vault):', `              ${folder}`] : []),
    '',
    'To put it back: install Clew Desktop and quit it (File › Exit, and Quit Clew in the tray),',
    'then copy the contents of profile/ into the data folder above (create it if needed), and',
    'Clew folder/ to Documents\\Clew (or where you want it; Settings › General › Clew\'s folder).',
    'Then start Clew.',
    '',
    'The vaults inside stay encrypted with their own passphrases. yaqatw\'s storage is not',
    'encrypted by yaqatw: keep this file and its passphrase safe.',
    '',
    ...(skipped.length
      ? [
          'Left out: files the app still held open and that could not be read (lock files and the like;',
          'without the cookies, you sign in to cloud services again after putting this back):',
          ...skipped.map((s) => `  ${s}`),
          '',
        ]
      : []),
  ].join('\r\n');
}

/**
 * The helper, run by the app's own executable as Node once the app quits. Argument: a JSON file
 * `{ pid, paths, log, notify }`.
 */
const HELPER = `'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 240 && alive(job.pid); i++) sleep(250);
sleep(1500);
const results = [];
for (const p of job.paths) {
  let error = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { fs.rmSync(p, { recursive: true, force: true }); error = null; break; }
    catch (e) { error = e.message; sleep(500); }
  }
  results.push({ path: p, removed: !fs.existsSync(p), error });
}
fs.writeFileSync(job.log, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
try { fs.rmSync(process.argv[2], { force: true }); fs.rmSync(__filename, { force: true }); } catch {}
const left = results.filter((r) => !r.removed).map((r) => r.path);
const text = left.length
  ? 'Clew could not remove everything. Still there:\\n' + left.join('\\n') + '\\n\\nDelete these yourself. Details: ' + job.log
  : 'Clew\\'s data was removed from this computer.';
if (job.notify) {
  try {
    if (process.platform === 'win32') {
      const ps = "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:CLEW_WIPE_TEXT, 'Clew')";
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, CLEW_WIPE_TEXT: text }, windowsHide: false });
    } else if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', 'display dialog (system attribute "CLEW_WIPE_TEXT") buttons {"OK"} with title "Clew"'], { env: { ...process.env, CLEW_WIPE_TEXT: text } });
    }
  } catch {}
}
`;

module.exports = { plan, backupEntries, backupReadme, sizeOf, HELPER, NOT_BACKED_UP };
