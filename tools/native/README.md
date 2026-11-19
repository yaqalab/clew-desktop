# Clew audio server (native)

Lets Clew list and play the audio files in your folders, without choosing the file again on each
visit and without uploading anything. A small program (about 0.6 MB on Windows) with no
third-party code: it needs no Python, and no ffmpeg on Windows.

Clew Desktop ships it and runs it hidden with `--control`: the app is then its only window, tray
icon and settings (Settings › Audio, Settings › Conversion), and the server never outlives the app.
Run without options on Windows, the program shows its own tray icon and settings window instead;
`--headless` runs it without any window (see [For developers](#for-developers)).

## Folders

Each project can keep its recordings in its own folder. Clew lists the files of every ticked folder,
each under the folder's name ("study-a/p01.mp3"). An **unticked** folder stays in the list with its
name, nothing in it is listed or played, and ticking it again brings everything back, links in Clew
included.

Two folders with the same last name ("…\Study A\audio", "…\Study B\audio") are shown as "audio" and
"audio 2", in the list's order. Removing a folder does not touch it or its recordings; a recording
linked from it plays again once it is added back. Recordings linked before there could be several
folders keep working while only one ticked folder has that file.

## Settings

| Setting | |
|---|---|
| Folders | the folders whose audio files Clew may list and play (subfolders too); ticked ones are served |
| Port | 47821 unless another program uses it |
| Play links last | how long one play link works (default 4 hours); Clew asks for a new one by itself |
| Other Clew addresses | a Clew hosted on the web; `https://clew.alefa.net` is there after a first start and can be removed; a Clew on this computer is always allowed |
| Secret | Show / Copy / New secret. A new secret stops the old one at once |
| Convert … | converts .wma, .amr and long variable-bit-rate .mp3 so every browser plays and seeks them |
| Prepare … in the background | converts .wma and .amr files as soon as Clew lists the folder, so they open at once. The file you open always goes first: preparing stops, waits, and picks up again afterwards |
| ffmpeg (optional) | on Windows, only used when Windows itself cannot convert a file; on macOS and Linux, the converter |
| Cache limit | converted copies are kept up to this size in each folder, the oldest removed first |

Settings live in `clew-audio-server/settings.json` in the user's configuration folder
(`%APPDATA%` on Windows). **Converted copies stay beside your recordings**, in a
`.clew-converted` folder inside the recording's own audio folder: they are as private as the
interviews, so they stay wherever you chose to keep those (an encrypted drive, a synced folder).
Clew never lists that folder and it cannot be asked for; it holds a README saying what it is, and
deleting it is safe (a copy is made again when needed). Copies are named by a hash, not by the
recording's name. Your original files are never changed.

## Formats

mp3, m4a, aac, wav, ogg, oga, opus, flac, weba, webm, mp4, 3gp, amr, wma. Browsers cannot play .wma
or .amr, and Firefox seeks badly in a long variable-bit-rate mp3, so those are **converted once** to
a 128 kbit/s mp3 (the first time takes a moment: a few seconds for an hour of speech).

On Windows the conversion uses **Windows' own codecs**: WMA (all versions, also WMA Voice), MP3,
AAC, FLAC, Opus and AMR-NB; there is no AMR-WB decoder. A file Windows cannot read is tried with
ffmpeg if one was chosen, else sent as it is. Windows "N" editions lack the codecs until the free
*Media Feature Pack* is installed. On macOS and Linux the conversion uses ffmpeg: the one chosen,
else one beside the program or on `PATH`.

## Safety

- **This computer only.** It listens on 127.0.0.1, never on the network, and refuses requests that
  name another host (a web page cannot reach it through a trick address). The port is held
  exclusively.
- **A secret.** Listing the folders and asking for a play link need the secret. It comes from the
  system's secure random generator. On Windows it is kept **encrypted for your Windows account**
  (DPAPI): another account, or the settings file copied elsewhere, cannot read it; copying it keeps
  it out of Windows' clipboard history. On macOS and Linux it is kept in the settings file, which
  only your account can read (mode 0600). Wrong guesses slow the server down. A secret made by the earlier Python
  audio server keeps working: this server checks it against the hash that server kept (scrypt, in
  its `config.json`), never a copy of the secret itself.
- **Play links** are signed for one file and a few hours, with a key that exists only while the
  program runs: quitting it revokes every link.
- **Only the folders.** Nothing outside them is listed or sent, however the request is written
  (`..`, other drives, links and junctions that lead out, hidden files, Windows device names,
  alternate data streams).
- **Only Clew.** Web pages other than a Clew on this computer and the addresses you add are refused.
- **On Windows, conversion runs in a sandbox:** a separate process at *low integrity* (it can read
  your files but write almost nowhere), inside a job object (one process, 1.5 GB of memory at most,
  30 minutes at most, no clipboard or desktop access), with exploit mitigations on (no injected or
  generated code, no DLLs from untrusted places). A damaged file that makes a codec misbehave cannot
  reach the server or your documents. On macOS and Linux, ffmpeg runs as a separate process with
  your account's rights, as any media player does (at the lowest priority for work done ahead).
- **Little to steal.** The activity list keeps method, path and status in memory only; never a
  link's signature, never the secret.

## For developers

```
tools\native\build.cmd                                  build + unit tests (Visual Studio 2022 C++ tools)
python -m unittest discover -s tools\native\test -v     the real program over HTTP
npm run build:tools                                     the program and the analysis engine, for the app
```

On macOS or Linux:

```
cmake -S tools/native -B tools/native/build -DCMAKE_BUILD_TYPE=Release && cmake --build tools/native/build
ctest --test-dir tools/native/build && python3 -m unittest discover -s tools/native/test -p test_native.py
```

`.github/workflows/tools-native.yml` builds and tests it on Linux and macOS on every push that
changes it.

`clew-audio-server --headless --folder <dir> [--folder <dir>…] [--folder-off <dir>] [--port n] …`
runs without a window (`--help` lists the options; they apply to that run only, and `--folder`
replaces the saved list for that run). `--control` is how Clew Desktop runs it: requests and events
as JSON lines on a pipe (`src/core/control.h`; the app's side is `src/tools/engine.js`).
`CLEW_AUDIO_LANG=ja` or `en` forces the Windows window's language.

| Folder | |
|---|---|
| `src/core/` | portable C++17: HTTP server, links, folder rules, mp3 tags, settings, conversion cache, headless and control modes |
| `src/win/` | Windows: DPAPI, Media Foundation conversion, the sandbox, tray icon and window, en/ja strings |
| `src/posix/` | macOS and Linux: no window, ffmpeg-only conversion, secret in the 0600 settings file |
| `res/` | dialog, manifest, icons (`make_icons.py` composes them from `res/brand/`, a copy of Clew's brand favicons: copy them again when the brand changes) |
| `test/` | `unit_tests.cpp` (SHA-256/HMAC, PBKDF2 and scrypt vectors, paths, ranges, JSON, settings) and `test_native.py` |

No third-party code and no libraries beyond what the system ships. The version is written once, in
`tools/VERSION`: CMake makes `version.h` from it (the program, `res/app.rc`).

The Windows tray mode still carries the update check of the standalone tools (its Updates tab,
`src/core/update.*`, `src/win/update_win.*`), which asks the former `yaqalab/clew-tools`
releases; Clew Desktop never shows it.
