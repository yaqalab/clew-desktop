# Security

Clew Desktop holds researchers' data: interview recordings, transcripts, notes and the keys to
encrypted vaults. A weakness in it can expose people who took part in a study, so please report
one privately.

## Reporting a problem

Use **[Report a vulnerability](https://github.com/yaqalab/clew-desktop/security/advisories/new)**
(this repository's Security tab). Only the maintainers see the report. Please include what an
attacker could reach and how, the version (**Help › About Clew**), and the steps to reproduce.

Please do not open a public issue, and do not include anyone's real research data.

We reply as soon as we can, and say when a fix is released. If you wish, the release notes credit
you.

## What is covered

- The app in this repository: its window, the local server that serves Clew and yaqatw, the
  local API for programs on this computer (`127.0.0.1`), Yaqatw for Word, the updates of the app
  and of the sites, the installer and uninstaller.
- Clew's local tools as the app ships and runs them.

Clew and yaqatw themselves run inside the app; a problem in them is welcome here too, and is
passed on.

## Versions

Only the latest release is fixed. The app updates itself, so **Settings › General › Updates**
shows whether you have it.

## What the app protects, and what it does not

The README's [Your data on this computer](README.md#your-data-on-this-computer) says what stays on
the computer, what is encrypted and what is not. A report that something listed there as encrypted
is readable without its passphrase is exactly what we want to hear about.
