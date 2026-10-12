#!/usr/bin/env python3
"""
Solo Empire API Integration Tests.

Tests the actual API server with a temporary database:
  1. Start API server on random port with temp DB
  2. Test health endpoint
  3. Test auth rejection without token
  4. Test profile sync with allowlist filtering
  5. Test the retired content sync route answers 410 Gone
  6. Test JSON response headers and the retired content routes answer 410 Gone
  7-8. (retired 2026-10-11: asset analytics and revenue webhook idempotency; revenue lives in the CRM ledger)
  9. Test external integration catalog and authenticated offline health
 10. Test bounded external catalog discovery
 11. Test authenticated Sentry read-only issue route
 12. Test authenticated PostHog read-only insight route
 13. Test authenticated Slack read-only channel route

Usage:
    python3 infra/tests/api/api_integration_test.py
    python3 infra/tests/api/api_integration_test.py --verbose

Exit code 0 = all pass, 1 = some failures.
"""

import os
import sys
import sqlite3
import subprocess
import time
import json
import base64
import hashlib
import hmac
import requests
import tempfile
import signal
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Add utils directory to path for _env import
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'utils'))
from _env import DB_PATH, PROJECT_ROOT

SCHEMA_PATH = PROJECT_ROOT / "infra" / "database" / "schema.sql"

VERBOSE = False
passed = 0
failed = 0
errors = []
server_process = None
temp_db_path = None
mock_provider_server = None
mock_provider_payloads = []


class MockAiProviderHandler(BaseHTTPRequestHandler):
    """Local OpenAI-compatible fixture; no external provider is contacted."""

    def log_message(self, format, *args):  # noqa: A002
        return

    def do_POST(self):  # noqa: N802
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return
        if self.headers.get("Authorization") != "Bearer test-provider-key":
            self.send_response(401)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        mock_provider_payloads.append(payload)
        text = " ".join(str(item.get("content", "")) for item in payload.get("messages", []))
        if "trigger-rate-limit" in text:
            self.send_response(429)
            self.end_headers()
            return
        response = {
            "id": "mock-run-1",
            "object": "chat.completion",
            "model": payload.get("model", "mock-model"),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "mock gateway response"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
        }
        encoded = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def start_mock_provider():
    global mock_provider_server
    mock_provider_server = ThreadingHTTPServer(("127.0.0.1", 0), MockAiProviderHandler)
    thread = threading.Thread(target=mock_provider_server.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{mock_provider_server.server_port}/v1"


def stop_mock_provider():
    global mock_provider_server
    if mock_provider_server:
        mock_provider_server.shutdown()
        mock_provider_server.server_close()
        mock_provider_server = None


def log_pass(msg: str):
    global passed
    passed += 1
    if VERBOSE:
        print(f"  PASS: {msg}")


def log_fail(msg: str):
    global failed
    failed += 1
    errors.append(msg)
    print(f"  FAIL: {msg}")


def find_free_port() -> int:
    """Find a random free port by binding to port 0."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('localhost', 0))
        s.listen(1)
        port = s.getsockname()[1]
    return port


def setup_temp_db():
    """Create a temporary empty database (server will initialize it)."""
    global temp_db_path
    temp_db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    temp_db_path = temp_db.name
    temp_db.close()
    # Don't pre-create schema - server's initDb() will handle it
    return temp_db_path


def start_server(port: int, db_path: str, api_token: str = "test-token-123", provider_url: str | None = None):
    """Start the API server with temp DB."""
    global server_process

    env = os.environ.copy()
    env["PORT"] = str(port)
    env["DATABASE_PATH"] = db_path
    env["SOLO_EMPIRE_DB_PATH"] = db_path
    env["API_TOKEN"] = api_token
    env["NODE_ENV"] = "test"
    env["SECRETS_PROVIDER"] = "env"
    env["SECRETS_FALLBACK_ENV"] = "false"
    env["LINE_SOLO_EMPIRE_WEBHOOK_SECRET"] = "test-line-secret"
    env["STRIPE_WEBHOOK_SECRET"] = "test-stripe-webhook-secret"
    env["AI_GATEWAY_PROVIDER"] = "openai-compatible"
    env["AI_GATEWAY_PROVIDER_NAME"] = "mock-provider"
    env["AI_GATEWAY_BASE_URL"] = provider_url or "http://127.0.0.1:1/v1"
    env["AI_GATEWAY_API_KEY"] = "test-provider-key"
    env["AI_GATEWAY_MODEL"] = "mock-model"
    # Keep the fixture deterministic when a local Ollama profile is configured.
    env["AI_GATEWAY_MODEL_FAST"] = "mock-model"
    env["AI_GATEWAY_MODEL_BALANCED"] = "mock-model"
    env["AI_GATEWAY_MODEL_QUALITY"] = "mock-model"
    env["AI_GATEWAY_INPUT_USD_PER_1K"] = "0.001"
    env["AI_GATEWAY_OUTPUT_USD_PER_1K"] = "0.002"

    server_process = subprocess.Popen(
        ["npx", "tsx", "infra/api/server.ts"],
        env=env,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for the actual health endpoint instead of sleeping for a fixed
    # duration. Native SQLite loading and tsx startup can vary significantly
    # between local machines and GitHub Actions runners.
    deadline = time.monotonic() + 15
    last_error = "no response"
    health_url = f"http://localhost:{port}/health"
    while time.monotonic() < deadline:
        if server_process.poll() is not None:
            stdout, stderr = server_process.communicate()
            details = stderr.decode(errors="replace").strip()
            if not details:
                details = stdout.decode(errors="replace").strip()
            raise Exception(f"Server failed to start: {details or 'unknown error'}")

        try:
            response = requests.get(health_url, timeout=0.5)
            if response.status_code == 200:
                return
            last_error = f"health returned HTTP {response.status_code}"
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(0.25)

    raise Exception(f"Server did not become ready within 15 seconds: {last_error}")


def stop_server():
    """Stop the API server."""
    global server_process
    if server_process:
        server_process.terminate()
        server_process.wait(timeout=5)
        server_process = None


def test_health(base_url: str):
    """Test 1: Health endpoint."""
    print("\n[1/8] Health Endpoint")
    try:
        resp = requests.get(f"{base_url}/health", timeout=2)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "ok":
                log_pass("Health endpoint returns ok status")
            else:
                log_fail(f"Health status unexpected: {data}")

            if resp.headers.get("content-type", "").startswith("application/json"):
                log_pass("JSON response declares application/json content type")
            else:
                log_fail(f"Health content type unexpected: {resp.headers.get('content-type')}")
        else:
            log_fail(f"Health endpoint returned {resp.status_code}")
    except Exception as e:
        log_fail(f"Health endpoint failed: {e}")


def test_auth_rejection(base_url: str):
    """Test 2: Auth rejection without token."""
    print("\n[2/8] Auth Rejection")
    try:
        # Try to POST without auth header
        resp = requests.post(
            f"{base_url}/api/sync/profile",
            json={"name": "Test"},
            timeout=2
        )
        if resp.status_code == 401:
            log_pass("Write route rejects unauthenticated request")
        else:
            log_fail(f"Expected 401, got {resp.status_code}")
    except Exception as e:
        log_fail(f"Auth rejection test failed: {e}")


def test_ai_gateway(base_url: str, api_token: str):
    """The local AI routes were retired: generation lives in ai-gateway (2026-10-11)."""
    print("\n[3/8] Retired AI routes")
    try:
        status = requests.get(f"{base_url}/api/ai/status", timeout=2)
        if status.status_code == 410:
            log_pass("AI status answers 410 Gone")
        else:
            log_fail(f"Expected 410 for AI status, got {status.status_code}")
        payload = {"route": "test", "prompt_version": "v1", "messages": [{"role": "user", "content": "hello"}]}
        unauthorized = requests.post(f"{base_url}/api/ai/generate", json=payload, timeout=2)
        if unauthorized.status_code == 401:
            log_pass("AI generation still rejects unauthenticated callers")
        else:
            log_fail(f"Expected 401 for AI generation, got {unauthorized.status_code}")
        authorized = requests.post(f"{base_url}/api/ai/generate", json=payload, timeout=2,
                                   headers={"Authorization": f"Bearer {api_token}"})
        if authorized.status_code == 410:
            log_pass("AI generation answers 410 Gone")
        else:
            log_fail(f"Expected 410 for AI generation, got {authorized.status_code}")
    except Exception as e:
        log_fail(f"AI route test failed: {e}")


def test_retired_routes(base_url: str, api_token: str):
    """Profile sync and the LINE/Stripe webhooks wrote retired SQLite tables; they answer 410 (2026-10-11)."""
    print("\n[4/8] Retired routes")
    headers = {"Authorization": f"Bearer {api_token}"}
    try:
        for method, path in (("GET", "/api/profile"), ("POST", "/api/sync/profile"), ("POST", "/api/sync/social-links"),
                             ("POST", "/api/webhook/line"), ("POST", "/api/webhook/stripe")):
            resp = requests.request(method, f"{base_url}{path}", headers=headers, json={}, timeout=2)
            if resp.status_code == 410:
                log_pass(f"{method} {path} answers 410 Gone")
            else:
                log_fail(f"Expected 410 for {method} {path}, got {resp.status_code}")
    except Exception as e:
        log_fail(f"Retired route test failed: {e}")


def test_content_allowlist(base_url: str, api_token: str):
    """Test 4: the retired content sync route answers 410 Gone and writes nothing."""
    print("\n[4/8] Content Sync Retired")
    try:
        resp = requests.post(
            f"{base_url}/api/sync/content",
            json={"title": "Test Article", "slug": "test-article"},
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2
        )
        if resp.status_code == 410:
            log_pass("Content sync is retired (410 Gone)")
        else:
            log_fail(f"Expected 410 for retired content sync, got {resp.status_code}")
    except Exception as e:
        log_fail(f"Content sync retirement test failed: {e}")


def test_webhook_auth(base_url: str):
    """Test 5: Webhook routes require auth."""
    print("\n[5/8] Webhook Auth")
    try:
        resp = requests.post(
            f"{base_url}/api/webhook/analytics",
            json={"asset_id": 1, "views": 100},
            timeout=2
        )

        if resp.status_code == 401:
            log_pass("Webhook route requires authentication")
        else:
            log_fail(f"Expected 401 for webhook, got {resp.status_code}")
    except Exception as e:
        log_fail(f"Webhook auth test failed: {e}")


def test_content_limit_validation(base_url: str):
    """Test 6: the retired public content routes answer 410 Gone."""
    print("\n[6/8] Content Routes Retired")
    try:
        for path in ("/api/content?limit=0", "/api/content/some-slug"):
            resp = requests.get(f"{base_url}{path}", timeout=2)
            if resp.status_code == 410:
                log_pass(f"{path.split('?')[0]} is retired (410 Gone)")
            else:
                log_fail(f"Expected 410 for {path}, got {resp.status_code}")
    except Exception as e:
        log_fail(f"Content route retirement test failed: {e}")


def test_external_integrations(base_url: str, api_token: str):
    """Test the external integration catalog and offline health contract."""
    print("\n[9/9] External Integration API")
    try:
        catalog = requests.get(f"{base_url}/api/integrations", timeout=2)
        catalog_payload = catalog.json()
        if (
            catalog.status_code == 200
            and catalog_payload.get("total_apps") == 106
            and len(catalog_payload.get("apps", [])) == 106
            and len(catalog_payload.get("integrations", [])) == 28
        ):
            log_pass("External API catalog exposes 106 apps and 28 integration descriptors")
        else:
            log_fail(f"Integration catalog returned {catalog.status_code}")

        unauthorized = requests.get(f"{base_url}/api/integrations/health?offline=true", timeout=2)
        if unauthorized.status_code == 401:
            log_pass("Integration health requires authentication")
        else:
            log_fail(f"Expected 401 for integration health, got {unauthorized.status_code}")

        health = requests.get(
            f"{base_url}/api/integrations/health?offline=true",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = health.json()
        if health.status_code == 200 and payload.get("total_integrations") == 26:
            log_pass("Authenticated offline health returns the twenty-six active checks")
        else:
            log_fail(f"Integration health returned {health.status_code}: {payload}")
    except Exception as e:
        log_fail(f"External integration API test failed: {e}")


def test_sentry_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for the Sentry read-only route."""
    print("\n[13/13] Sentry Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/sentry/issues?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Sentry issue summary requires authentication")
        else:
            log_fail(f"Expected 401 for Sentry issue summary, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/sentry/issues?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("Sentry issue summary enforces the 100 issue bound")
        else:
            log_fail(f"Expected 400 for oversized Sentry request, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/sentry/issues?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "sentry"
            and payload.get("status") == "offline"
            and payload.get("issues") == []
        ):
            log_pass("Offline Sentry issue summary avoids provider calls")
        else:
            log_fail(f"Offline Sentry issue summary returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"Sentry read-only API test failed: {e}")


def test_external_discovery(base_url: str, api_token: str):
    """Test bounded catalog discovery without contacting providers in tests."""
    print("\n[10/10] External Catalog Discovery API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/discovery?source=apis-guru&limit=10&offline=true",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("External discovery requires authentication")
        else:
            log_fail(f"Expected 401 for discovery, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/discovery?limit=10001&offline=true",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("External discovery enforces the 10,000 record bound")
        else:
            log_fail(f"Expected 400 for oversized discovery, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/discovery?source=all&limit=10&offline=true",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if offline.status_code == 200 and payload.get("offline") is True and payload.get("total_discovered") == 0:
            log_pass("Offline discovery avoids network calls and returns a structured report")
        else:
            log_fail(f"Offline discovery returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"External discovery API test failed: {e}")


def test_posthog_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for the PostHog read-only route."""
    print("\n[14/14] PostHog Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/posthog/insights?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("PostHog insight summary requires authentication")
        else:
            log_fail(f"Expected 401 for PostHog insight summary, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/posthog/insights?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("PostHog insight summary enforces the 100 insight bound")
        else:
            log_fail(f"Expected 400 for oversized PostHog request, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/posthog/insights?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "posthog"
            and payload.get("status") == "offline"
            and payload.get("insights") == []
        ):
            log_pass("Offline PostHog insight summary avoids provider calls")
        else:
            log_fail(f"Offline PostHog insight summary returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"PostHog read-only API test failed: {e}")


def test_slack_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for Slack read-only channels."""
    print("\n[15/15] Slack Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/slack/channels?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Slack channel summary requires authentication")
        else:
            log_fail(f"Expected 401 for Slack channel summary, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/slack/channels?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("Slack channel summary enforces the 100 channel bound")
        else:
            log_fail(f"Expected 400 for oversized Slack request, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/slack/channels?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "slack"
            and payload.get("status") == "offline"
            and payload.get("channels") == []
        ):
            log_pass("Offline Slack channel summary avoids provider calls")
        else:
            log_fail(f"Offline Slack channel summary returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"Slack read-only API test failed: {e}")


def test_notion_readonly(base_url: str, api_token: str):
    """Test auth, bounds, query validation, and offline behavior for Notion."""
    print("\n[16/16] Notion Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/notion/search?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Notion search requires authentication")
        else:
            log_fail(f"Expected 401 for Notion search, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/notion/search?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("Notion search enforces the 100 result bound")
        else:
            log_fail(f"Expected 400 for oversized Notion request, got {invalid_limit.status_code}")

        invalid_query = requests.get(
            f"{base_url}/api/integrations/notion/search?offline=true&query={'x' * 101}",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_query.status_code == 400:
            log_pass("Notion search bounds query length")
        else:
            log_fail(f"Expected 400 for oversized Notion query, got {invalid_query.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/notion/search?offline=true&limit=10&query=project",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "notion"
            and payload.get("status") == "offline"
            and payload.get("results") == []
        ):
            log_pass("Offline Notion search avoids provider calls")
        else:
            log_fail(f"Offline Notion search returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"Notion read-only API test failed: {e}")


def test_asana_readonly(base_url: str, api_token: str):
    """Test auth, bounds, workspace validation, and offline behavior for Asana."""
    print("\n[17/17] Asana Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/asana/workspaces?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Asana workspace summary requires authentication")
        else:
            log_fail(f"Expected 401 for Asana workspace summary, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/asana/workspaces?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("Asana workspace summary enforces the 100 result bound")
        else:
            log_fail(f"Expected 400 for oversized Asana request, got {invalid_limit.status_code}")

        missing_workspace = requests.get(
            f"{base_url}/api/integrations/asana/projects?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if missing_workspace.status_code == 400:
            log_pass("Asana projects require a bounded workspace GID")
        else:
            log_fail(f"Expected 400 for missing Asana workspace, got {missing_workspace.status_code}")

        offline_workspaces = requests.get(
            f"{base_url}/api/integrations/asana/workspaces?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        workspace_payload = offline_workspaces.json()
        if (
            offline_workspaces.status_code == 200
            and workspace_payload.get("service") == "asana"
            and workspace_payload.get("status") == "offline"
            and workspace_payload.get("workspaces") == []
        ):
            log_pass("Offline Asana workspace summary avoids provider calls")
        else:
            log_fail(f"Offline Asana workspace summary returned {offline_workspaces.status_code}: {workspace_payload}")

        offline_projects = requests.get(
            f"{base_url}/api/integrations/asana/projects?offline=true&workspace=12345&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        project_payload = offline_projects.json()
        if (
            offline_projects.status_code == 200
            and project_payload.get("service") == "asana"
            and project_payload.get("status") == "offline"
            and project_payload.get("projects") == []
        ):
            log_pass("Offline Asana project summary avoids provider calls")
        else:
            log_fail(f"Offline Asana project summary returned {offline_projects.status_code}: {project_payload}")
    except Exception as e:
        log_fail(f"Asana read-only API test failed: {e}")


def test_linear_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for Linear GraphQL metadata."""
    print("\n[18/18] Linear Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/linear/teams?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Linear team summary requires authentication")
        else:
            log_fail(f"Expected 401 for Linear team summary, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/linear/teams?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("Linear team summary enforces the 100 result bound")
        else:
            log_fail(f"Expected 400 for oversized Linear request, got {invalid_limit.status_code}")

        offline_teams = requests.get(
            f"{base_url}/api/integrations/linear/teams?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        team_payload = offline_teams.json()
        if (
            offline_teams.status_code == 200
            and team_payload.get("service") == "linear"
            and team_payload.get("status") == "offline"
            and team_payload.get("teams") == []
        ):
            log_pass("Offline Linear team summary avoids provider calls")
        else:
            log_fail(f"Offline Linear team summary returned {offline_teams.status_code}: {team_payload}")

        offline_projects = requests.get(
            f"{base_url}/api/integrations/linear/projects?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        project_payload = offline_projects.json()
        if (
            offline_projects.status_code == 200
            and project_payload.get("service") == "linear"
            and project_payload.get("status") == "offline"
            and project_payload.get("projects") == []
        ):
            log_pass("Offline Linear project summary avoids provider calls")
        else:
            log_fail(f"Offline Linear project summary returned {offline_projects.status_code}: {project_payload}")
    except Exception as e:
        log_fail(f"Linear read-only API test failed: {e}")


def test_discord_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for Discord guild metadata."""
    print("\n[19/19] Discord Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/discord/guilds?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Discord guild summary requires authentication")
        else:
            log_fail(f"Expected 401 for Discord guild summary, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/discord/guilds?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("Discord guild summary enforces the 100 result bound")
        else:
            log_fail(f"Expected 400 for oversized Discord request, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/discord/guilds?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "discord"
            and payload.get("status") == "offline"
            and payload.get("guilds") == []
        ):
            log_pass("Offline Discord guild summary avoids provider calls")
        else:
            log_fail(f"Offline Discord guild summary returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"Discord read-only API test failed: {e}")


def test_whatsapp_business_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for WhatsApp Business metadata."""
    print("\n[20/20] WhatsApp Business Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/whatsapp-business/phone-numbers?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("WhatsApp phone metadata requires authentication")
        else:
            log_fail(f"Expected 401 for WhatsApp phone metadata, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/whatsapp-business/phone-numbers?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("WhatsApp phone metadata enforces the 100 result bound")
        else:
            log_fail(f"Expected 400 for oversized WhatsApp request, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/whatsapp-business/phone-numbers?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "whatsapp-business"
            and payload.get("status") == "offline"
            and payload.get("phone_numbers") == []
        ):
            log_pass("Offline WhatsApp phone metadata avoids provider calls")
        else:
            log_fail(f"Offline WhatsApp phone metadata returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"WhatsApp Business read-only API test failed: {e}")


def test_microsoft_graph_readonly(base_url: str, api_token: str):
    """Test auth and offline behavior for Microsoft Graph signed-in-user metadata."""
    print("\n[21/21] Microsoft Graph Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/microsoft-graph/me?offline=true",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Microsoft Graph profile metadata requires authentication")
        else:
            log_fail(f"Expected 401 for Microsoft Graph profile metadata, got {unauthorized.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/microsoft-graph/me?offline=true",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "microsoft-graph"
            and payload.get("status") == "offline"
            and payload.get("profile") == {}
        ):
            log_pass("Offline Microsoft Graph profile metadata avoids provider calls")
        else:
            log_fail(f"Offline Microsoft Graph profile metadata returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"Microsoft Graph read-only API test failed: {e}")


def test_zoom_readonly(base_url: str, api_token: str):
    """Test auth and offline behavior for Zoom authenticated-user metadata."""
    print("\n[22/22] Zoom Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/zoom/me?offline=true",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("Zoom profile metadata requires authentication")
        else:
            log_fail(f"Expected 401 for Zoom profile metadata, got {unauthorized.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/zoom/me?offline=true",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "zoom"
            and payload.get("status") == "offline"
            and payload.get("profile") == {}
        ):
            log_pass("Offline Zoom profile metadata avoids provider calls")
        else:
            log_fail(f"Offline Zoom profile metadata returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"Zoom read-only API test failed: {e}")


def test_monday_readonly(base_url: str, api_token: str):
    """Test auth, bounds, and offline behavior for monday.com board metadata."""
    print("\n[23/23] monday.com Read-only API")
    try:
        unauthorized = requests.get(
            f"{base_url}/api/integrations/monday/boards?offline=true&limit=10",
            timeout=2,
        )
        if unauthorized.status_code == 401:
            log_pass("monday.com board metadata requires authentication")
        else:
            log_fail(f"Expected 401 for monday.com board metadata, got {unauthorized.status_code}")

        invalid_limit = requests.get(
            f"{base_url}/api/integrations/monday/boards?offline=true&limit=101",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=2,
        )
        if invalid_limit.status_code == 400:
            log_pass("monday.com board metadata enforces the 100 result bound")
        else:
            log_fail(f"Expected 400 for oversized monday.com request, got {invalid_limit.status_code}")

        offline = requests.get(
            f"{base_url}/api/integrations/monday/boards?offline=true&limit=10",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10,
        )
        payload = offline.json()
        if (
            offline.status_code == 200
            and payload.get("service") == "monday"
            and payload.get("status") == "offline"
            and payload.get("boards") == []
        ):
            log_pass("Offline monday.com board metadata avoids provider calls")
        else:
            log_fail(f"Offline monday.com board metadata returned {offline.status_code}: {payload}")
    except Exception as e:
        log_fail(f"monday.com read-only API test failed: {e}")


def main():
    global VERBOSE, server_process, temp_db_path

    VERBOSE = "--verbose" in sys.argv

    print("=" * 60)
    print("Solo Empire API Integration Tests")
    print("=" * 60)

    try:
        # Setup
        print("\nSetting up test environment...")
        temp_db_path = setup_temp_db()
        port = find_free_port()  # Use a random free port
        api_token = "test-token-123"
        base_url = f"http://localhost:{port}"
        provider_url = start_mock_provider()

        print(f"Starting server on port {port}...")
        start_server(port, temp_db_path, api_token, provider_url)

        # Run tests
        test_health(base_url)
        test_auth_rejection(base_url)
        test_ai_gateway(base_url, api_token)
        test_retired_routes(base_url, api_token)
        test_content_allowlist(base_url, api_token)
        test_webhook_auth(base_url)
        test_content_limit_validation(base_url)
        test_external_integrations(base_url, api_token)
        test_external_discovery(base_url, api_token)
        test_sentry_readonly(base_url, api_token)
        test_posthog_readonly(base_url, api_token)
        test_slack_readonly(base_url, api_token)
        test_notion_readonly(base_url, api_token)
        test_asana_readonly(base_url, api_token)
        test_linear_readonly(base_url, api_token)
        test_discord_readonly(base_url, api_token)
        test_whatsapp_business_readonly(base_url, api_token)
        test_microsoft_graph_readonly(base_url, api_token)
        test_zoom_readonly(base_url, api_token)
        test_monday_readonly(base_url, api_token)

    except Exception as e:
        log_fail(f"Test setup failed: {e}")
    finally:
        # Cleanup
        print("\nCleaning up...")
        stop_server()
        stop_mock_provider()
        if temp_db_path and os.path.exists(temp_db_path):
            os.unlink(temp_db_path)

    print("\n" + "=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)

    if errors:
        print("\nFailures:")
        for e in errors:
            print(f"  - {e}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
