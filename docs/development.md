# Clew Desktop: development

How the app is built and how it works inside. For installing and using it, see the
[README](../README.md).

Clew and yaqatw as one installable desktop app (Electron). Both apps run **under their real
production origins** (`https://clew.alefa.net`, `https://yaqatw.alefa.net`) but are served from
files bundled in the app, so CORS rules, origin-restricted API keys and OAuth "authorized
JavaScript origins" keep working unchanged, offline included.

This repo owns the whole pipeline: it fetches both apps' sources, builds them, embeds their
output and packages the installer. Nothing has to be checked out by hand.

| App | Repo | Ref | Build | Output |
|---|---|---|---|---|
| Clew | `yaqalab/tadidy` | `main` | `npm run build:hub` | `apps/hub/dist` |
| yaqatw | `yaqalab/yaqatw` | `main` | `npm run build` (webpack) | `addin` |

All of it is in [sites.config.json](../sites.config.json). A third app is one more entry there.

## How it works

```
 Electron window (session "persist:alefa")
   │  https://clew.alefa.net/…  ──┐  PAC: only the bundled hosts
   │  https://yaqatw.alefa.net/… ─┤        go to the in-app proxy
   │                              ▼
   │                   127.0.0.1:<random>  (src/local-server.js)
   │                     CONNECT host:443 → TLS with the app's own certificate
   │                     → src/pages-server.js  (Cloudflare Pages rules, from sites/<name>/)
   │                     http://<bundled host>  → 308 to https
   │
   │  every other host (Google, signaling, STUN/TURN, CDNs, other *.alefa.net) ──► DIRECT
   ▼  (or the system proxy): ordinary Chromium networking, WebSockets and WebRTC included
```

- **Only the two hosts are diverted.** The session's proxy setting is a PAC script that sends
  `clew.alefa.net` and `yaqatw.alefa.net` to a loopback proxy inside the app; every other host
  gets the system's proxy setting (resolved at start-up) or goes direct. Origin, Referer, CORS,
  cookies and redirects therefore behave exactly as in Chrome.
- **The certificate** for the two names is generated on first run (`userData/tls/`, 825 days,
  renewed automatically) and accepted **only inside the app's session, only for those two
  hostnames, and only that exact certificate**. Nothing is added to the system trust store.
- **`src/pages-server.js`** answers like Cloudflare Pages: clean URLs and their 308 redirects,
  nearest `404.html` or SPA fallback, `_redirects` (splats, placeholders, 301/302/303/307/308,
  200 rewrites), `_headers` (joining, `!` detach, absolute-URL rules), Pages' default headers,
  ETag/304, HEAD, single `Range` requests (206), case-sensitive paths and path-traversal
  protection. The top of the file lists each rule and where it comes from.
- **Window security**: `contextIsolation`, `sandbox`, no Node integration. Bundled hosts open
  in the app; sign-in hosts on the `inAppPopupHosts` list ([desktop.config.json](../desktop.config.json))
  open as in-app popups (they report back to their opener); everything else opens in the
  system browser.
- **Permissions** (camera, microphone, screen, clipboard, notifications, …) are granted only to
  the two bundled origins, a yaqatw frame inside Clew included. Screen sharing uses the macOS
  system picker, elsewhere a small window/screen chooser.
- **`window.alefaDesktop`** (preload, bundled origins only): `isDesktop`, `version`, `platform`,
  `buildInfo()`, `about()`, `onBeforeQuit(fn)`.
- **Quitting waits for unsaved work.** Before the app quits, restarts for an update or reloads a
  page, it asks each app page to finish what it registered with `onBeforeQuit` and waits, five
  seconds at most ([src/settle.js](../src/settle.js)). Clew writes out the edits it still holds
  there, so the last words typed are not lost to Quit.
- **`window.alefaDesktop.folder`** (Clew's origin only, checked again in the main process on
  every call): one folder on this computer, `Documents\Clew`, where Clew keeps an encrypted copy
  of each vault beside its cloud (Clew's `docs/44`). `root()`, `list(dir, { recursive })`,
  `read(path)`, `write(path, bytes)` (whole or not at all), `remove(path)`, `reveal(path)`.
  Paths are relative and `/`-separated; `..`, absolute paths, drives, backslashes and links
  leading out are refused ([src/folder.js](../src/folder.js)). `CLEW_FOLDER_ROOT` points it
  elsewhere; a smoke run uses a throwaway folder.
- **`window.alefaDesktop.db`** (any bundled origin; absent when the database cannot load, so a
  page checks for it and otherwise works as on the web): encrypted SQLite databases (SQLCipher 4
  format, through `better-sqlite3-multiple-ciphers`). Each site has its own folder,
  `userData/db/<host>/`, one file per database, `<name>.db` (`a-z`, `0-9`, `_`, `-`). The
  calling frame's origin picks the folder, checked in the main process on every call, so a
  yaqatw frame inside Clew gets yaqatw's databases. The page brings the key: 32 bytes, held only
  while the database is open; the app stores none.
  - `info()`, `list()`, `open(name, key)` (creates it the first time) gives a handle with
    `query(sql, params)`, `run(sql, params)`, `batch([{ sql, params }])` (one transaction, all
    or nothing), `rekey(key)` and `close()`; `remove(name)` deletes a closed database.
  - Only the window that opened a database may use it, until it closes it, reloads or
    navigates away; the last one to let go closes it. Opening an open database checks the key.
  - Refused before SQLite sees them ([src/db/guard.js](../src/db/guard.js)): ATTACH, DETACH,
    VACUUM, BEGIN/COMMIT/ROLLBACK/SAVEPOINT (`batch` is the transaction), and every PRAGMA but
    a short read-only list plus `user_version` and `foreign_keys`. The cipher library acts on
    `PRAGMA key`/`rekey` while preparing a statement, so the text is checked first; SQLite's
    compiled program is checked second.
  - Errors start with a code (`wrong-key: …`) because only an error's message crosses the
    bridge; `db.codeOf(err)` gives it.
  - The databases live in a utility process ([src/db/worker.js](../src/db/worker.js)); quitting
    closes them after the pages have settled. A smoke run uses a throwaway folder.

## Data on the user's computer

What the app stores and what is encrypted is in the README's
[Your data on this computer](../README.md#your-data-on-this-computer).

## Setup

Node 22 (Clew wants ≥ 20.19, yaqatw builds on 20 or 22) and Git with access to both private
repos (your usual credentials locally; `GIT_TOKEN` in CI).

```sh
npm install
cp ../ariadne/.env env/clew.env          # build settings: see env/README.md
cp ../yaqatw/.env  env/yaqatw.env
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run sources` | Clone or update both apps into `.sources/<name>/` at their configured ref (shallow) |
| `npm run build:sites` | For each app: `.env` from `env/`, `npm ci`, its build, output copied to `sites/<name>/` with `.build-info.json` |
| `npm start` | Run the app against the already-built `sites/` |
| `npm run dev` | Each app's dev server with hot reload, behind the real origins, then Electron |
| `npm run build:tools` | Builds Clew's local tools (audio server, analysis) from the Clew source into `tools-dist/` |
| `npm test` | Unit tests (resolver, local server, certificate, tools engine, dictation install, site updates) |
| `npm run smoke` | Opens the app hidden and checks origin, local serving, iframe, network passthrough, CORS, redirects, permissions, service worker (`CLEW_SMOKE_TOOLS=1`: the tools, tray and settings window too) |
| `npm run dist` | `sources` → `build:sites` → `build:tools` → electron-builder: the installer for this OS in `release/` |
| `npm run package:dictation` | Packs a built dictation server for the clew-tools release (see below) |

`npm run build:sites -- clew` builds one app; `--install` forces `npm ci` in a local checkout, `--no-install` skips it wherever `node_modules` exists (e.g. while `npm run dev` is using it).

### Using your own checkouts

To build or develop against the checkouts you already work in, instead of `.sources/`:

```sh
CLEW_PATH=../ariadne YAQATW_PATH=../../MSOFFICE/yaqatw npm run dev
```

or, permanently, a `sites.local.json` (ignored by Git):

```json
{
  "clew": { "path": "../ariadne" },
  "yaqatw": { "path": "C:/DEV/MSOFFICE/yaqatw" }
}
```

A local checkout is never cloned over or cleaned. It builds with its own `.env`, and `npm ci`
runs there only if it has no `node_modules` yet (or with `--install`). `<NAME>_REF` overrides a
ref (e.g. `YAQATW_REF=v3.0 npm run sources`).

### Traceability

Every build writes `sites/<name>/.build-info.json` (repo, ref, commit, its date, local changes,
time). **Help → About** shows it for each app (and whether it came with the installer or as an
update), and so does `window.alefaDesktop.buildInfo()`.

## Site updates (between installers)

Clew and yaqatw change far more often than the app around them, so the installed app also picks
up their newer builds by itself, **straight from the live sites** ([src/site-updates.js](../src/site-updates.js)):

1. **Cloudflare Pages builds each site on every push to `main`**, as before. The build now ends
   with `scripts/desktop-package.mjs` in each app's repo (npm's `postbuild:hub` in Clew,
   `postbuild` in yaqatw). On Cloudflare (`CF_PAGES=1`), for `main` only, it adds to the
   deployed site:
   - `/desktop/<name>-site-<commit12>.part1…N`: the whole output, with its `.build-info.json`,
     as one `.tar.gz` cut in parts of at most 20 MiB (Cloudflare Pages refuses files over
     25 MiB; today each site is one part, 17–20 MB);
   - `/desktop/version.json`: commit, commit date, size, SHA-256, the parts, `minDesktop`.

   Local builds, this repo's included, are unchanged.
2. **The app** reads `https://<host>/desktop/version.json` 15 s after start, then every 4 hours
   (`siteUpdates` in [desktop.config.json](../desktop.config.json)), through the default session,
   which is not diverted to the bundled files. It takes a build only if it names that site, is
   newer than what the app has (commit date) and allows this app version; the part addresses are
   built from the site and commit, and every part and the whole must match their size and
   SHA-256. It unpacks into `userData/site-updates/<name>/`.
3. **It switches at the next start** (a running page never has its files swapped underneath it);
   **Restart to update** appears in the tray and the Help menu meanwhile. **Settings › General ›
   Updates** shows which build of each site is running and what is waiting, and has **Check for
   updates** (also in the Help menu). A downloaded build is
   used only while it is newer than the installer's own, so a newer installer wins.

The trust is the site's own: the app runs what `clew.alefa.net` serves, as a browser does. No
token, secret or CI is involved. `DESKTOP_MIN_VERSION`, set in a Cloudflare project's
environment variables, marks builds that need a newer app (for a site that starts using
something new in `window.alefaDesktop`).

Updates are off in development and smoke runs; `CLEW_SITE_UPDATES=1` turns them on in a
development run, and `CLEW_SITE_UPDATES_BASE=<url>` reads `<url>/<name>/desktop/` instead of
the live sites.

## App updates and releases

The app updates itself from this repository's GitHub releases ([src/app-update.js](../src/app-update.js),
`electron-updater`). `build.publish` in `package.json` names the repository; electron-builder
writes it into the installed app (`resources/app-update.yml`) and writes `latest.yml` beside the
installer.

- The installed app checks 30 s after start, then with the site updates (every 4 hours), and on
  **Check for updates**. A newer release is downloaded in the background (only the changed
  blocks, from the old installer's `.blockmap`) and checked against the SHA-512 in `latest.yml`.
- **Restart to update** settles the pages and stops the tools first, as Quit does, then runs the
  installer silently and starts the new version. Quitting installs it without starting again.
- Off in development and smoke runs; `CLEW_APP_UPDATES=0` turns it off in an installed app,
  `CLEW_APP_UPDATES_URL=<url>` reads `<url>/latest.yml` instead of GitHub (a local test).
- The installer is unsigned, so the updater checks the SHA-512 only, not a publisher.
- A private repository's releases cannot be read without a token: the check then fails quietly
  (Settings shows "no release found").

**Releasing** (Windows):

1. Bump `version` in `package.json` and merge to `main`.
2. `npm run dist`: `release/Clew-Setup-<version>.exe`, its `.blockmap` and `latest.yml`.
3. `gh release create v<version> --title "Clew <version>" --notes-file <notes>` with the three
   files. All three are needed: `latest.yml` is what installed apps read, the `.blockmap` makes
   the next update a partial download.

## Dev mode

`npm run dev` starts, for each app, its own dev server from its source folder, without editing
the app's repo:

- **Clew**: Vite, through [dev/vite-dev.mjs](../dev/vite-dev.mjs): the app's own `vite.config.ts`,
  with the port fixed (5173) and HMR pointed at `ws://localhost:5173`.
- **yaqatw**: webpack-dev-server, through [dev/webpack-dev.cjs](../dev/webpack-dev.cjs): the app's
  own `webpack.config.js` in development mode, served over plain http on port 3000 (no Office
  dev certificate needed) with HMR at `ws://localhost:3000/ws`.

The in-app server then forwards `https://clew.alefa.net/*` and `https://yaqatw.alefa.net/*` to
those dev servers, so the origin stays the real one. HMR goes straight to `localhost`
(WebSockets are not diverted). In dev, a 404 on an extension-less path is retried as `.html`,
as Pages would (`/embed` → `embed.html`). Electron restarts when anything in `src/` or the two
config files changes. Closing the window stops the dev servers.

Note that yaqatw's development build talks to a local signaling server (`ws://localhost:4444`),
as it does outside the desktop app.

## Clew's local tools (audio server, dictation, analysis)

The desktop app includes what used to be the separate "Clew tools" download: **one install, one
tray icon, one settings window.**

- **The audio server** (`clew-audio-server`, C++, from the Clew repository's `tools/native`) runs
  hidden as a child of the app: `clew-audio-server --control`, driven over its stdin/stdout, one
  JSON object per line (its `core/control.h` documents the commands). It ends when its stdin
  closes, so it never outlives the app. [src/tools/engine.js](../src/tools/engine.js) is the client.
- **Analysis** (`clew-analysis-server`, ~19 MB) ships beside it and is started by it.
- **Dictation** (`clew-stt-server`, ~200 MB) is **downloaded on demand**, the first time someone
  presses *Install dictation* in Settings ([src/tools/dictation-install.js](../src/tools/dictation-install.js)):
  `dictation.json` from the latest public `yaqalab/clew-tools` release, the package address built
  from its version (never read from the file), size and SHA-256 checked, unpacked into
  `userData/dictation/<version>/`. When Settings opens, a newer version in the latest release is offered
  (**Update dictation**): the running speech server stops, the new one replaces it, and it starts
  again if it was on (2026-11-16; clew-tools 1.4 added the words Clew places training cuts by).
- **Same settings as the standalone tools**: `clew-audio-server/settings.json` in the user's config
  folder, so folders, the secret Clew already knows and both keys carry over. Clew in the window
  talks to `http://127.0.0.1:47821`, `:47822` and `:47823` exactly as the website does.
- **Tray**: a click opens Clew; the menu has the standalone tray's entries (copy the secret, audio
  folders, start/stop, dictation, analysis, start at login, quit). Closing Clew's window hides it;
  *Quit Clew* stops everything. The installed app starts at login from its first run (in the
  tray, `--hidden`); a development or test run never registers itself.
- **Settings window** ([src/tools/settings/](../src/tools/settings/)): Audio, Conversion, Dictation,
  Analysis, General (start at login, activity).

Building the tools needs, on Windows, Visual Studio or Build Tools with the C++ workload (CMake
and Ninja come with it) and Python 3.10+. Where they come from: `tools/` of the Clew source in
use, `TOOLS_REF=<ref>` (exported from the Clew repository with `git archive`; the checkout is not
touched) or `TOOLS_PATH=<dir>`. macOS and Linux: the C++ side is ported but has never been
compiled (`CLEW_TOOLS_POSIX=1` tries).

For development: `CLEW_STT_PROGRAM=<…/clew-stt-server.exe>` uses a dictation server you built,
`CLEW_TOOLS_CONFIG=<file>` another settings file, `CLEW_TOOLS_DIR=<dir>` other tool binaries.

**Publishing dictation** (once per release and system): build `tools/stt-server` (its
`build_exe.ps1`), then `npm run package:dictation`. It writes
`release-dictation/clew-stt-server-<version>-<platform>-<arch>.tar.gz` and adds it to
`release-dictation/dictation.json`; attach both to the `v<version>` release of
`yaqalab/clew-tools`. The package carries the dictation server's `THIRD-PARTY-NOTICES.txt` (its
GPL parts; Clew docs/32, section 2).
