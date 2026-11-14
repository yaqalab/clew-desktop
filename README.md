# Clew Desktop

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

All of it is in [sites.config.json](sites.config.json). A third app is one more entry there.

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
  in the app; sign-in hosts on the `inAppPopupHosts` list ([desktop.config.json](desktop.config.json))
  open as in-app popups (they report back to their opener); everything else opens in the
  system browser.
- **Permissions** (camera, microphone, screen, clipboard, notifications, …) are granted only to
  the two bundled origins, a yaqatw frame inside Clew included. Screen sharing uses the macOS
  system picker, elsewhere a small window/screen chooser.
- **`window.alefaDesktop`** (preload, bundled origins only): `isDesktop`, `version`, `platform`,
  `buildInfo()`, `about()`.

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
| `npm test` | Unit tests (resolver, local server, certificate) |
| `npm run smoke` | Opens the app hidden and checks origin, local serving, iframe, network passthrough, CORS, redirects, permissions, service worker |
| `npm run dist` | `sources` → `build:sites` → electron-builder: the installer for this OS in `release/` |

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

Every build writes `sites/<name>/.build-info.json` (repo, ref, commit, local changes, time).
**Help → About** shows it for each app, and so does `window.alefaDesktop.buildInfo()`.

## Dev mode

`npm run dev` starts, for each app, its own dev server from its source folder, without editing
the app's repo:

- **Clew**: Vite, through [dev/vite-dev.mjs](dev/vite-dev.mjs): the app's own `vite.config.ts`,
  with the port fixed (5173) and HMR pointed at `ws://localhost:5173`.
- **yaqatw**: webpack-dev-server, through [dev/webpack-dev.cjs](dev/webpack-dev.cjs): the app's
  own `webpack.config.js` in development mode, served over plain http on port 3000 (no Office
  dev certificate needed) with HMR at `ws://localhost:3000/ws`.

The in-app server then forwards `https://clew.alefa.net/*` and `https://yaqatw.alefa.net/*` to
those dev servers, so the origin stays the real one. HMR goes straight to `localhost`
(WebSockets are not diverted). In dev, a 404 on an extension-less path is retried as `.html`,
as Pages would (`/embed` → `embed.html`). Electron restarts when anything in `src/` or the two
config files changes. Closing the window stops the dev servers.

Note that yaqatw's development build talks to a local signaling server (`ws://localhost:4444`),
as it does outside the desktop app.

