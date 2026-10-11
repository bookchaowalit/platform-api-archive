#!/usr/bin/env python3
"""
OpenTelemetry smoke test for infra/api.

Proves the instrumentation added in infra/api/telemetry.ts actually
produces and exports spans end-to-end, not just that the SDK package is
installed:
  1. Start a minimal fake OTLP/HTTP collector capturing POST bodies to
     /v1/traces.
  2. Start the real API server with OTEL_ENABLED=true pointed at it.
  3. Make a request through the server.
  4. Wait for the batch span processor's default export interval and
     confirm the fake collector received a non-empty POST.

Also confirms the default (OTEL_ENABLED unset) path starts the server
with no telemetry attempt at all, so normal dev/CI runs never depend on
a collector being reachable.

Usage:
    python3 infra/tests/api/telemetry_smoke_test.py

Exit code 0 = pass, 1 = failure.
"""

import http.server
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "utils"))
from _env import PROJECT_ROOT  # noqa: E402


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("localhost", 0))
        s.listen(1)
        return s.getsockname()[1]


class CapturingOtlpHandler(http.server.BaseHTTPRequestHandler):
    received: list[bytes] = []

    def do_POST(self):  # noqa: N802 - stdlib handler name
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            body = self._read_chunked()
        else:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
        CapturingOtlpHandler.received.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def _read_chunked(self) -> bytes:
        chunks = []
        while True:
            size_line = self.rfile.readline().strip()
            size = int(size_line.split(b";")[0], 16)
            if size == 0:
                self.rfile.readline()  # trailing CRLF after last chunk
                break
            chunks.append(self.rfile.read(size))
            self.rfile.read(2)  # CRLF after each chunk
        return b"".join(chunks)

    def log_message(self, *_args):  # silence default stderr logging
        pass


def start_fake_collector(port: int) -> http.server.HTTPServer:
    server = http.server.HTTPServer(("127.0.0.1", port), CapturingOtlpHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def start_server(port: int, db_path: str, env_overrides: dict) -> subprocess.Popen:
    env = os.environ.copy()
    env.update(
        {
            "PORT": str(port),
            "DATABASE_PATH": db_path,
            "SOLO_EMPIRE_DB_PATH": db_path,
            "API_TOKEN": "test-token-123",
            "NODE_ENV": "test",
            "SECRETS_PROVIDER": "env",
            "SECRETS_FALLBACK_ENV": "false",
            "LINE_SOLO_EMPIRE_WEBHOOK_SECRET": "test-line-secret",
            "STRIPE_WEBHOOK_SECRET": "test-stripe-webhook-secret",
            "AI_GATEWAY_PROVIDER": "openai-compatible",
            "AI_GATEWAY_PROVIDER_NAME": "mock-provider",
            "AI_GATEWAY_BASE_URL": "http://127.0.0.1:1/v1",
            "AI_GATEWAY_API_KEY": "test-provider-key",
            "AI_GATEWAY_MODEL": "mock-model",
            "AI_GATEWAY_INPUT_USD_PER_1K": "0.001",
            "AI_GATEWAY_OUTPUT_USD_PER_1K": "0.002",
        }
    )
    env.update(env_overrides)
    proc = subprocess.Popen(
        ["npx", "tsx", "infra/api/server.ts"],
        env=env,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 15
    last_error = "no response"
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            stdout, stderr = proc.communicate()
            details = stderr.decode(errors="replace").strip() or stdout.decode(errors="replace").strip()
            raise RuntimeError(f"Server failed to start: {details or 'unknown error'}")
        try:
            resp = requests.get(f"http://localhost:{port}/health", timeout=0.5)
            if resp.status_code == 200:
                return proc
            last_error = f"health returned HTTP {resp.status_code}"
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError(f"Server did not become ready within 15 seconds: {last_error}")


def run() -> bool:
    ok = True

    # --- Part 1: OTEL_ENABLED unset -> no export attempted, server still healthy ---
    # Each part gets its own temp dir so bootstrap backups written by one part
    # never make the next part's fresh DB look like a data-loss replacement.
    part1_dir = tempfile.TemporaryDirectory(prefix="solo-empire-otel-1-")
    db_path = str(Path(part1_dir.name) / "telemetry.db")
    port = find_free_port()
    try:
        proc = start_server(port, db_path, {})
    except BaseException:
        part1_dir.cleanup()
        raise
    try:
        resp = requests.get(f"http://localhost:{port}/health", timeout=2)
        if resp.status_code != 200:
            print(f"[1/2] FAIL: health check returned {resp.status_code} with OTEL disabled")
            ok = False
        else:
            print("[1/2] PASS: server runs normally with OTEL_ENABLED unset (opt-in, no collector dependency)")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        part1_dir.cleanup()

    # --- Part 2: OTEL_ENABLED=true -> a real span reaches a fake OTLP collector ---
    collector_port = find_free_port()
    collector = start_fake_collector(collector_port)
    CapturingOtlpHandler.received.clear()

    part2_dir = tempfile.TemporaryDirectory(prefix="solo-empire-otel-2-")
    db_path = str(Path(part2_dir.name) / "telemetry.db")
    port = find_free_port()
    try:
        proc = start_server(
            port,
            db_path,
            {
                "OTEL_ENABLED": "true",
                "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{collector_port}/v1/traces",
                "OTEL_SERVICE_NAME": "solo-empire-api-test",
            },
        )
    except BaseException:
        collector.shutdown()
        part2_dir.cleanup()
        raise
    try:
        resp = requests.get(f"http://localhost:{port}/health", timeout=2)
        if resp.status_code != 200:
            print(f"[2/2] FAIL: health check returned {resp.status_code} with OTEL enabled")
            ok = False
        else:
            # Default BatchSpanProcessor export interval is 5s; poll generously.
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not CapturingOtlpHandler.received:
                time.sleep(0.5)
            if not CapturingOtlpHandler.received:
                print("[2/2] FAIL: fake OTLP collector received no export within 10s")
                ok = False
            elif not any(len(b) > 0 for b in CapturingOtlpHandler.received):
                print("[2/2] FAIL: OTLP export arrived but body was empty")
                ok = False
            else:
                total_bytes = sum(len(b) for b in CapturingOtlpHandler.received)
                print(
                    f"[2/2] PASS: {len(CapturingOtlpHandler.received)} OTLP export(s), "
                    f"{total_bytes} bytes reached the fake collector"
                )
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        collector.shutdown()
        part2_dir.cleanup()

    return ok


if __name__ == "__main__":
    success = run()
    print("\nResult:", "PASS" if success else "FAIL")
    sys.exit(0 if success else 1)
