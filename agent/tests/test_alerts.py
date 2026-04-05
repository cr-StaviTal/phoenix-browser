"""Tests for alert query endpoints and alert engine."""
import pytest
from tests.conftest import make_event, make_batch
from phoenix_agent.models.event import AgentEvent, Severity
from phoenix_agent.services.alert_engine import evaluate_event


class TestGetAlerts:
    async def test_empty_alerts(self, client):
        resp = await client.get("/api/alerts")
        assert resp.status_code == 200
        data = resp.json()
        assert data["alerts"] == []
        assert data["total"] == 0

    async def test_response_structure(self, client):
        resp = await client.get("/api/alerts")
        data = resp.json()
        assert "alerts" in data
        assert "total" in data
        assert "limit" in data
        assert "offset" in data

    async def test_query_with_severity_filter(self, client, db):
        # Ingest events that trigger alerts of different severities
        await client.post(
            "/api/events",
            json=make_batch([
                make_event(
                    "sev-e1",
                    event_type="threat.detected",
                    severity="high",
                    payload={"url": "https://evil.com", "threatType": "malware"},
                ),
                make_event(
                    "sev-e2",
                    event_type="dlp.sensitive_data",
                    severity="high",
                    payload={"dataType": "SSN"},
                ),
            ]),
        )

        resp = await client.get("/api/alerts", params={"severity": "critical"})
        assert resp.status_code == 200
        data = resp.json()
        assert all(a["severity"] == "critical" for a in data["alerts"])

    async def test_query_with_status_filter(self, client, db):
        # Trigger an alert
        await client.post(
            "/api/events",
            json=make_batch([
                make_event(
                    "stat-e1",
                    event_type="threat.detected",
                    severity="high",
                    payload={"url": "https://evil.com", "threatType": "phishing"},
                ),
            ]),
        )

        resp = await client.get("/api/alerts", params={"status": "open"})
        assert resp.status_code == 200
        data = resp.json()
        assert all(a["status"] == "open" for a in data["alerts"])

    async def test_pagination_limit(self, client, db):
        # Create multiple alerts
        for i in range(5):
            await client.post(
                "/api/events",
                json=make_batch([
                    make_event(
                        f"pg-e{i}",
                        event_type="threat.detected",
                        severity="high",
                        payload={"url": f"https://evil{i}.com", "threatType": "malware"},
                    )
                ]),
            )

        resp = await client.get("/api/alerts", params={"limit": 2})
        data = resp.json()
        assert len(data["alerts"]) <= 2
        assert data["limit"] == 2

    async def test_pagination_offset(self, client, db):
        for i in range(4):
            await client.post(
                "/api/events",
                json=make_batch([
                    make_event(
                        f"off-e{i}",
                        event_type="threat.detected",
                        severity="high",
                        payload={"url": f"https://evil{i}.com", "threatType": "malware"},
                    )
                ]),
            )

        resp_all = await client.get("/api/alerts", params={"limit": 100, "offset": 0})
        resp_paged = await client.get("/api/alerts", params={"limit": 2, "offset": 2})
        all_ids = {a["id"] for a in resp_all.json()["alerts"]}
        paged_ids = {a["id"] for a in resp_paged.json()["alerts"]}
        assert paged_ids.issubset(all_ids)

    async def test_invalid_status_returns_422(self, client):
        resp = await client.get("/api/alerts", params={"status": "garbage"})
        assert resp.status_code == 422


class TestAlertEngine:
    def _make_agent_event(
        self,
        event_id: str = "e1",
        event_type: str = "threat.detected",
        severity: str = "high",
        source: str = "threat-detector",
        payload: dict | None = None,
    ) -> AgentEvent:
        return AgentEvent(
            id=event_id,
            type=event_type,
            timestamp=1700000000000,
            severity=Severity(severity),
            source=source,
            payload=payload or {},
        )

    async def test_threat_detected_creates_high_alert(self, db):
        event = self._make_agent_event(
            event_type="threat.detected",
            severity="high",
            payload={"url": "https://evil.com", "threatType": "malware"},
        )
        alert = await evaluate_event(event)
        assert alert is not None
        assert alert["severity"] == "high"

    async def test_dlp_sensitive_data_creates_critical_alert(self, db):
        event = self._make_agent_event(
            event_type="dlp.sensitive_data",
            severity="medium",
            payload={"dataType": "SSN"},
        )
        alert = await evaluate_event(event)
        assert alert is not None
        assert alert["severity"] == "critical"

    async def test_extension_installed_high_risk_creates_alert(self, db):
        event = self._make_agent_event(
            event_type="extension.installed",
            severity="info",
            payload={"name": "SuspiciousExt", "riskScore": 85},
        )
        alert = await evaluate_event(event)
        assert alert is not None
        assert alert["severity"] == "high"

    async def test_extension_installed_low_risk_no_alert(self, db):
        event = self._make_agent_event(
            event_type="extension.installed",
            severity="info",
            payload={"name": "SafeExt", "riskScore": 20},
        )
        alert = await evaluate_event(event)
        assert alert is None

    async def test_low_severity_threat_detected_no_alert(self, db):
        # threat.detected requires min_severity=medium; info is below that
        event = self._make_agent_event(
            event_type="threat.detected",
            severity="info",
            payload={"url": "https://evil.com", "threatType": "malware"},
        )
        alert = await evaluate_event(event)
        assert alert is None

    async def test_unknown_event_type_no_alert(self, db):
        event = self._make_agent_event(
            event_type="nav.page_load",
            severity="info",
            payload={"url": "https://example.com"},
        )
        alert = await evaluate_event(event)
        assert alert is None

    async def test_dlp_file_upload_blocked_creates_alert(self, db):
        event = self._make_agent_event(
            event_type="dlp.file_upload",
            severity="info",
            payload={"fileName": "secret.exe", "action": "blocked"},
        )
        alert = await evaluate_event(event)
        assert alert is not None
        assert alert["severity"] == "high"

    async def test_dlp_file_upload_allowed_no_alert(self, db):
        event = self._make_agent_event(
            event_type="dlp.file_upload",
            severity="info",
            payload={"fileName": "report.pdf", "action": "allowed"},
        )
        alert = await evaluate_event(event)
        assert alert is None

    async def test_alert_has_expected_fields(self, db):
        event = self._make_agent_event(
            event_type="threat.detected",
            severity="high",
            payload={"url": "https://evil.com", "threatType": "ransomware"},
        )
        alert = await evaluate_event(event)
        assert alert is not None
        assert "id" in alert
        assert "title" in alert
        assert "severity" in alert
        assert "status" in alert
        assert alert["status"] == "open"
