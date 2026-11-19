"""Writes THIRD-PARTY-NOTICES.txt for a build of the dictation server (Windows, macOS, Linux).

    python third_party_notices.py <output file>

Run with the build environment's Python (build_exe.ps1 and build_dist.sh do): it walks what
`alefa-stt[local]` installs, package by package, and copies each one's licence text from its
metadata. PyAV's wheel also carries FFmpeg and the libraries FFmpeg was built with, and other
wheels carry native libraries too; those are listed by name, from each wheel's file list, with
where their source or licence is, since they are not Python packages.
"""

from __future__ import annotations

import importlib.metadata as md
import re
import sys
import textwrap
from pathlib import Path

from packaging.requirements import Requirement

ROOT = "alefa-stt"
EXTRAS = {"local"}
# Left out of the build by build_exe.ps1 / build_dist.sh (--exclude-module), so not shipped.
EXCLUDED = {"onnxruntime", "hf-xet"}
CONTACT = "alefa-support@googlegroups.com"
SYSTEM = {"win32": "Windows", "darwin": "macOS"}.get(sys.platform, "Linux")

# A shared library, not a Python extension module (those are the packages' own code).
NATIVE = re.compile(r"\.(dll|dylib)$|\.so(\.\d+)*$", re.IGNORECASE)
EXTENSION = re.compile(r"\.(cpython-|abi3\.|pyd$)", re.IGNORECASE)
# The hash the wheel repair tools (delvewheel, auditwheel) add to a bundled library's name.
REPAIR_HASH = re.compile(r"-[0-9a-f]{8,32}(?=\.)")

# Its first two paragraphs are filled to the page width once the names are in (ffmpeg_section).
FFMPEG_NOTE = """\
PyAV's wheel for {system} (av {av}) ships FFmpeg's libraries (avcodec, avformat, avutil, \
swresample, swscale, avfilter, avdevice) and the libraries that FFmpeg build links to. The \
dictation server uses them only to decode audio. FFmpeg reports its licence as: \
"{ffmpeg_licence}". Among the bundled libraries, x264 and x265 are under the GNU General Public \
License, version 2 or later; the others under the LGPL (such as libiconv), BSD-style licences \
(such as libvpx, dav1d, SVT-AV1, libwebp, libopus) or the zlib licence (zlib).{system_note}

Libraries in this build: {libs}

Source code:
  - how that FFmpeg build is made, with the source of each library:
    https://github.com/PyAV-Org/pyav-ffmpeg
  - PyAV: https://github.com/PyAV-Org/PyAV (tag v{av})
  - FFmpeg: https://ffmpeg.org/download.html
  - x264: https://code.videolan.org/videolan/x264
  - x265: https://bitbucket.org/multicoreware/x265_git

Written offer: for three years after each release of this program, the complete corresponding
source code of the GPL- and LGPL-licensed components above is sent to anyone who asks at
{contact}, for no more than the cost of sending it.

The GNU GPL v2: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
The GNU LGPL v2.1: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt
The GNU LGPL v3: https://www.gnu.org/licenses/lgpl-3.0.txt
"""

SYSTEM_NOTE = {
    "Windows": " The MinGW runtime (libgcc, libstdc++, libwinpthread) is under the GCC Runtime "
               "Library Exception.",
    "macOS": "",
    "Linux": (
        " The Linux wheels also carry system libraries of the image they were built in "
        "(manylinux, AlmaLinux or CentOS), each under its own licence; their source: "
        "https://vault.almalinux.org/ and https://vault.centos.org/."
    ),
}

NATIVE_NOTE = """\
Native libraries inside Python packages (their licences are in the package's own texts below,
except where named here):
{native}
"""

# Libraries a wheel carries that are not that project's own work: (name pattern, note).
KNOWN = [
    (r"cudnn", "NVIDIA cuDNN, redistributed under the NVIDIA cuDNN Software License Agreement, "
               "https://docs.nvidia.com/deeplearning/cudnn/latest/reference/eula.html"),
    (r"iomp5", "the Intel OpenMP runtime, redistributed under the Intel Simplified Software License, "
               "https://www.intel.com/content/www/us/en/developer/articles/license/end-user-license-agreement.html"),
    (r"^libgomp", "the GNU OpenMP runtime (GCC), GPL-3.0 with the GCC Runtime Library Exception, "
                  "https://www.gnu.org/licenses/gcc-exception-3.1.html"),
    (r"^libomp", "the LLVM OpenMP runtime, Apache-2.0 with LLVM exceptions, "
                 "https://github.com/llvm/llvm-project/blob/main/openmp/LICENSE.TXT"),
    (r"onnxruntime", "ONNX Runtime, MIT licence, https://github.com/microsoft/onnxruntime"),
    (r"^libasound", "ALSA's library (alsa-lib), LGPL-2.1-or-later, https://github.com/alsa-project/alsa-lib"),
]

LICENCE_FILE = re.compile(r"(^|/)(LICEN[CS]E|COPYING|NOTICE)[^/]*$", re.IGNORECASE)


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def walk() -> list[md.Distribution]:
    seen: dict[str, md.Distribution] = {}
    queue: list[tuple[str, set[str]]] = [(ROOT, EXTRAS)]
    while queue:
        name, extras = queue.pop()
        try:
            dist = md.distribution(name)
        except md.PackageNotFoundError:
            continue  # an optional dependency not installed on this system
        key = norm(dist.metadata["Name"])
        if key in seen and not extras:
            continue
        seen[key] = dist
        for line in dist.requires or []:
            req = Requirement(line)
            envs = [{"extra": e} for e in extras] or [{"extra": ""}]
            if req.marker is None or any(req.marker.evaluate(env) for env in envs):
                queue.append((req.name, set(req.extras)))
    return sorted(
        (d for k, d in seen.items() if k != norm(ROOT) and k not in EXCLUDED),
        key=lambda d: norm(d.metadata["Name"]),
    )


def licence_texts(dist: md.Distribution) -> list[tuple[str, str]]:
    out = []
    for f in dist.files or []:
        path = str(f).replace("\\", "/")
        if ".dist-info/" in path and LICENCE_FILE.search(path):
            try:
                out.append((path.rsplit("/", 1)[-1], Path(f.locate()).read_text("utf-8", "replace")))
            except OSError:
                pass
    return out


def licence_name(dist: md.Distribution) -> str:
    m = dist.metadata
    if m.get("License-Expression"):
        return m["License-Expression"]
    classifiers = [c.split("::")[-1].strip() for c in m.get_all("Classifier") or [] if c.startswith("License")]
    if classifiers:
        return ", ".join(classifiers)
    first = (m.get("License") or "").strip().splitlines()
    return first[0][:80] if first else "see the licence text below"


def native_libs(package: str) -> list[Path]:
    """The shared libraries a package installed, from its file list (wherever the wheel put
    them: av.libs, av/.dylibs, sherpa_onnx/lib...), skipping import libraries and the
    package's own extension modules."""
    try:
        dist = md.distribution(package)
    except md.PackageNotFoundError:
        return []
    out = []
    for f in dist.files or []:
        name = str(f).replace("\\", "/").rsplit("/", 1)[-1]
        if NATIVE.search(name) and not EXTENSION.search(name) and not str(f).startswith(".."):
            out.append(Path(f.locate()))
    return out


def short(path: Path) -> str:
    return REPAIR_HASH.sub("", path.name)


def ffmpeg_section() -> str:
    av = md.distribution("av")
    libs = native_libs("av")
    licence = "unknown"
    for p in libs:
        if p.name.lower().startswith(("avutil", "libavutil")):
            found = re.search(rb"license: ([A-Za-z0-9 .+]+)", p.read_bytes())
            if found:
                licence = "license: " + found.group(1).decode("ascii")
    text = FFMPEG_NOTE.format(
        system=SYSTEM, av=av.version, ffmpeg_licence=licence, system_note=SYSTEM_NOTE[SYSTEM],
        libs=", ".join(sorted({short(p) for p in libs}, key=str.lower)), contact=CONTACT,
    )
    paragraphs = text.split("\n\n")
    for i in (0, 1):
        paragraphs[i] = textwrap.fill(paragraphs[i], 96, break_long_words=False, break_on_hyphens=False)
    return "\n\n".join(paragraphs)


def native_section() -> str:
    lines, named = [], []
    for package in ("ctranslate2", "sherpa-onnx", "sherpa-onnx-core"):
        names = sorted({short(p) for p in native_libs(package)})
        if names:
            lines.append(f"  - {package}: {', '.join(names)}")
        for name in names:
            for pattern, note in KNOWN:
                if re.search(pattern, name, re.IGNORECASE):
                    named.append(textwrap.fill(
                        f"{name} (inside {package}'s wheel): {note}", 96, initial_indent="  - ",
                        subsequent_indent="    ", break_long_words=False, break_on_hyphens=False))
    return NATIVE_NOTE.format(native="\n".join(lines + named))


def main() -> None:
    out = Path(sys.argv[1])
    title = f"Third-party software in the Clew dictation server ({SYSTEM} build)"
    parts = [
        title,
        "=" * len(title),
        "",
        "The dictation server's own code is under the MIT licence (LICENSE in",
        "https://github.com/yaqalab/clew-tools). It is packed with Python and the packages",
        "below, each under its own licence. No speech model is included; models are downloaded",
        "later, each under its own licence (MIT for the Whisper models, Apache-2.0 for 3D-Speaker).",
        "",
        f"Python {sys.version.split()[0]}: Python Software Foundation License, https://docs.python.org/3/license.html",
        "PyInstaller (packs it into a program): its bootloader is under the GPL-2.0-or-later with an",
        "exception that allows it in programs under any licence, https://pyinstaller.org/en/stable/license.html",
        "",
        "-" * 66,
        "FFmpeg and the libraries it is built with (inside PyAV)",
        "-" * 66,
        ffmpeg_section(),
        native_section(),
    ]
    dists = walk()
    parts += ["-" * 66, "Python packages", "-" * 66]
    for d in dists:
        parts.append(f"  {d.metadata['Name']} {d.version}: {licence_name(d)}")
    parts.append("")
    for d in dists:
        for name, text in licence_texts(d):
            parts += ["=" * 66, f"{d.metadata['Name']} {d.version}: {name}", "=" * 66, text.strip(), ""]
    out.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print(f"Wrote {out} ({len(dists)} packages)")


if __name__ == "__main__":
    main()
