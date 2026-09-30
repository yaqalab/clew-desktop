# Clew audio server

Lets Clew list and play the audio files in one folder of your computer, without asking for the
file with the browser's chooser each visit. Design and security model: `docs/22-audio-server.md`.

## Run it (development)

```
python tools/audio-server/clew_audio_server.py --folder D:\interviews
```

Python 3.10+, standard library only. The first start prints a **secret, once** — paste it into
Clew ("From server"). Later starts remember the folder and the secret's hash:

| Option | |
|---|---|
| `--folder <path>` | the folder to serve; remembered |
| `--port <n>` | default 47821 |
| `--allow-origin <url>` | a hosted Clew's origin (`https://…`); remembered. `http://localhost:*` and `127.0.0.1` are always allowed |
| `--reset-secret` | a new secret; the old one stops working |
| `--config <file>` | where settings are kept; default `%APPDATA%\clew-audio-server\config.json` |

It listens on 127.0.0.1 only.

## Run it (standalone, no Python needed)

```
powershell -ExecutionPolicy Bypass -File tools/audio-server/build_exe.ps1
```

builds `tools/audio-server/dist/clew-audio-server.exe` (about 8 MB) — copy that one file
anywhere and double-click it. Windows may warn on an unsigned program.

## Test

```
python -m unittest discover -s tools/audio-server -v
```

A real server on a free port and a real folder, no mocks.
