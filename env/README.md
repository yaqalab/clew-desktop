# Build-time settings

One file per app, `<name>.env`, copied to the app's `.env` before each build of a clone in
`.sources/`. These are the values the production builds get on Cloudflare Pages (client IDs,
API keys, signaling URLs). They end up in the shipped JavaScript anyway, but they are still
kept out of Git: everything in this folder except this README is ignored.

| File | App | Variables |
|---|---|---|
| `clew.env` | Clew (`yaqalab/tadidy`) | `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, `VITE_GOOGLE_APP_ID`, `VITE_DROPBOX_APP_KEY`, `VITE_DROPBOX_APP_KEY_FULL`, `VITE_BUNDLED_SIGNALING_URL`, `VITE_BUNDLED_SIGNALING_TOKEN`, `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`, `VITE_FEEDBACK_URL`, … |
| `yaqatw.env` | yaqatw | `GOOGLE_DRIVE_CLIENT_ID`, `DROPBOX_CLIENT_ID`, `ONEDRIVE_CLIENT_ID`, `YAQATW_BUNDLED_SIGNALING_URL`, `YAQATW_BUNDLED_SIGNALING_TOKEN` |

The simplest source is your own checkout: `cp ../ariadne/.env env/clew.env`. Elsewhere, point at
a file with `<NAME>_ENV_FILE=/path/to/file` or `sites.local.json` → `{ "clew": { "envFile": "…" } }`.
In CI, the workflow writes these files from secrets.
