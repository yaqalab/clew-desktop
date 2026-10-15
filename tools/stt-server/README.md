# clew-stt-server — dictation on this computer

> **TL;DR** The stt.alefa.net speech server (`docs/27`), run on the researcher's Windows PC
> with faster-whisper on the CPU instead of a Hailo-8 on the Pi (`docs/28`). Same protocol, so
> Clew talks to it unchanged. It listens on 127.0.0.1 only: the audio never leaves the computer.
> The audio server's tray starts and stops it (its **Dictation** tab); you rarely run it by hand.
> Copied from `C:\DEV\KUBERNETES\stt.alefa.net\stt` (`docs/provenance.md`); the Pi keeps its copy.

## What it adds to the Pi's server

- **Engine `whisper`:** faster-whisper, int8, Whisper's own 30 s window (a sentence is never cut).
- **Languages:** `?language=` on `/v1/listen` and `language` on `/v1/audio/transcriptions`;
  `/api/me` lists what the model knows (or only the one the tray fixed with `--language`).
- **Spelling hints:** `?prompt=` (and `prompt` for files), given to Whisper as its
  `initial_prompt`, ended like a sentence so Whisper keeps its punctuation. Capped at 400
  characters. The Pi's server ignores it.
- **`serve --local`:** binds 127.0.0.1, refuses a request whose `Host` is not this computer,
  accepts pages served from `http://localhost:*` and `http://127.0.0.1:*` besides `--origins`,
  and decodes with PyAV (FFmpeg's libraries, already a faster-whisper dependency), so no ffmpeg
  program is needed.
- **`serve --key-stdin`:** one key, `stt.<name>.<secret>`, read from the first line of stdin and
  held in memory. The tray makes it, seals it with DPAPI and hands it over at each start.
- **`download <model>` / `models`:** models live in `<models-dir>/<name>/`; the default folder
  is `%LOCALAPPDATA%\clew-stt\models`. A download writes `<name>.part` and renames it when
  complete, resumes file by file, and prints `total <bytes>`, then `progress N` once per percent,
  then `done <folder>` or `error <reason>`.

| Model | Size | Use | Source |
|---|---|---|---|
| `small` | 486 MB | live dictation, English and Japanese | `Systran/faster-whisper-small` |
| `large-v3-turbo` | 1.62 GB | files, Japanese; ~10 s per sentence | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` |
| `small.en` | 486 MB | English only; no better than `small` here (`28` §2) | `Systran/faster-whisper-small.en` |

## Run it by hand

```powershell
# once: a virtual environment with the server, faster-whisper and PyAV
python -m venv $env:TEMP\clew-stt-server-build
& $env:TEMP\clew-stt-server-build\Scripts\python.exe -m pip install -e "tools/stt-server[local,test]"

clew-stt-server download small
"stt.local.$(New-Guid)" | clew-stt-server serve --local --engine whisper --model small --port 47822 --key-stdin
clew-stt-server stream http://127.0.0.1:47822 talk.wav --key stt.local.… --language ja --prompt "協働学習, 第二言語"
```

## Build the Windows program

```powershell
powershell -ExecutionPolicy Bypass -File tools/stt-server/build_exe.ps1
```

Result: `tools/stt-server/dist/clew-stt-server/` (about 200 MB, `--onedir`). The native audio
server's installer ships it as an optional component. No model is inside.

**Dependencies** (`[local]`): `faster-whisper` (the engine; brings CTranslate2, tokenizers,
huggingface_hub) and `av` (decoding without ffmpeg). Left out of the build: `onnxruntime`
(faster-whisper's own VAD; the segmenter finds the speech), and everything the Hailo engine
imports.

## Tests

```powershell
& $env:TEMP\clew-stt-server-build\Scripts\python.exe -m pytest -q tools/stt-server
```

`tests/test_local.py` covers the local additions with the fake engine; the Pi's tests run
unchanged. A real model was checked by hand (`28` §7).
