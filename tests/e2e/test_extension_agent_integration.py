"""
End-to-end integration tests for the Phoenix Browser EDR system.

Simulates the full extension -> agent pipeline by sending HTTP requests
that mirror what the Chrome extension would send, then verifying that
alerts, events, policies, and the dashboard all behave correctly.

Uses httpx.AsyncClient with ASGITransport so no real server is needed.
"""

import time
import uuid
import sys
import pytest
import httpx
from pathlib import Path

# Ensure the agent package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

# ---------------------------------------------------------------------------
# Fixtures (reuse from agent/tests/conftest.py foundations)
# ---------------------------------------------------------------------------

# We import the shared fixtures so we get app, db, client, etc.
# The conftest.py in agent/tests already provides these.
# For the e2e directory we replicate the essentials here so the test
# file is self-contained but still creates an isolated in-memory DB.

import aiosqlite
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from phoenix_agent.api import events, alerts, policy, health
from phoenix_agent.dashboard import views
from phoenix_agent.storage import database
from phoenix_agent.api import policy as policy_module

_STATIC_DIR = Path(__file__).resolve().parent.parent / "agent" / "phoenix_agent" / "dashboard" / "static"
_POLICY_FILE = (
    Path(__file__).resolve().parent.parent / "agent" / "phoenix_agent" / "policies" / "default_policy.json"
)


@pytest.fixture
def app():
    """Create a FastAPI test application."""
    test_app = FastAPI(title="Phoenix EDR E2E")
    test_app.include_router(events.router, prefix="/api")
    test_app.include_router(alerts.router, prefix="/api")
    test_app.include_router(policy.router, prefix="/api")
    test_app.include_router(health.router, prefix="/api")
    test_app.include_router(views.router)
    if _STATIC_DIR.exists():
        test_app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")
    return test_app


@pytest.fixture(autouse=True)
def _patch_policy_path(monkeypatch):
    """Ensure policy loads from the actual default_policy.json."""
    import phoenix_agent.config as config_module
    monkeypatch.setattr(config_module.settings, "policy_path", str(_POLICY_FILE))


@pytest.fixture(autouse=True)
def _reset_policy(tmp_path, monkeypatch):
    """Reset cached policy between tests."""
    policy_module._current_policy = None
    from phoenix_agent.config import Settings
    test_settings = Settings(policy_path=str(tmp_path / "test_policy.json"))
    monkeypatch.setattr("phoenix_agent.api.policy.settings", test_settings)
    monkeypatch.setattr("phoenix_agent.config.settings", test_settings)
    yield
    policy_module._current_policy = None


@pytest.fixture
async def db(monkeypatch):
    """In-memory SQLite database for isolation."""
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row

    await conn.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            severity TEXT NOT NULL,
            source_module TEXT NOT NULL,
            extension_id TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            received_at INTEGER NOT NULL,
            batch_id TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            severity TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            title TEXT NOT NULL,
            description TEXT,
            source_event_id TEXT,
            source_module TEXT NOT NULL,
            metadata TEXT,
            resolved_at INTEGER,
            FOREIGN KEY (source_event_id) REFERENCES events(id)
        );

        CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
        CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
        CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
    """)
    await conn.commit()
    monkeypatch.setattr(database, "_db", conn)

    yield conn

    await conn.close()
    monkeypatch.setattr(database, "_db", None)


@pytest.fixture
async def client(app, db):
    """Async HTTP client backed by ASGITransport."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_event(
    event_type: str,
    severity: str = "high",
    source: str = "threat-detection",
    payload: dict | None = None,
) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": event_type,
        "timestamp": int(time.time() * 1000),
        "severity": severity,
        "source": source,
        "payload": payload or {},
    }


def _make_batch(event_list: list[dict]) -> dict:
    return {
        "extension_id": "ext-phoenix-e2e",
        "extension_version": "1.0.0",
        "machine_id": "machine-e2e-test",
        "timestamp": int(time.time() * 1000),
        "events": event_list,
    }


# ---------------------------------------------------------------------------
# a. POST /api/events with threat.detected -> verify alerts
# ---------------------------------------------------------------------------

class TestThreatDetectedFlow:
    @pytest.mark.asyncio
    async def test_threat_detected_creates_alert(self, client: httpx.AsyncClient):
        """Sending a threat.detected event should generate a high-severity alert."""
        event = _make_event(
            "threat.detected",
            severity="high",
            source="threat-detection",
            payload={"url": "https://evil.example.com", "threatType": "malware"},
        )
        batch = _make_batch([event])

        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 202
        body = resp.json()
        assert body["accepted"] == 1
        assert body["rejected"] == 0

        # Verify alert was created
        alerts_resp = await client.get("/api/alerts")
        assert alerts_resp.status_code == 200
        alerts_data = alerts_resp.json()
        assert alerts_data["total"] >= 1

        alert = alerts_data["alerts"][0]
        assert alert["severity"] == "high"
        assert alert["status"] == "open"
        assert "malware" in alert["title"].lower() or "threat" in alert["title"].lower()

    @pytest.mark.asyncio
    async def test_threat_detected_batch_multiple(self, client: httpx.AsyncClient):
        """Multiple threat events in one batch should all be accepted."""
        events = [
            _make_event("threat.detected", payload={"url": f"https://evil{i}.com", "threatType": "phishing"})
            for i in range(5)
        ]
        batch = _make_batch(events)

        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 202
        assert resp.json()["accepted"] == 5


# ---------------------------------------------------------------------------
# b. POST /api/events with dlp.sensitive_data -> verify critical alerts
# ---------------------------------------------------------------------------

class TestDlpSensitiveDataFlow:
    @pytest.mark.asyncio
    async def test_dlp_sensitive_data_creates_critical_alert(self, client: httpx.AsyncClient):
        """A dlp.sensitive_data event with medium+ severity should create a critical alert."""
        event = _make_event(
            "dlp.sensitive_data",
            severity="medium",
            source="dlp-engine",
            payload={"dataType": "ssn", "url": "https://form.example.com"},
        )
        batch = _make_batch([event])

        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 202
        assert resp.json()["accepted"] == 1

        alerts_resp = await client.get("/api/alerts")
        alerts_data = alerts_resp.json()
        assert alerts_data["total"] >= 1

        # The alert engine maps dlp.sensitive_data to critical severity
        critical_alerts = [a for a in alerts_data["alerts"] if a["severity"] == "critical"]
        assert len(critical_alerts) >= 1

    @pytest.mark.asyncio
    async def test_dlp_info_severity_does_not_create_alert(self, client: httpx.AsyncClient):
        """A dlp.sensitive_data event with info severity (below medium) should not trigger an alert."""
        event = _make_event(
            "dlp.sensitive_data",
            severity="info",
            source="dlp-engine",
            payload={"dataType": "email", "url": "https://form.example.com"},
        )
        batch = _make_batch([event])

        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 202

        alerts_resp = await client.get("/api/alerts")
        alerts_data = alerts_resp.json()
        # info < medium, so no alert should be created for this event
        assert alerts_data["total"] == 0


# ---------------------------------------------------------------------------
# c. GET /api/events with filters
# ---------------------------------------------------------------------------

class TestEventQuery:
    @pytest.mark.asyncio
    async def test_query_by_type(self, client: httpx.AsyncClient):
        """Filter events by type."""
        events = [
            _make_event("threat.detected", payload={"url": "https://x.com", "threatType": "malware"}),
            _make_event("navigation.visited", severity="info", source="url-monitor",
                        payload={"url": "https://safe.com"}),
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp = await client.get("/api/events", params={"type": "threat.detected"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["events"][0]["type"] == "threat.detected"

    @pytest.mark.asyncio
    async def test_query_by_severity(self, client: httpx.AsyncClient):
        """Filter events by severity."""
        events = [
            _make_event("threat.detected", severity="high",
                        payload={"url": "https://x.com", "threatType": "malware"}),
            _make_event("navigation.visited", severity="info", source="url-monitor",
                        payload={"url": "https://safe.com"}),
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp = await client.get("/api/events", params={"severity": "high"})
        data = resp.json()
        assert data["total"] == 1
        assert data["events"][0]["severity"] == "high"

    @pytest.mark.asyncio
    async def test_query_pagination(self, client: httpx.AsyncClient):
        """Verify limit and offset work correctly."""
        events = [
            _make_event("threat.detected", payload={"url": f"https://t{i}.com", "threatType": "malware"})
            for i in range(10)
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp = await client.get("/api/events", params={"limit": 3, "offset": 0})
        data = resp.json()
        assert data["total"] == 10
        assert len(data["events"]) == 3

        resp2 = await client.get("/api/events", params={"limit": 3, "offset": 3})
        data2 = resp2.json()
        assert len(data2["events"]) == 3
        # Pages should not overlap
        ids1 = {e["id"] for e in data["events"]}
        ids2 = {e["id"] for e in data2["events"]}
        assert ids1.isdisjoint(ids2)

    @pytest.mark.asyncio
    async def test_query_since_timestamp(self, client: httpx.AsyncClient):
        """Filter events by timestamp."""
        old_ts = 1000000000000
        new_ts = int(time.time() * 1000)

        events = [
            {**_make_event("threat.detected", payload={"url": "https://old.com", "threatType": "malware"}),
             "timestamp": old_ts},
            {**_make_event("threat.detected", payload={"url": "https://new.com", "threatType": "malware"}),
             "timestamp": new_ts},
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp = await client.get("/api/events", params={"since": new_ts - 1000})
        data = resp.json()
        assert data["total"] == 1
        assert data["events"][0]["timestamp"] == new_ts


# ---------------------------------------------------------------------------
# d. GET /api/alerts -> verify alerts generated from events
# ---------------------------------------------------------------------------

class TestAlertQuery:
    @pytest.mark.asyncio
    async def test_alerts_generated_from_threat_events(self, client: httpx.AsyncClient):
        """Alerts should be queryable after ingesting threat events."""
        events = [
            _make_event("threat.detected", payload={"url": "https://bad1.com", "threatType": "phishing"}),
            _make_event("threat.detected", payload={"url": "https://bad2.com", "threatType": "malware"}),
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp = await client.get("/api/alerts")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 2

    @pytest.mark.asyncio
    async def test_alerts_filter_by_severity(self, client: httpx.AsyncClient):
        """Query alerts filtered by severity."""
        # Threat.detected -> high alert, dlp.sensitive_data -> critical alert
        events = [
            _make_event("threat.detected", severity="high",
                        payload={"url": "https://evil.com", "threatType": "malware"}),
            _make_event("dlp.sensitive_data", severity="medium", source="dlp-engine",
                        payload={"dataType": "credit_card"}),
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp = await client.get("/api/alerts", params={"severity": "critical"})
        data = resp.json()
        # Only the DLP alert should be critical
        assert all(a["severity"] == "critical" for a in data["alerts"])

    @pytest.mark.asyncio
    async def test_alerts_contain_source_event_id(self, client: httpx.AsyncClient):
        """Each alert should reference its source event."""
        event = _make_event(
            "threat.detected",
            payload={"url": "https://evil.com", "threatType": "malware"},
        )
        await client.post("/api/events", json=_make_batch([event]))

        alerts_resp = await client.get("/api/alerts")
        data = alerts_resp.json()
        assert data["total"] >= 1
        alert = data["alerts"][0]
        assert alert["source_event_id"] == event["id"]


# ---------------------------------------------------------------------------
# e. GET /api/policy -> verify default policy
# ---------------------------------------------------------------------------

class TestPolicyEndpoints:
    @pytest.mark.asyncio
    async def test_get_default_policy(self, client: httpx.AsyncClient):
        """GET /api/policy should return a valid policy with expected fields."""
        resp = await client.get("/api/policy")
        assert resp.status_code == 200
        data = resp.json()
        assert "version" in data
        assert "threat_detection" in data
        assert "dlp" in data
        assert "extension_monitor" in data
        assert "identity_protection" in data
        assert "forensic_logger" in data
        assert "governance" in data
        assert "edr_reporter" in data

    @pytest.mark.asyncio
    async def test_policy_threat_detection_structure(self, client: httpx.AsyncClient):
        """Threat detection policy should have expected fields."""
        resp = await client.get("/api/policy")
        td = resp.json()["threat_detection"]
        assert "enabled" in td
        assert "blocked_urls" in td
        assert "blocked_domains" in td
        assert "blocked_patterns" in td
        assert "action" in td

    # ------------------------------------------------------------------
    # f. PUT /api/policy -> update, then GET returns updated
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_update_policy(self, client: httpx.AsyncClient):
        """PUT /api/policy should update the policy, and GET should reflect changes."""
        # Get current policy first
        get_resp = await client.get("/api/policy")
        current = get_resp.json()

        # Modify it
        current["version"] = "2.0.0"
        current["threat_detection"]["blocked_domains"] = ["new-evil.com"]

        put_resp = await client.put("/api/policy", json=current)
        assert put_resp.status_code == 200
        put_data = put_resp.json()
        assert put_data["version"] == "2.0.0"

        # Verify GET returns the updated policy
        verify_resp = await client.get("/api/policy")
        verify_data = verify_resp.json()
        assert verify_data["version"] == "2.0.0"
        assert "new-evil.com" in verify_data["threat_detection"]["blocked_domains"]

    @pytest.mark.asyncio
    async def test_update_policy_persists_updated_at(self, client: httpx.AsyncClient):
        """PUT /api/policy should set updated_at."""
        get_resp = await client.get("/api/policy")
        current = get_resp.json()

        put_resp = await client.put("/api/policy", json=current)
        data = put_resp.json()
        assert "updated_at" in data
        assert data["updated_at"] != ""


# ---------------------------------------------------------------------------
# g. GET /api/health -> verify health check
# ---------------------------------------------------------------------------

class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_health_returns_healthy(self, client: httpx.AsyncClient):
        """Health endpoint should return status healthy."""
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert "uptime_seconds" in data
        assert "total_events" in data

    @pytest.mark.asyncio
    async def test_health_event_count_updates(self, client: httpx.AsyncClient):
        """Health endpoint total_events should reflect ingested events."""
        # Check initial count
        resp1 = await client.get("/api/health")
        initial_count = resp1.json()["total_events"]

        # Ingest some events
        events = [
            _make_event("threat.detected", payload={"url": "https://x.com", "threatType": "malware"})
            for _ in range(3)
        ]
        await client.post("/api/events", json=_make_batch(events))

        resp2 = await client.get("/api/health")
        new_count = resp2.json()["total_events"]
        assert new_count == initial_count + 3


# ---------------------------------------------------------------------------
# h. GET /dashboard -> verify HTML dashboard loads
# ---------------------------------------------------------------------------

class TestDashboard:
    @pytest.mark.asyncio
    async def test_dashboard_returns_html(self, client: httpx.AsyncClient):
        """Dashboard should return an HTML page."""
        resp = await client.get("/dashboard")
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_dashboard_contains_title(self, client: httpx.AsyncClient):
        """Dashboard HTML should contain a recognizable title or heading."""
        resp = await client.get("/dashboard")
        text = resp.text.lower()
        assert "phoenix" in text or "dashboard" in text or "edr" in text


# ---------------------------------------------------------------------------
# i. Full scenario: browsing session with navigation + threat + dlp events
# ---------------------------------------------------------------------------

class TestFullBrowsingSession:
    @pytest.mark.asyncio
    async def test_complete_browsing_session(self, client: httpx.AsyncClient):
        """
        Simulate a realistic browsing session:
        1. User navigates to several safe pages (navigation.visited)
        2. User visits a phishing page (threat.detected + threat.blocked)
        3. User pastes sensitive data on a form (dlp.sensitive_data)
        4. Verify all events are stored and appropriate alerts are generated.
        """
        now = int(time.time() * 1000)

        # Step 1: Safe navigation events
        safe_events = [
            _make_event(
                "navigation.visited",
                severity="info",
                source="url-monitor",
                payload={"url": "https://google.com/search?q=test", "tabId": 1},
            ),
            _make_event(
                "navigation.visited",
                severity="info",
                source="url-monitor",
                payload={"url": "https://github.com/repo", "tabId": 1},
            ),
            _make_event(
                "navigation.visited",
                severity="info",
                source="url-monitor",
                payload={"url": "https://docs.python.org/3/", "tabId": 2},
            ),
        ]

        # Step 2: Threat events
        threat_events = [
            _make_event(
                "threat.detected",
                severity="high",
                source="threat-detection",
                payload={
                    "url": "https://evil-phishing.example.com/login",
                    "threatType": "phishing",
                    "action": "blocked",
                    "tabId": 1,
                    "matchedRule": "evil-phishing.example.com",
                },
            ),
            _make_event(
                "threat.blocked",
                severity="high",
                source="threat-detection",
                payload={
                    "url": "https://evil-phishing.example.com/login",
                    "action": "blocked",
                    "tabId": 1,
                },
            ),
        ]

        # Step 3: DLP events
        dlp_events = [
            _make_event(
                "dlp.sensitive_data",
                severity="medium",
                source="dlp-engine",
                payload={
                    "dataType": "ssn",
                    "url": "https://shady-form.example.com/apply",
                    "tabId": 3,
                    "action": "warned",
                },
            ),
            _make_event(
                "dlp.sensitive_data",
                severity="high",
                source="dlp-engine",
                payload={
                    "dataType": "credit_card",
                    "url": "https://checkout.example.com/pay",
                    "tabId": 4,
                    "action": "blocked",
                },
            ),
        ]

        # Send all events in one batch
        all_events = safe_events + threat_events + dlp_events
        batch = _make_batch(all_events)

        ingest_resp = await client.post("/api/events", json=batch)
        assert ingest_resp.status_code == 202
        ingest_data = ingest_resp.json()
        assert ingest_data["accepted"] == len(all_events)
        assert ingest_data["rejected"] == 0

        # Verify all events are stored
        events_resp = await client.get("/api/events", params={"limit": 100})
        events_data = events_resp.json()
        assert events_data["total"] == len(all_events)

        # Verify navigation events stored correctly
        nav_resp = await client.get("/api/events", params={"type": "navigation.visited"})
        assert nav_resp.json()["total"] == 3

        # Verify threat events
        threat_resp = await client.get("/api/events", params={"type": "threat.detected"})
        assert threat_resp.json()["total"] == 1

        # Verify DLP events
        dlp_resp = await client.get("/api/events", params={"type": "dlp.sensitive_data"})
        assert dlp_resp.json()["total"] == 2

        # Verify alerts were generated
        alerts_resp = await client.get("/api/alerts")
        alerts_data = alerts_resp.json()

        # Expected alerts:
        # - threat.detected (high severity) -> high alert
        # - threat.blocked (high severity) -> medium alert
        # - dlp.sensitive_data (medium) -> critical alert
        # - dlp.sensitive_data (high) -> critical alert
        assert alerts_data["total"] >= 3  # at minimum threat + 2 DLP

        # Verify severity distribution
        severities = [a["severity"] for a in alerts_data["alerts"]]
        assert "critical" in severities  # from DLP sensitive data
        assert "high" in severities  # from threat.detected

        # All alerts should be open
        assert all(a["status"] == "open" for a in alerts_data["alerts"])

        # Verify health reflects all events
        health_resp = await client.get("/api/health")
        health_data = health_resp.json()
        assert health_data["status"] == "healthy"
        assert health_data["total_events"] == len(all_events)

        # Verify dashboard still loads after data ingestion
        dash_resp = await client.get("/dashboard")
        assert dash_resp.status_code == 200

    @pytest.mark.asyncio
    async def test_sequential_batches(self, client: httpx.AsyncClient):
        """
        Simulate multiple batch submissions over time, verifying cumulative state.
        """
        # Batch 1: navigation
        batch1 = _make_batch([
            _make_event("navigation.visited", severity="info", source="url-monitor",
                        payload={"url": "https://safe1.com"}),
            _make_event("navigation.visited", severity="info", source="url-monitor",
                        payload={"url": "https://safe2.com"}),
        ])
        resp1 = await client.post("/api/events", json=batch1)
        assert resp1.json()["accepted"] == 2

        # Batch 2: threats
        batch2 = _make_batch([
            _make_event("threat.detected", severity="high",
                        payload={"url": "https://bad.com", "threatType": "malware"}),
        ])
        resp2 = await client.post("/api/events", json=batch2)
        assert resp2.json()["accepted"] == 1

        # Batch 3: DLP
        batch3 = _make_batch([
            _make_event("dlp.sensitive_data", severity="medium", source="dlp-engine",
                        payload={"dataType": "ssn"}),
        ])
        resp3 = await client.post("/api/events", json=batch3)
        assert resp3.json()["accepted"] == 1

        # Verify cumulative total
        all_events = await client.get("/api/events", params={"limit": 100})
        assert all_events.json()["total"] == 4

        # Verify cumulative alerts
        all_alerts = await client.get("/api/alerts")
        assert all_alerts.json()["total"] >= 2  # threat + DLP

    @pytest.mark.asyncio
    async def test_policy_affects_session_context(self, client: httpx.AsyncClient):
        """
        Update policy, then verify it can be retrieved alongside event data.
        This tests that policy and event systems coexist correctly.
        """
        # Update policy with custom blocked domains
        get_resp = await client.get("/api/policy")
        policy_data = get_resp.json()
        policy_data["version"] = "3.0.0"
        policy_data["threat_detection"]["blocked_domains"] = [
            "evil1.com",
            "evil2.com",
        ]

        put_resp = await client.put("/api/policy", json=policy_data)
        assert put_resp.status_code == 200

        # Ingest events
        events = [
            _make_event("threat.detected", payload={"url": "https://evil1.com", "threatType": "blocklisted"}),
        ]
        await client.post("/api/events", json=_make_batch(events))

        # Verify both systems return correct data
        policy_resp = await client.get("/api/policy")
        assert policy_resp.json()["version"] == "3.0.0"
        assert "evil1.com" in policy_resp.json()["threat_detection"]["blocked_domains"]

        events_resp = await client.get("/api/events")
        assert events_resp.json()["total"] == 1
