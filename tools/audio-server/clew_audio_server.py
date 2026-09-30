"""
Clew audio server: lets Clew list and stream the audio files in one folder of this computer.

An alternative to picking a file with the browser's file chooser (docs/22-audio-server.md).

    python clew_audio_server.py --folder D:\\interviews

Standard library only, on purpose: the same file is packed into a single .exe (build_exe.ps1)
and nothing needs installing on the researcher's machine.

What it promises
- Listens on 127.0.0.1 only. It refuses any request whose Host is not loopback (DNS rebinding).
- One secret, generated on the first start and shown once. Only its scrypt hash is stored.
- Listing and minting a stream link need the secret (Authorization: Bearer <secret>).
- A stream link is signed (HMAC) for one file and one expiry, with a key that lives in memory only,
  so a restart revokes every link. A player element cannot send headers; that is why links exist.
- Only files under the chosen folder, only audio extensions, and symlinks that leave the folder
  are not followed.
- Only Clew's own origins get CORS headers. Loopback origins always; a hosted Clew with --allow-origin.
- Nothing from a request beyond method and path is logged, and never the secret or a link's query.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

API_VERSION = 1
APP_NAME = "clew-audio-server"
DEFAULT_PORT = 47821
# Long enough for a long interview, short enough that a link copied somewhere is soon useless.
LINK_TTL_SEC = 4 * 60 * 60
MAX_FILES = 20_000
CHUNK = 64 * 1024

# Same set as the kit's AUDIO_ACCEPT (packages/kit/src/audio/files.ts).
MIME_BY_EXT = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".weba": "audio/webm",
    ".webm": "audio/webm",
    ".mp4": "audio/mp4",
    ".3gp": "audio/3gpp",
    ".amr": "audio/amr",
}

LOOPBACK_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
LOOPBACK_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.IGNORECASE)


# ---------------------------------------------------------------------------------------------
# Config and secret
# ---------------------------------------------------------------------------------------------


def default_config_path() -> Path:
    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / APP_NAME / "config.json"


def hash_secret(secret: str, salt: bytes) -> bytes:
    return hashlib.scrypt(secret.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)


def new_secret() -> str:
    return secrets.token_urlsafe(24)


class Config:
    """What survives a restart: the folder, the secret's hash, the extra allowed origins."""

    def __init__(self, path: Path, data: dict[str, Any]) -> None:
        self.path = path
        self.data = data

    @classmethod
    def load(cls, path: Path) -> "Config":
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("v") == 1:
                return cls(path, raw)
        except (OSError, ValueError):
            pass
        return cls(path, {"v": 1})

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    @property
    def folder(self) -> str | None:
        v = self.data.get("folder")
        return v if isinstance(v, str) and v else None

    @property
    def origins(self) -> list[str]:
        v = self.data.get("origins")
        return [o for o in v if isinstance(o, str)] if isinstance(v, list) else []

    def has_secret(self) -> bool:
        return isinstance(self.data.get("salt"), str) and isinstance(self.data.get("hash"), str)

    def set_secret(self, secret: str) -> None:
        salt = secrets.token_bytes(16)
        self.data["salt"] = base64.b64encode(salt).decode("ascii")
        self.data["hash"] = base64.b64encode(hash_secret(secret, salt)).decode("ascii")

    def check_secret(self, candidate: str) -> bool:
        try:
            salt = base64.b64decode(self.data["salt"])
            expected = base64.b64decode(self.data["hash"])
        except (KeyError, ValueError):
            return False
        return hmac.compare_digest(hash_secret(candidate, salt), expected)


# ---------------------------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------------------------


def mime_of(path: Path) -> str | None:
    return MIME_BY_EXT.get(path.suffix.lower())


def inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def list_audio(root: Path) -> tuple[list[dict[str, Any]], bool]:
    """Every audio file under `root`, as relative paths with forward slashes. Hidden folders and
    links that point outside the folder are skipped."""
    found: list[dict[str, Any]] = []
    truncated = False
    stack = [root]
    while stack:
        here = stack.pop()
        try:
            entries = list(os.scandir(here))
        except OSError:
            continue
        for e in entries:
            if e.name.startswith("."):
                continue
            path = Path(e.path)
            try:
                if e.is_dir():
                    if inside(root, path.resolve()):
                        stack.append(path)
                    continue
                mime = mime_of(path)
                if mime is None or not e.is_file():
                    continue
                if not inside(root, path.resolve()):
                    continue
                st = e.stat()
            except OSError:
                continue
            if len(found) >= MAX_FILES:
                truncated = True
                break
            rel = path.relative_to(root).as_posix()
            found.append(
                {
                    "path": rel,
                    "name": path.name,
                    "size": st.st_size,
                    "modified": int(st.st_mtime * 1000),
                    "mime": mime,
                }
            )
        if truncated:
            break
    found.sort(key=lambda f: f["path"].lower())
    return found, truncated


def resolve_audio(root: Path, rel: str) -> Path | None:
    """The file `rel` names, or None when it is not an audio file inside `root`."""
    if not rel or "\x00" in rel or rel.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", rel):
        return None
    parts = rel.replace("\\", "/").split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None
    path = (root / Path(*parts)).resolve()
    if not inside(root, path) or mime_of(path) is None or not path.is_file():
        return None
    return path


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """(first, last) inclusive; None for no Range header; "bad" for one that cannot be met.
    Only one range is served — a player never asks for more."""
    if not header:
        return None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return "bad"
    if m.group(1) == "":
        n = int(m.group(2))
        if n == 0:
            return "bad"
        return (max(0, size - n), size - 1) if size else "bad"
    first = int(m.group(1))
    last = int(m.group(2)) if m.group(2) != "" else size - 1
    if first >= size or first > last:
        return "bad"
    return (first, min(last, size - 1))


# ---------------------------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------------------------


class State:
    def __init__(self, root: Path, config: Config, extra_origins: list[str]) -> None:
        self.root = root
        self.config = config
        self.origins = set(extra_origins) | set(config.origins)
        # In memory only: a restart revokes every stream link.
        self.link_key = secrets.token_bytes(32)
        self.failures = 0
        self.lock = threading.Lock()

    def origin_ok(self, origin: str) -> bool:
        return bool(LOOPBACK_ORIGIN.match(origin)) or origin in self.origins

    def sign(self, rel: str, exp: int) -> str:
        mac = hmac.new(self.link_key, f"{rel}\n{exp}".encode("utf-8"), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(mac).decode("ascii").rstrip("=")

    def link_for(self, rel: str, now: float | None = None) -> tuple[str, int]:
        exp = int((now if now is not None else time.time()) + LINK_TTL_SEC)
        return f"/api/stream?p={quote(rel, safe='')}&exp={exp}&sig={self.sign(rel, exp)}", exp * 1000

    def link_ok(self, rel: str, exp: str, sig: str) -> bool:
        if not exp.isdigit() or int(exp) < time.time():
            return False
        return hmac.compare_digest(self.sign(rel, int(exp)), sig)

    def secret_ok(self, header: str | None) -> bool:
        if not header or not header.startswith("Bearer "):
            return self._failed()
        ok = self.config.check_secret(header[7:].strip())
        with self.lock:
            self.failures = 0 if ok else self.failures + 1
            slow = self.failures >= 5
        if not ok and slow:
            time.sleep(1.0)
        return ok

    def _failed(self) -> bool:
        with self.lock:
            self.failures += 1
        return False


def make_handler(state: State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "ClewAudioServer/1"
        protocol_version = "HTTP/1.1"

        # -- plumbing ---------------------------------------------------------------------

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Method and path only; a link's query carries its signature.
            path = urlsplit(self.path).path
            sys.stderr.write(f"{self.command} {path} -> {args[1] if len(args) > 1 else ''}\n")

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and state.origin_ok(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")

        def _json(self, status: int, body: Any) -> None:
            raw = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(raw)

        def _refuse(self, status: int, why: str) -> None:
            self._json(status, {"error": why})

        def _guard(self) -> bool:
            """Loopback Host and an allowed Origin, for every request. False once it answered."""
            host = self.headers.get("Host", "")
            if not LOOPBACK_HOST.match(host):
                self._refuse(HTTPStatus.FORBIDDEN, "host")
                return False
            origin = self.headers.get("Origin")
            if origin and not state.origin_ok(origin):
                self._refuse(HTTPStatus.FORBIDDEN, "origin")
                return False
            return True

        def _body(self) -> dict[str, Any] | None:
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return None
            if n < 0 or n > 8192:
                self.close_connection = True
                return None
            try:
                v = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return None
            return v if isinstance(v, dict) else None

        # -- verbs ------------------------------------------------------------------------

        def do_OPTIONS(self) -> None:  # noqa: N802
            if not self._guard():
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        def do_GET(self) -> None:  # noqa: N802
            if not self._guard():
                return
            url = urlsplit(self.path)
            if url.path == "/api/ping":
                # No secret: lets Clew tell "no server here" from "wrong secret".
                self._json(HTTPStatus.OK, {"server": APP_NAME, "api": API_VERSION})
            elif url.path == "/api/files":
                self._files()
            elif url.path == "/api/stream":
                self._stream(parse_qs(url.query))
            else:
                self._refuse(HTTPStatus.NOT_FOUND, "not found")

        def do_POST(self) -> None:  # noqa: N802
            if not self._guard():
                return
            # Read the body first: a refusal that leaves it unread would corrupt the next request
            # on this kept-alive connection.
            body = self._body()
            if urlsplit(self.path).path == "/api/url":
                self._url(body)
            else:
                self._refuse(HTTPStatus.NOT_FOUND, "not found")

        # -- endpoints --------------------------------------------------------------------

        def _auth(self) -> bool:
            if state.secret_ok(self.headers.get("Authorization")):
                return True
            self._refuse(HTTPStatus.UNAUTHORIZED, "secret")
            return False

        def _files(self) -> None:
            if not self._auth():
                return
            files, truncated = list_audio(state.root)
            # The folder's name, not its full path: Clew has no use for the rest.
            self._json(
                HTTPStatus.OK,
                {"folder": state.root.name or str(state.root), "files": files, "truncated": truncated},
            )

        def _url(self, body: dict[str, Any] | None) -> None:
            if not self._auth():
                return
            rel = body.get("path") if body else None
            if not isinstance(rel, str) or resolve_audio(state.root, rel) is None:
                self._refuse(HTTPStatus.NOT_FOUND, "no such file")
                return
            url, expires = state.link_for(rel)
            self._json(HTTPStatus.OK, {"url": url, "expires": expires})

        def _stream(self, query: dict[str, list[str]]) -> None:
            rel = (query.get("p") or [""])[0]
            exp = (query.get("exp") or [""])[0]
            sig = (query.get("sig") or [""])[0]
            if not state.link_ok(rel, exp, sig):
                self._refuse(HTTPStatus.UNAUTHORIZED, "link")
                return
            path = resolve_audio(state.root, rel)
            if path is None:
                self._refuse(HTTPStatus.NOT_FOUND, "no such file")
                return
            try:
                size = path.stat().st_size
                span = parse_range(self.headers.get("Range"), size)
                f = open(path, "rb")
            except OSError:
                self._refuse(HTTPStatus.NOT_FOUND, "no such file")
                return
            with f:
                if span == "bad":
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self._cors()
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                first, last = span if isinstance(span, tuple) else (0, size - 1)
                length = max(0, last - first + 1) if size else 0
                self.send_response(HTTPStatus.PARTIAL_CONTENT if isinstance(span, tuple) else HTTPStatus.OK)
                self._cors()
                self.send_header("Content-Type", mime_of(path) or "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                if isinstance(span, tuple):
                    self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
                self.send_header("Cache-Control", "private, no-store")
                self.end_headers()
                if self.command == "HEAD" or length == 0:
                    return
                f.seek(first)
                left = length
                try:
                    while left > 0:
                        chunk = f.read(min(CHUNK, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    # The player moved on (a seek) and closed this request.
                    self.close_connection = True

    return Handler


class LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process share the port; there it is refused instead.
    allow_reuse_address = not hasattr(socket, "SO_EXCLUSIVEADDRUSE")

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def create_server(state: State, port: int) -> LoopbackServer:
    return LoopbackServer(("127.0.0.1", port), make_handler(state))


# ---------------------------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------------------------


def ask_folder() -> str:
    if not sys.stdin or not sys.stdin.isatty():
        raise SystemExit("No folder chosen. Start with --folder <path>.")
    return input("Folder with your audio files: ").strip().strip('"')


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Serve the audio files of one folder to Clew.")
    p.add_argument("--folder", help="the folder to serve (remembered for the next start)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        metavar="URL",
        help="a hosted Clew's origin, e.g. https://you.github.io (remembered); loopback is always allowed",
    )
    p.add_argument("--reset-secret", action="store_true", help="make a new secret; the old one stops working")
    p.add_argument("--config", type=Path, default=None, help="where the settings are kept")
    args = p.parse_args(argv)

    # A console in a legacy code page (cp932, cp1252...) must never crash the start-up: the secret is
    # shown once, and a failed print after it was saved would lose it.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace", line_buffering=True)

    config = Config.load(args.config or default_config_path())
    shown_secret: str | None = None
    if args.reset_secret or not config.has_secret():
        shown_secret = new_secret()
        config.set_secret(shown_secret)

    folder = args.folder or config.folder or ask_folder()
    root = Path(folder).expanduser()
    if not root.is_dir():
        raise SystemExit(f"Not a folder: {root}")
    root = root.resolve()
    config.data["folder"] = str(root)
    origins = sorted({*config.origins, *(o.rstrip("/") for o in args.allow_origin)})
    if origins:
        config.data["origins"] = origins
    config.save()

    state = State(root, config, origins)
    try:
        server = create_server(state, args.port)
    except OSError as e:
        raise SystemExit(f"Port {args.port} is not available ({e}). Try --port <number>.") from e

    files, truncated = list_audio(root)
    print(f"Clew audio server  ->  http://127.0.0.1:{args.port}")
    print(f"Folder: {root}  ({len(files)} audio files{', more than shown' if truncated else ''})")
    if shown_secret:
        print()
        print("Secret (shown once - paste it into Clew):")
        print(f"    {shown_secret}")
        print()
    else:
        print("Secret: the one shown at the first start (--reset-secret makes a new one).")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
