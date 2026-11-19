# Clew Desktop

*Clew: a thread through your research.*

[Clew](https://clew.alefa.net) and [yaqatw](https://yaqatw.alefa.net) as one app on your
computer. It is the same Clew and yaqatw you use in the browser, with your accounts, clouds and
calls working as they do there, plus:

- **Works offline.** Both apps are inside the installer, so they open without a connection.
- **Clew's local tools are included**: the audio server, dictation and analysis that used to be
  a separate "Clew tools" download. One install, one tray icon, one settings window.
- **A copy of each vault in `Documents\Clew`**, encrypted, beside its cloud.
- **Nothing typed is lost to Quit**: the app waits for Clew to save before it closes.
- **Clew and yaqatw keep themselves up to date** without a new installer.

> **Beta.** Clew Desktop has not been fully tested yet. Keep a copy of your work in a vault's
> cloud or elsewhere, and report problems in this repository's
> [Issues](https://github.com/yaqalab/clew-desktop/issues).

## Install

**Windows 10 and 11.** Download `Clew-Setup-<version>.exe` from the
[Releases](https://github.com/yaqalab/clew-desktop/releases) page and run it. It installs for
your account only and needs no administrator rights.

The installer is not signed, so Windows may show *Windows protected your PC* the first time.
Choose **More info → Run anyway**.

The app is for Windows only.

The app starts with Windows from then on, in the system tray (turn this off with **Start at
login** in the tray menu or in Settings › General).

## Using it

- **Clew** opens in the window. yaqatw opens inside Clew, as it does on the web.
- **Signing in** to Google, Dropbox or Microsoft opens a small sign-in window inside the app. Links to
  other sites open in your usual browser.
- **The tray icon**: click it to open Clew. Its menu starts and stops the audio server,
  dictation and analysis, copies the secret and keys Clew asks for, opens the audio folders, and
  has **Quit Clew**.
- **Closing the window does not quit.** The tools keep running in the tray. To stop everything,
  use **Quit Clew** in the tray menu or **File › Quit** (Ctrl+Q).
- **Settings** (**File › Settings…**, Ctrl+, or the tray menu):
  - *Audio*: the audio server, its folders, the secret and the port;
  - *Conversion*: where FFmpeg is;
  - *Dictation*: **Install dictation** downloads the speech server (about 200 MB) the first
    time; then the model, the language and the key;
  - *Analysis*: the statistics program and your own R scripts;
  - *General*: start at login, and which version of the app, Clew and yaqatw is running.
- **Zoom**: Ctrl+= / Ctrl+− / Ctrl+0, or Ctrl + mouse wheel.
- **Help › About** shows the app's version and the build of Clew and yaqatw inside it.

If you already used the standalone Clew tools, their settings carry over: same folders, same
secret, same keys. Uninstall the standalone tools: both use the same ports, so only one can run.

## Updates

Everything updates by itself. The app looks for newer versions a few seconds after it starts and
then every four hours, downloads them in the background and checks them. **Restart to update**
then appears in the tray menu and the Help menu. **Help › Check for updates…** and
**Settings › General** look right away.

- **Clew and yaqatw** come from their websites. A new build is used the next time the app starts.
- **The app itself** (the window, the tray, the local tools) comes from this project's
  [Releases](https://github.com/yaqalab/clew-desktop/releases). It is installed when you choose
  **Restart to update**, after Clew has saved what you were typing, or else when you quit. Your
  data stays.

**Dictation**: when a newer speech server is out, Settings › Dictation offers **Update
dictation**.

## Your data on this computer

Clew is used for research with people in it. What the app keeps on this computer, and what
protects it:

| Where | What | Encrypted |
|---|---|---|
| The app's data folder (`%APPDATA%\Clew` on Windows) | Clew's vaults, yaqatw's own storage, downloaded updates, settings | Clew's vaults: yes, with the vault's passphrase. **yaqatw's storage: no** |
| `Documents\Clew\<vault name>\` | A copy of each vault beside its cloud (on by default; Settings › Copy on this computer in Clew) | Contents: yes. **Folder and file names: no**: they carry the vault's name and the titles of transcripts, papers and files |

Worth knowing before you rely on it:

- **`Documents` is often synced by OneDrive or iCloud Drive.** The vault copy then reaches that
  cloud too. It is encrypted, but its names are readable. The app says so once when it finds
  the folder in OneDrive, iCloud Drive, Dropbox or Google Drive. Move the folder elsewhere in
  **Settings › General › Clew's folder**, or turn the copy off per vault in Clew's Settings.
- **yaqatw keeps its codes and coded passages unencrypted** in the app's data folder. Clew cannot
  lock or wipe them, and locking a vault does not hide them. Use a computer account only you
  can open.
- **Removing a vault in Clew does not delete its folder copy**, and **uninstalling the app keeps
  both the data folder and `Documents\Clew`**. On a shared or borrowed computer, use
  **Settings › General › Remove all Clew data** when you are done: it lists
  what goes, offers an encrypted backup first (a zip protected by a passphrase, which 7-Zip and
  most archivers open), checks the backup, then closes Clew and deletes the folders.
- **Quit waits for what you are typing** (a few seconds at most). Switching the computer off
  without quitting does not: lock the vault or quit first.
- **A vault that is only on this computer is one disk failure from gone.** Connect a cloud in
  Clew, or keep the folder copy on.

## Privacy and security

- The app talks to the same services as Clew and yaqatw in the browser, and nothing else of its
  own, apart from looking for updates on `clew.alefa.net`, `yaqatw.alefa.net`, this project's
  releases on GitHub and, for dictation, the
  [clew-tools releases](https://github.com/yaqalab/clew-tools/releases).
- Camera, microphone, screen sharing and notifications are allowed to Clew and yaqatw only.
- The app makes its own certificate for `clew.alefa.net` and `yaqatw.alefa.net` and trusts it
  only inside its own window. Nothing is added to your computer's certificate store.

## Uninstall

Uninstall **Clew** from Windows Settings › Apps. Yaqatw for Word and the start at sign-in go
with it (close Word first). Your data stays (see above). To remove it too,
use **Settings › General › Remove all Clew data** before uninstalling, or
delete `%APPDATA%\Clew` and `Documents\Clew` yourself.

## Licence

The code in this repository is under the [MIT licence](LICENSE). The installer also carries
software under its own terms: Electron and Chromium (their notices ship beside `Clew.exe`),
Clew (ISC), Clew's local tools (MIT, with the third-party notices in their folders) and yaqatw
(proprietary, © its authors).

## For developers

How the app works and how to build it:
[docs/development.md](docs/development.md).
