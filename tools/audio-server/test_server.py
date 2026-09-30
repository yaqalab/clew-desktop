"""
Tests for the Clew audio server. A real server on a free port and a real folder, no mocks:

    python -m unittest discover -s tools/audio-server -v
"""

import http.client
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

import clew_audio_server as srv

SECRET = "test-secret-not-a-real-one"
BYTES = bytes(range(256)) * 40  # 10,240 bytes, every value, so a wrong slice is visible


class ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name, "interviews").resolve()
        (cls.root / "2026" / "spring").mkdir(parents=True)
        (cls.root / ".hidden").mkdir()
        (cls.root / "a.wav").write_bytes(BYTES)
        (cls.root / "2026" / "spring" / "b.m4a").write_bytes(BYTES[:1000])
        (cls.root / "notes.txt").write_text("not audio")
        (cls.root / ".hidden" / "c.mp3").write_bytes(b"x")
        (cls.root / ".secret.mp3").write_bytes(b"x")
        cls.outside = Path(cls.tmp.name, "outside.mp3")
        cls.outside.write_bytes(b"private")

        config = srv.Config(Path(cls.tmp.name, "config.json"), {"v": 1})
        config.set_secret(SECRET)
        cls.state = srv.State(cls.root, config, ["https://clew.example"])
        cls.server = srv.create_server(cls.state, 0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            h = dict(headers or {})
            data = None
            if body is not None:
                data = json.dumps(body)
                h["Content-Type"] = "application/json"
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
        finally:
            c.close()

    def auth(self, secret=SECRET):
        return {"Authorization": f"Bearer {secret}"}

    def link(self, rel):
        status, _, raw = self.call("POST", "/api/url", self.auth(), {"path": rel})
        self.assertEqual(status, 200, raw)
        return json.loads(raw)["url"]


class Discovery(ServerCase):
    def test_ping_needs_no_secret(self):
        status, _, raw = self.call("GET", "/api/ping")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["server"], "clew-audio-server")

    def test_lists_audio_recursively_and_nothing_else(self):
        status, _, raw = self.call("GET", "/api/files", self.auth())
        self.assertEqual(status, 200)
        body = json.loads(raw)
        self.assertEqual([f["path"] for f in body["files"]], ["2026/spring/b.m4a", "a.wav"])
        self.assertEqual(body["folder"], "interviews")
        a = next(f for f in body["files"] if f["path"] == "a.wav")
        self.assertEqual((a["size"], a["mime"], a["name"]), (len(BYTES), "audio/wav", "a.wav"))
        self.assertIsInstance(a["modified"], int)

    def test_the_full_path_of_the_folder_is_not_sent(self):
        _, _, raw = self.call("GET", "/api/files", self.auth())
        self.assertNotIn(str(self.root.parent).encode(), raw)

    def test_a_link_out_of_the_folder_is_not_followed(self):
        outside_dir = Path(self.tmp.name, "elsewhere")
        outside_dir.mkdir(exist_ok=True)
        (outside_dir / "x.mp3").write_bytes(b"private")
        file_link, dir_link = self.root / "escape.mp3", self.root / "escape-dir"
        try:
            try:
                os.symlink(self.outside, file_link)
                os.symlink(outside_dir, dir_link, target_is_directory=True)
            except (OSError, NotImplementedError):
                # Windows needs a privilege for symlinks; a directory junction is the same escape.
                if os.name != "nt":
                    raise
                subprocess.run(["cmd", "/c", "mklink", "/J", str(dir_link), str(outside_dir)], check=True, capture_output=True)
            _, _, raw = self.call("GET", "/api/files", self.auth())
            paths = [f["path"] for f in json.loads(raw)["files"]]
            self.assertFalse([p for p in paths if p.startswith("escape")], paths)
            status, _, _ = self.call("POST", "/api/url", self.auth(), {"path": "escape-dir/x.mp3"})
            self.assertEqual(status, 404)
        finally:
            for link in (file_link, dir_link):
                if link.is_symlink() or link.is_file():
                    link.unlink()
                elif link.exists():
                    os.rmdir(link)  # a junction: removes the link, not the folder it points at


class Credentials(ServerCase):
    def test_no_secret_no_list(self):
        self.assertEqual(self.call("GET", "/api/files")[0], 401)

    def test_wrong_secret_no_list(self):
        self.assertEqual(self.call("GET", "/api/files", self.auth("nope"))[0], 401)

    def test_no_secret_no_link(self):
        self.assertEqual(self.call("POST", "/api/url", None, {"path": "a.wav"})[0], 401)

    def test_the_secret_is_not_kept_in_the_config(self):
        self.assertNotIn(SECRET, json.dumps(self.state.config.data))

    def test_a_link_without_a_valid_signature_is_refused(self):
        url = self.link("a.wav")
        self.assertEqual(self.call("GET", url)[0], 200)
        self.assertEqual(self.call("GET", url[:-2] + "xx")[0], 401)
        self.assertEqual(self.call("GET", "/api/stream?p=a.wav&exp=9999999999&sig=x")[0], 401)

    def test_a_link_is_for_one_file(self):
        url = self.link("a.wav").replace("p=a.wav", "p=2026%2Fspring%2Fb.m4a")
        self.assertEqual(self.call("GET", url)[0], 401)

    def test_an_expired_link_is_refused(self):
        exp = int(time.time()) - 5
        url = f"/api/stream?p=a.wav&exp={exp}&sig={self.state.sign('a.wav', exp)}"
        self.assertEqual(self.call("GET", url)[0], 401)

    def test_a_link_from_another_run_is_refused(self):
        url = self.link("a.wav")
        old = self.state.link_key
        self.state.link_key = b"\x01" * 32
        try:
            self.assertEqual(self.call("GET", url)[0], 401)
        finally:
            self.state.link_key = old

    def test_the_log_never_carries_the_query(self):
        import io
        import contextlib

        url = self.link("a.wav")
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            self.call("GET", url)
        self.assertIn("/api/stream", buf.getvalue())
        self.assertNotIn("sig=", buf.getvalue())


class Paths(ServerCase):
    def test_cannot_ask_for_a_file_outside_the_folder(self):
        for rel in ["../outside.mp3", "..\\outside.mp3", "/outside.mp3", "C:/x.mp3", "a/../../outside.mp3", ".secret.mp3"]:
            status, _, _ = self.call("POST", "/api/url", self.auth(), {"path": rel})
            self.assertEqual(status, 404, rel)

    def test_a_forged_link_for_an_outside_file_is_still_refused(self):
        exp = int(time.time()) + 100
        rel = "../outside.mp3"
        url = f"/api/stream?p=..%2Foutside.mp3&exp={exp}&sig={self.state.sign(rel, exp)}"
        self.assertEqual(self.call("GET", url)[0], 404)

    def test_only_audio_is_served(self):
        self.assertEqual(self.call("POST", "/api/url", self.auth(), {"path": "notes.txt"})[0], 404)


class Streaming(ServerCase):
    def test_whole_file(self):
        status, h, raw = self.call("GET", self.link("a.wav"))
        self.assertEqual((status, raw), (200, BYTES))
        self.assertEqual(h["content-type"], "audio/wav")
        self.assertEqual(h["accept-ranges"], "bytes")

    def test_a_range(self):
        status, h, raw = self.call("GET", self.link("a.wav"), {"Range": "bytes=100-199"})
        self.assertEqual(status, 206)
        self.assertEqual(raw, BYTES[100:200])
        self.assertEqual(h["content-range"], f"bytes 100-199/{len(BYTES)}")

    def test_an_open_ended_range(self):
        status, _, raw = self.call("GET", self.link("a.wav"), {"Range": "bytes=10000-"})
        self.assertEqual((status, raw), (206, BYTES[10000:]))

    def test_a_suffix_range(self):
        status, _, raw = self.call("GET", self.link("a.wav"), {"Range": "bytes=-50"})
        self.assertEqual((status, raw), (206, BYTES[-50:]))

    def test_a_range_past_the_end_is_clamped(self):
        status, _, raw = self.call("GET", self.link("a.wav"), {"Range": "bytes=10000-99999"})
        self.assertEqual((status, raw), (206, BYTES[10000:]))

    def test_an_unsatisfiable_range(self):
        status, h, _ = self.call("GET", self.link("a.wav"), {"Range": "bytes=99999-"})
        self.assertEqual(status, 416)
        self.assertEqual(h["content-range"], f"bytes */{len(BYTES)}")

    def test_head_has_the_size_and_no_body(self):
        status, h, raw = self.call("HEAD", self.link("a.wav"))
        self.assertEqual((status, raw), (200, b""))
        self.assertEqual(h["content-length"], str(len(BYTES)))

    def test_a_file_in_a_subfolder(self):
        status, _, raw = self.call("GET", self.link("2026/spring/b.m4a"))
        self.assertEqual((status, raw), (200, BYTES[:1000]))


class Browser(ServerCase):
    def test_the_hosts_other_than_loopback_are_refused(self):
        # A page on another name pointing at 127.0.0.1 (DNS rebinding) arrives with its own Host.
        status, _, _ = self.call("GET", "/api/ping", {"Host": "evil.example"})
        self.assertEqual(status, 403)

    def test_a_foreign_origin_is_refused(self):
        status, _, _ = self.call("GET", "/api/ping", {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_loopback_and_configured_origins_get_cors(self):
        for origin in ["http://localhost:5173", "http://127.0.0.1:4173", "https://clew.example"]:
            status, h, _ = self.call("GET", "/api/ping", {"Origin": origin})
            self.assertEqual(status, 200, origin)
            self.assertEqual(h["access-control-allow-origin"], origin)

    def test_preflight(self):
        status, h, _ = self.call(
            "OPTIONS",
            "/api/files",
            {
                "Origin": "https://clew.example",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        self.assertEqual(status, 204)
        self.assertIn("Authorization", h["access-control-allow-headers"])
        self.assertEqual(h["access-control-allow-private-network"], "true")

    def test_a_player_request_without_an_origin_is_fine(self):
        self.assertEqual(self.call("GET", self.link("a.wav"))[0], 200)


class Units(unittest.TestCase):
    def test_parse_range(self):
        self.assertIsNone(srv.parse_range(None, 100))
        self.assertEqual(srv.parse_range("bytes=0-9", 100), (0, 9))
        self.assertEqual(srv.parse_range("bytes=90-", 100), (90, 99))
        self.assertEqual(srv.parse_range("bytes=-10", 100), (90, 99))
        for bad in ["bytes=-", "bytes=5-2", "bytes=100-", "bytes=-0", "items=0-1", "bytes=a-b"]:
            self.assertEqual(srv.parse_range(bad, 100), "bad", bad)

    def test_config_round_trip_and_secret(self):
        with tempfile.TemporaryDirectory() as d:
            c = srv.Config(Path(d, "x", "config.json"), {"v": 1})
            c.set_secret("abc")
            c.data["folder"] = "F"
            c.save()
            again = srv.Config.load(Path(d, "x", "config.json"))
            self.assertEqual(again.folder, "F")
            self.assertTrue(again.check_secret("abc"))
            self.assertFalse(again.check_secret("abd"))

    def test_a_broken_config_starts_empty(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "config.json")
            p.write_text("{not json")
            c = srv.Config.load(p)
            self.assertFalse(c.has_secret())


if __name__ == "__main__":
    unittest.main()
