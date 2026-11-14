// Shared by the pipeline scripts: the site list (with local overrides), and running commands.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One drive-letter case on Windows. `c:\x` and `C:\x` are the same folder, but bundlers key
 * modules by path string: an install or build started from a lower-case drive (VS Code's
 * terminal often gives one) can put the same file, React included, into a bundle twice, and
 * every hook then throws in the production build only. Clew guards its own Vite configs
 * against it (`scripts/lib/viteDrive.ts`); this makes every path and working directory the
 * pipeline hands out upper-case, `npm ci` included (npm's workspace links keep the case
 * they were created with).
 */
export function upperDrive(p) {
  return process.platform === 'win32' && /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

export const ROOT = upperDrive(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (process.platform === 'win32') process.chdir(upperDrive(process.cwd()));

const envKey = (name, suffix) => `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;

function localConfig() {
  const file = join(ROOT, 'sites.local.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

const abs = (p) => upperDrive(isAbsolute(p) ? p : resolve(ROOT, p));

/**
 * The sites from `sites.config.json`, each with:
 * - `dir`: where its source is. `.sources/<name>` unless overridden by `<NAME>_PATH`
 *   (e.g. `CLEW_PATH=../ariadne`) or by `sites.local.json` → `{ "<name>": { "path": … } }`.
 * - `local`: true when that is someone's own checkout (never cloned over or cleaned).
 * - `ref`: `<NAME>_REF` overrides the configured branch, tag or commit.
 * - `envSource`: the file copied to the source's `.env` before a build of a clone:
 *   `<NAME>_ENV_FILE`, then `sites.local.json` → `envFile`, then `env/<name>.env`.
 */
export function loadSites(only = []) {
  const config = JSON.parse(readFileSync(join(ROOT, 'sites.config.json'), 'utf8'));
  const local = localConfig();
  const names = new Set(only);
  return config.sites
    .filter((s) => names.size === 0 || names.has(s.name))
    .map((s) => {
      const override = process.env[envKey(s.name, 'PATH')] || local[s.name]?.path;
      const envSource = process.env[envKey(s.name, 'ENV_FILE')] || local[s.name]?.envFile;
      return {
        ...s,
        ref: process.env[envKey(s.name, 'REF')] || s.ref,
        local: Boolean(override),
        dir: override ? abs(override) : join(ROOT, '.sources', s.name),
        envSource: envSource ? abs(envSource) : join(ROOT, 'env', `${s.name}.env`),
      };
    });
}

/** The environment for an app's own tools: no Electron-as-Node, no inherited NODE_ENV. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // npm hands these on as the "original" directory: keep them in the same case.
  for (const k of ['INIT_CWD', 'PWD']) if (env[k]) env[k] = upperDrive(env[k]);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV; // `npm ci` would skip devDependencies under NODE_ENV=production
  return env;
}

/** Runs a shell command, streaming its output; rejects on a non-zero exit. */
export function run(command, { cwd, env, label } = {}) {
  if (label) console.log(`\n[${label}] $ ${command}   (in ${cwd})`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: cwd && upperDrive(cwd),
      env: env ?? childEnv(),
      shell: true,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`"${command}" failed in ${cwd} (${signal ?? `exit ${code}`})`));
    });
  });
}

/** Git with the output captured. In CI, `GIT_TOKEN` authenticates github.com without being stored. */
export function git(args, cwd, { check = true } = {}) {
  const auth = process.env.GIT_TOKEN
    ? [
        '-c',
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
          `x-access-token:${process.env.GIT_TOKEN}`,
        ).toString('base64')}`,
      ]
    : [];
  const r = spawnSync('git', [...auth, ...args], { cwd: cwd && upperDrive(cwd), encoding: 'utf8' });
  if (check && r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd ?? ROOT}:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

export function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}
