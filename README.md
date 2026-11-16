# Clew Desktop

[Clew](https://clew.alefa.net) and [yaqatw](https://yaqatw.alefa.net) as one app on your
computer. It is the same Clew and yaqatw you use in the browser, with your accounts, clouds and
calls working as they do there, plus:

- **Works offline.** Both apps are inside the installer, so they open without a connection.
- **Clew's local tools are included**: the audio server, dictation and analysis that used to be
  a separate "Clew tools" download. One install, one tray icon, one settings window.
- **A copy of each vault in `Documents\Clew`**, encrypted, beside its cloud.
- **Nothing typed is lost to Quit**: the app waits for Clew to save before it closes.
- **Clew and yaqatw keep themselves up to date** without a new installer.

## Install

**Windows 10 and 11.** Download `Clew Setup <version>.exe` from the
[Releases](https://github.com/yaqalab/clew-desktop/releases) page and run it. It installs for
your account only and needs no administrator rights.

The installer is not signed yet, so Windows may show *Windows protected your PC* the first time.
Choose **More info → Run anyway**.

macOS and Linux builds are not available yet.

The app starts with Windows from then on, in the system tray (turn this off with **Start at
login** in the tray menu or in Settings › General).

## Using it

- **Clew** opens in the window. yaqatw opens inside Clew, as it does on the web.
- **Signing in** to Dropbox or Microsoft opens a small sign-in window inside the app. Links to
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
  - *General*: start at login, and which version of Clew and yaqatw is running.
- **Zoom**: Ctrl+= / Ctrl+− / Ctrl+0, or Ctrl + mouse wheel.
- **Help › About** shows the app's version and the build of Clew and yaqatw inside it.

If you already used the standalone Clew tools, their settings carry over: same folders, same
secret, same keys. Uninstall the standalone tools: both use the same ports, so only one can run.

## Updates

**Clew and yaqatw** update by themselves. The app looks for a newer build a few seconds after it
starts and then every four hours, downloads it in the background and checks it. It is used the
next time the app starts; until then **Restart to update** appears in the tray menu and the Help
menu. **Help › Check for updates…** and **Settings › General** look right away.

**The app itself** (the window, the tray, the local tools) does not update by itself yet:
install a newer `Clew Setup` over the old one. Your data stays.

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
  cloud too. It is encrypted, but its names are readable. Turn the copy off per vault in Clew's
  Settings if that is not wanted.
- **yaqatw keeps its codes and coded passages unencrypted** in the app's data folder. Clew cannot
  lock or wipe them, and locking a vault does not hide them. Use a computer account only you
  can open.
- **Removing a vault in Clew does not delete its folder copy**, and **uninstalling the app keeps
  both the data folder and `Documents\Clew`**. On a shared or borrowed computer, delete those two
  folders yourself when you are done.
- **Quit waits for what you are typing** (a few seconds at most). Switching the computer off
  without quitting does not: lock the vault or quit first.
- **A vault that is only on this computer is one disk failure from gone.** Connect a cloud in
  Clew, or keep the folder copy on.

## Privacy and security

- The app talks to the same services as Clew and yaqatw in the browser, and nothing else of its
  own, apart from looking for updates on `clew.alefa.net`, `yaqatw.alefa.net` and, for
  dictation, the [clew-tools releases](https://github.com/yaqalab/clew-tools/releases) on GitHub.
- Camera, microphone, screen sharing and notifications are allowed to Clew and yaqatw only.
- The app makes its own certificate for `clew.alefa.net` and `yaqatw.alefa.net` and trusts it
  only inside its own window. Nothing is added to your computer's certificate store.

## Uninstall

Uninstall **Clew** from Windows Settings › Apps. Your data stays (see above); delete
`%APPDATA%\Clew` and `Documents\Clew` yourself if you want it gone.

## For developers

How the app works and how to build it:
[docs/development.md](docs/development.md).
