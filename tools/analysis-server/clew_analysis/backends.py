"""The translators: one per backend. Each takes a checked neutral request (catalog.check_request),
turns it into what its program reads, runs the command's adapter, and turns the output back into
the neutral result:

    {"tables": [{"title", "head", "body", "stub"}], "notes": [...], "figures": [...],
     "script": "...", "backend": {"name", "version"}}

R is the first backend (docs/36 section 5). The data go to the program on its standard input,
never through a file, and the result comes back between two marker lines on its standard output.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .catalog import COMMANDS_DIR, Command

BEGIN = "<<<CLEW-RESULT>>>"
END = "<<<CLEW-END>>>"


class BackendError(RuntimeError):
    """The program could not run the command; the message is fit to show."""


@dataclass
class Found:
    id: str
    name: str
    path: str | None
    version: str
    ready: bool
    why: str = ""

    def describe(self) -> dict[str, Any]:
        # The program's path stays here: Clew has no use for it.
        out = {"id": self.id, "name": self.name, "version": self.version, "ready": self.ready}
        if self.why:
            out["why"] = self.why
        return out


def _windows_rscript() -> str | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg  # noqa: PLC0415

        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\R-core\R") as key:
                    home = winreg.QueryValueEx(key, "InstallPath")[0]
                exe = Path(home, "bin", "Rscript.exe")
                if exe.is_file():
                    return str(exe)
            except OSError:
                continue
    except ImportError:
        pass
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
        root = Path(base, "R") if base else None
        if root and root.is_dir():
            versions = sorted(p for p in root.glob("R-*") if (p / "bin" / "Rscript.exe").is_file())
            if versions:
                return str(versions[-1] / "bin" / "Rscript.exe")
    return None


def find_rscript(setting: str | None = None) -> str | None:
    """The setting if it is a program, then PATH, then (Windows) the registry and Program Files."""
    if setting and Path(setting).is_file():
        return setting
    return shutil.which("Rscript") or _windows_rscript()


def _quiet() -> dict[str, Any]:
    # No console window for the child on Windows.
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def detect_r(setting: str | None = None) -> Found:
    exe = find_rscript(setting)
    if not exe:
        return Found("r", "R", None, "", False, "R was not found on this computer")
    try:
        out = subprocess.run(
            [exe, "--vanilla", "-e", "cat(R.version$major, R.version$minor, sep='.')"],
            capture_output=True, text=True, timeout=30, **_quiet(),
        )
        version = out.stdout.strip()
        if out.returncode != 0 or not re.match(r"^\d+\.\d+", version):
            return Found("r", "R", exe, "", False, "R did not start")
        return Found("r", "R", exe, version, True)
    except (OSError, subprocess.TimeoutExpired):
        return Found("r", "R", exe, "", False, "R did not start")


def r_input(req: dict[str, Any]) -> str:
    """What clew.R reads on its standard input (see the head of clew.R)."""
    lines = [f"command\t{req['command']}"]
    for role in ("dependent", "independent", "groupby"):
        lines.append("\t".join([role, *req[role]]))
    for k, v in req["options"].items():
        lines.append(f"option\t{k}\t{_one_line(v)}")
    for name, entry in req["codebook"].items():
        lines.append(f"level\t{name}\t{entry['level']}")
        if entry["label"]:
            lines.append(f"label\t{name}\t{_one_line(entry['label'])}")
        if entry["order"]:
            lines.append("\t".join(["order", name, *(_one_line(x) for x in entry["order"])]))
    lines.append("---data---")
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(req["columns"])
    for row in req["rows"]:
        w.writerow(["" if row.get(c) is None else _one_line(str(row.get(c))) for c in req["columns"]])
    return "\n".join(lines) + "\n" + buf.getvalue()


def _one_line(s: str) -> str:
    return re.sub(r"[\t\r\n]+", " ", s)


def parse_output(stdout: str) -> dict[str, Any]:
    start = stdout.rfind(BEGIN)
    end = stdout.rfind(END)
    if start < 0 or end < start:
        raise BackendError("the program gave no result")
    try:
        result = json.loads(stdout[start + len(BEGIN):end])
    except ValueError as e:
        raise BackendError("the program's result could not be read") from e
    if not isinstance(result, dict):
        raise BackendError("the program's result could not be read")
    return result


def run_r(exe: str, command: Command, req: dict[str, Any], timeout: float) -> dict[str, Any]:
    adapter = command.adapters.get("r")
    if adapter is None:
        raise BackendError(f"{command.id} has no R version")
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    try:
        out = subprocess.run(
            [exe, "--vanilla", str(COMMANDS_DIR / "clew.R"), str(adapter)],
            input=r_input(req).encode("utf-8"),
            capture_output=True,
            timeout=timeout,
            env=env,
            **_quiet(),
        )
    except subprocess.TimeoutExpired as e:
        raise BackendError(f"R took longer than {int(timeout)} seconds and was stopped") from e
    except OSError as e:
        raise BackendError("R could not be started") from e
    result = parse_output(out.stdout.decode("utf-8", errors="replace"))
    if "error" in result:
        raise BackendError(f"R: {result['error']}")
    result["command"] = {"id": command.id, "version": command.version}
    return result
