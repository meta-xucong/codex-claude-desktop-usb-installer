"""Exercise the release PowerShell downloader against an offline range server on Windows."""
import os
import re
import socket
import struct
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / "src-tauri/src/app/claude_stage_desktop.ps1"
PAYLOAD = b"test-block" * 65536
# Load the shipping function only. No elevation or installation in Program Files.
RUN = r"""
$ErrorActionPreference='Stop'
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors) {throw $errors[0]}
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'GetReleaseFile'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
GetReleaseFile $env:QA_URL $env:QA_DEST 'desktop'
"""


@unittest.skipUnless(os.name == "nt", "Windows PowerShell transfer")
class TransferTests(unittest.TestCase):
    def exercise(self, mode):
        offsets = []
        payload = PAYLOAD * 27 if mode == "multiple" else PAYLOAD

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                match = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers["Range"])
                start = int(match[1])
                offsets.append(start)
                if mode in ("denied", "busy-always") or (mode == "busy" and len(offsets) == 1):
                    self.send_error(403 if mode == "denied" else 503)
                    return
                end = min(int(match[2]), len(payload) - 1)
                data = payload[start:end+1]
                ignores = mode == "full"
                self.send_response(200 if ignores else 206)
                if not ignores:
                    first = start + 1 if mode == "wrong-range" else start
                    self.send_header("Content-Range", f"bytes {first}-{end}/{len(payload)}")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if mode in ("interrupt", "reset") and len(offsets) == 1:
                    data = data[:262144]
                self.wfile.write(data)
                if mode == "reset" and len(offsets) == 1:
                    self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("HH", 1, 0))
                self.close_connection = True

        with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            dest = Path(tmp) / "output"
            env = dict(os.environ, QA_SCRIPT=str(STAGE), QA_URL=f"http://127.0.0.1:{server.server_port}/desktop.exe", QA_DEST=str(dest))
            try:
                result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", RUN],
                                        env=env, capture_output=True, timeout=40)
            finally:
                server.shutdown()
                server_thread.join()
            return result, offsets, dest.read_bytes()

    def test_resumes_truncated_response_at_exact_offset(self):
        result, offsets, data = self.exercise("interrupt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(offsets, [0, 262144])
        self.assertEqual(data, PAYLOAD)
        self.assertIn(b"retry-desktop", result.stdout)
        self.assertIn(b"progress desktop 100", result.stdout)

    def test_full_response_and_transient_service_error(self):
        for mode, expected in [("full", [0]), ("busy", [0, 0])]:
            with self.subTest(mode=mode):
                result, offsets, data = self.exercise(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(offsets, expected)
                self.assertEqual(data, PAYLOAD)

    def test_crosses_segment_boundary_and_recovers_socket_reset(self):
        result, offsets, data = self.exercise("multiple")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(offsets, [0, 16*1024*1024])
        self.assertEqual(data, PAYLOAD * 27)
        result, offsets, data = self.exercise("reset")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(offsets), 2)
        self.assertEqual(data, PAYLOAD)

    def test_stops_after_repeated_service_failures(self):
        result, offsets, data = self.exercise("busy-always")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(offsets, [0, 0, 0])
        self.assertEqual(data, b"")

    def test_refuses_wrong_offset_and_permanent_http_error(self):
        for mode in ["wrong-range", "denied"]:
            with self.subTest(mode=mode):
                result, offsets, data = self.exercise(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(offsets, [0])
                self.assertEqual(data, b"")


if __name__ == "__main__":
    unittest.main()
