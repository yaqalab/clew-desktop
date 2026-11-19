# Clew's local tools

Small programs that let [Clew](https://clew.alefa.net), a research workspace that runs in the
browser, use the recordings and computing power of **your own computer**. Nothing is uploaded:
Clew talks to them at `127.0.0.1`, which means "this computer". Clew Desktop ships them, starts
them and shows their settings; they used to be a separate download ("Clew tools").

| Program | Folder | What it does for Clew | How Clew Desktop ships it |
|---|---|---|---|
| **Audio server** | [native/](native/) | Plays and lists the interview recordings in folders you choose, so you don't pick the file again each visit | Built into the app (`resources/tools/`), run hidden with `--control` |
| **Dictation** (optional) | [stt-server/](stt-server/) | Speech to text with Whisper, on your computer: dictation while writing, transcription of recordings, voices told apart | Downloaded on demand from Settings › Dictation (about 200 MB) |
| **Analysis** (optional) | [analysis-server/](analysis-server/) | Runs Clew's survey analyses (regressions, exact and rank tests, reliability) in your own statistics program: [R](https://cran.r-project.org), a Conda Python, [PSPP](https://www.gnu.org/software/pspp) or SPSS | Built into the app (`resources/tools/`) |

## How Clew uses these programs

Clew is a web page: everything you write stays in your browser, encrypted, and syncs only to
your own Google Drive or Dropbox. A web page cannot read the folders on your disk by itself, so
for recordings, speech recognition and statistics it asks these programs, on your computer:

- **Audio:** Clew asks the audio server (`http://127.0.0.1:47821`) for the list of recordings and
  a link to play one. The audio goes from the program to your browser directly, inside your
  computer. Your recordings are never uploaded.
- **Dictation and transcription:** Clew sends your voice, or a recording, to the dictation server
  (`http://127.0.0.1:47822`) and gets the text back. Speech recognition runs on your processor.
  Nothing is sent to a speech service on the internet.
- **Analysis:** Clew sends the survey columns you chose and the forms its filters keep to the
  analysis engine (`http://127.0.0.1:47823`), which hands them to your own statistics program and
  sends the result tables back. Nothing goes to the internet, and nothing is written to disk on
  the way. Clew can only name an analysis the engine offers; it can never send code to run.

Each request from Clew carries the secret (audio) or the key (dictation, analysis) that Clew
Desktop gives it.

## What keeps them safe

These programs are built to do one narrow job and refuse everything else.

- **Only this computer.** All three listen on `127.0.0.1` only, so other computers on your network
  or the internet can't reach them. A request that names another host is refused, which stops a
  web page from reaching them through a disguised address.
- **Only Clew, and only with the secret.** Web pages other than Clew (clew.alefa.net, or a Clew
  running on this computer) are refused by the browser's own rules. Listing your recordings needs
  the secret; dictation and analysis each need their own key. Wrong guesses slow the server down.
- **Only your folders.** The audio server sends files from the folders you added (and their
  subfolders), and nothing else, however a request is written.
- **Play links expire.** A link to play a recording works for one file, for a few hours. It is
  signed with a key that exists only while the program runs.
- **Your recordings are never changed.** Formats browsers can't play are converted once to an mp3
  copy kept beside the recording, in a `.clew-converted` folder.
- **Little to find.** Nothing about your work is written to a log file.
- **Network connections.** Only a dictation model download from huggingface.co, when you ask for
  one. Clew Desktop itself downloads the dictation server from GitHub releases when you install
  or update dictation.

Each program's README has the details: [native/](native/README.md),
[stt-server/](stt-server/README.md), [analysis-server/](analysis-server/README.md).

## For developers

| Path | |
|---|---|
| [native/](native/) | The audio server: C++17, system APIs only, no third-party code |
| [stt-server/](stt-server/) | The dictation server: Python, faster-whisper, packed with PyInstaller (`build_exe.ps1` on Windows, `build_dist.sh` on macOS and Linux) |
| [analysis-server/](analysis-server/) | The analysis engine: Python standard library and adapters for R, Python, PSPP and SPSS, packed with PyInstaller |
| [VERSION](VERSION) | The tools' version, separate from the app's (see below) |
| [CHANGELOG.md](CHANGELOG.md) | Changes from version to version |

`npm run build:tools` (at the repository's root) builds the audio server and the analysis engine
into `tools-dist/`, which the app's installer ships. `npm run package:dictation` packs a built
dictation server, and `npm run smoke:dictation` checks one; `docs/development.md` has the whole
pipeline. Build and test instructions for each program are in its folder's README. The tests run
on GitHub for every push that changes them: `.github/workflows/tools-native.yml` (the audio server
on Linux and macOS) and `tools-python.yml` (analysis and dictation); `dictation.yml` builds the
dictation packages for macOS and Linux.

**Versions.** `VERSION` is the tools' own version: the programs report it (`--version`,
`/api/ping`) and the dictation packages are named after it. The app has its own version, and
its release notes say which tools version they carry. Never tag a tools version as `v*` here:
the app's updater reads those tags as app releases.

**The contract with Clew.** Clew, the web app, lives in another repository. What it relies on is
each server's `/api/ping` answer (`server`, `api`, `version`) and the requests behind it. A
change that breaks those raises the server's `api` number, and Clew must accept both the old and
the new `api` before a version of the app with the new one is released.

**Brand.** The audio server's icons are composed from a copy of Clew's brand favicons
(`native/res/brand/`); copy them again when the brand changes, then run `native/res/make_icons.py`.

Code comments sometimes refer to design notes as `docs/NN-…`: those notes belong to Clew's own
repository, which is not public; what they decided is described in the code beside them.

## Licence

The code in this folder is under the [MIT licence](LICENSE). The dictation package also contains
third-party software under its own licences, among them FFmpeg libraries and the x264 and x265
encoders (GPL-2.0-or-later) that come with PyAV. They are listed in `THIRD-PARTY-NOTICES.txt`,
inside the package beside the dictation server, together with where to get their source code. The
analysis engine packs Python's own library (PSF licence) and PyInstaller's bootloader (GPL with an
exception that allows this), listed in its own `THIRD-PARTY-NOTICES.txt`; R is not included: it is
your own installation. The audio server contains no third-party code.
