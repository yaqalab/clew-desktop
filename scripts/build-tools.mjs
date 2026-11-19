#!/usr/bin/env node
// `npm run build:tools`: builds Clew's local tools from the Clew source (the `clew` site's
// repository, `tools/`) into `tools-dist/`, which the installer ships as `resources/tools/`:
//
//   tools-dist/clew-audio-server(.exe)           the audio server, run hidden with --control
//   tools-dist/clew-analysis-server/…            the analysis engine (PyInstaller, ~19 MB)
//   tools-dist/build-info.json                   version, ref and commit
//
// Dictation is not built here: the app downloads it on demand (src/tools/dictation-install.js).
//
// Where the tools come from:
//   - `TOOLS_PATH=<dir>`: that `tools/` folder as it is;
//   - `TOOLS_REF=<ref>`: `tools/` at that ref of the Clew repository, exported with `git archive`
//     into `.sources/tools-export/` (the checkout itself is not touched);
//   - otherwise: `tools/` of the Clew source in use (`.sources/clew` or the local checkout).
//
// Needs, on Windows: Visual Studio (or Build Tools) with the C++ workload, which brings CMake and
// Ninja; Python 3.10+ for the analysis engine. macOS and Linux: a C++17 compiler, CMake and
// Python 3.10+ with venv. Built on Linux (Ubuntu 24.04); not yet on macOS. Until the apps are
// released there, `CLEW_TOOLS_POSIX=1` turns it on.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, fail, git, loadSites, run, upperDrive } from './lib.mjs';

const win = process.platform === 'win32';
const OUT = join(ROOT, 'tools-dist');

async function toolsSource() {
  if (process.env.TOOLS_PATH) return { dir: upperDrive(process.env.TOOLS_PATH), ref: 'path', commit: '' };
  const [clew] = loadSites(['clew']);
  if (!existsSync(join(clew.dir, '.git'))) fail(`no Clew source at ${clew.dir}: run "npm run sources" first`);
  const ref = process.env.TOOLS_REF;
  if (!ref) {
    return {
      dir: join(clew.dir, 'tools'),
      ref: clew.local ? git(['rev-parse', '--abbrev-ref', 'HEAD'], clew.dir) : clew.ref,
      commit: git(['rev-parse', 'HEAD'], clew.dir),
    };
  }
  const commit = git(['rev-parse', `${ref}^{commit}`], clew.dir);
  const dest = join(ROOT, '.sources', 'tools-export');
  // Keep the build folders between runs (fast rebuilds); replace everything else.
  if (existsSync(dest)) {
    for (const entry of readdirSync(dest)) if (entry !== 'native') rmSync(join(dest, entry), { recursive: true, force: true });
    for (const entry of existsSync(join(dest, 'native')) ? readdirSync(join(dest, 'native')) : [])
      if (entry !== 'build') rmSync(join(dest, 'native', entry), { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });
  console.log(`[tools] exporting tools/ at ${ref} (${commit.slice(0, 12)}) from ${clew.dir}`);
  // git archive → tar, unpacked with the system's tar (Windows 10+ ships bsdtar).
  // Windows' own tar (bsdtar): Git's GNU tar, often first on PATH, reads "C:" as a host name.
  const tar = win ? `"${join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')}"` : 'tar';
  await run(`git archive --format=tar ${commit} tools | ${tar} -x -f - -C "${dest}" --strip-components=1`, {
    cwd: clew.dir,
  });
  return { dir: dest, ref, commit };
}

async function buildWindows(tools) {
  await run(`"${join(tools, 'native', 'build.cmd')}" Release`, { cwd: join(tools, 'native'), label: 'tools' });
  await run(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(tools, 'analysis-server', 'build_exe.ps1')}"`,
    { cwd: join(tools, 'analysis-server'), label: 'tools' },
  );
  return {
    server: join(tools, 'native', 'build', 'clew-audio-server.exe'),
    analysis: join(tools, 'analysis-server', 'dist', 'clew-analysis-server'),
  };
}

// Run on Linux (Ubuntu 24.04, 2026-11-19); not yet on macOS.
async function buildPosix(tools) {
  const nb = join(tools, 'native', 'build');
  // Ninja when it is there, else CMake's default (Make), which every Mac and Linux has.
  const generator = spawnSync('ninja', ['--version'], { stdio: 'ignore' }).status === 0 ? '-G Ninja ' : '';
  await run(`cmake -S . -B build ${generator}-DCMAKE_BUILD_TYPE=Release && cmake --build build -j && ./build/unit_tests`, {
    cwd: join(tools, 'native'),
    label: 'tools',
  });
  const venv = join(ROOT, '.sources', 'analysis-venv');
  const py = join(venv, 'bin', 'python');
  await run(
    [
      `python3 -m venv "${venv}"`,
      `"${py}" -m pip install --quiet --disable-pip-version-check pyinstaller`,
      `"${py}" -m PyInstaller --noconfirm --clean --onedir --console --name clew-analysis-server` +
        ` --distpath dist --workpath "${join(venv, 'work')}" --specpath "${join(venv, 'spec')}"` +
        // --add-data is read from the spec's folder: the source folder must be absolute.
        ` --paths . --add-data "${join(tools, 'analysis-server', 'clew_analysis', 'commands')}:clew_analysis/commands"` +
        ' --exclude-module tkinter --exclude-module sqlite3 --exclude-module unittest --exclude-module pydoc' +
        ' --exclude-module xmlrpc --exclude-module multiprocessing --exclude-module asyncio' +
        ' clew_analysis_server.py',
    ].join(' && '),
    { cwd: join(tools, 'analysis-server'), label: 'tools' },
  );
  return {
    server: join(nb, 'clew-audio-server'),
    analysis: join(tools, 'analysis-server', 'dist', 'clew-analysis-server'),
  };
}

if (!win && process.env.CLEW_TOOLS_POSIX !== '1') {
  console.log('[tools] macOS/Linux tools are not built yet (no machine to test them on); CLEW_TOOLS_POSIX=1 tries.');
  process.exit(0);
}

const source = await toolsSource();
const version = readFileSync(join(source.dir, 'VERSION'), 'utf8').trim();
if (!existsSync(join(source.dir, 'native', 'src', 'core', 'control.cpp'))) {
  fail(
    `tools/ at ${source.ref} has no --control mode (native/src/core/control.cpp). ` +
      'Merge feat/desktop-control in the Clew repository, or build with TOOLS_REF=feat/desktop-control.',
  );
}
console.log(`[tools] building Clew tools ${version} from ${source.dir}`);
let built;
try {
  built = win ? await buildWindows(source.dir) : await buildPosix(source.dir);
} catch (err) {
  fail(`[tools] ${err.message}`);
}
for (const p of Object.values(built)) if (!existsSync(p)) fail(`[tools] expected ${p} after the build`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(built.server, join(OUT, win ? 'clew-audio-server.exe' : 'clew-audio-server'));
cpSync(built.analysis, join(OUT, 'clew-analysis-server'), { recursive: true });
writeFileSync(
  join(OUT, 'build-info.json'),
  `${JSON.stringify({ version, ref: source.ref, commit: source.commit, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`[tools] ✔ tools-dist/ (${version}, ${source.ref}${source.commit ? ` @ ${source.commit.slice(0, 12)}` : ''})`);
