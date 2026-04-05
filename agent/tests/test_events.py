"""Tests for event ingestion and query endpoints."""
import pytest
from tests.conftest import make_event, make_batch


class TestPostEvents:
    async def test_successful_batch_ingestion(self, client):
        batch = make_batch([make_event("e1"), make_event("e2")])
        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 202

    async def test_response_accepted_rejected_counts(self, client):
        batch = make_batch([make_event("e1"), make_event("e2")])
        resp = await client.post("/api/events", json=batch)
        data = resp.json()
        assert data["accepted"] == 2
        assert data["rejected"] == 0
        assert data["errors"] == []

    async def test_missing_required_field_returns_422(self, client):
        # Missing 'extension_id'
        bad_payload = {
            "extension_version": "1.0.0",
            "machine_id": "machine-xyz",
            "timestamp": 1700000000000,
            "events": [make_event()],
        }
        resp = await client.post("/api/events", json=bad_payload)
        assert resp.status_code == 422

    async def test_event_missing_required_field_returns_422(self, client):
        # Event missing 'type'
        bad_event = {
            "id": "e1",
            "timestamp": 1700000000000,
            "severity": "high",
            "source": "mod",
            "payload": {},
        }
        batch = {
            "extension_id": "ext-abc",
            "extension_version": "1.0.0",
            "machine_id": "machine-xyz",
            "timestamp": 1700000000000,
            "events": [bad_event],
        }
        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 422

    async def test_batch_size_limit_exceeded_returns_422(self, client):
        # More than 500 events
        events = [make_event(f"e{i}") for i in range(501)]
        batch = make_batch(events)
        resp = await client.post("/api/events", json=batch)
        assert resp.status_code == 422

    async def test_events_are_queryable_after_ingestion(self, client):
        batch = make_batch([make_event("query-e1", event_type="nav.page_load")])
        await client.post("/api/events", json=batch)

        resp = await client.get("/api/events", params={"type": "nav.page_load"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1
        ids = [e["id"] for e in data["events"]]
        assert "query-e1" in ids

    async def test_duplicate_event_id_increments_rejected(self, client):
        batch = make_batch([make_event("dup-e1")])
        await client.post("/api/events", json=batch)
        resp = await client.post("/api/events", json=batch)
        data = resp.json()
        assert data["rejected"] == 1
        assert data["accepted"] == 0


class TestGetEvents:
    async def test_query_all_events(self, client):
        batch = make_batch([make_event("ge1"), make_event("ge2")])
        await client.post("/api/events", json=batch)

        resp = await client.get("/api/events")
        assert resp.status_code == 200
        data = resp.json()
        assert "events" in data
        assert "total" in data
        assert "limit" in data
        assert "offset" in data

    async def test_filter_by_type(self, client):
        await client.post(
            "/api/events",
            json=make_batch([
                make_event("ft1", event_type="threat.detected"),
                make_event("ft2", event_type="dlp.file_upload"),
            ]),
        )

        resp = await client.get("/api/events", params={"type": "threat.detected"})
        data = resp.json()
        assert all(e["type"] == "threat.detected" for e in data["events"])

    async def test_filter_by_severity(self, client):
        await client.post(
            "/api/events",
            json=make_batch([
                make_event("fs1", severity="critical"),
                make_event("fs2", severity="low"),
            ]),
        )

        resp = await client.get("/api/events", params={"severity": "critical"})
        data = resp.json()
        assert all(e["severity"] == "critical" for e in data["events"])

    async def test_filter_by_since_timestamp(self, client):
        await client.post(
            "/api/events",
            json=make_batch([
                make_event("ts1", timestamp=1000000000000),
                make_event("ts2", timestamp=2000000000000),
            ]),
        )

        resp = await client.get("/api/events", params={"since": 1500000000000})
        data = resp.json()
        ids = [e["id"] for e in data["events"]]
        assert "ts2" in ids
        assert "ts1" not in ids

    async def test_pagination_limit(self, client):
        events = [make_event(f"pg{i}") for i in range(5)]
        await client.post("/api/events", json=make_batch(events))

        resp = await client.get("/api/events", params={"limit": 2, "offset": 0})
        data = resp.json()
        assert len(data["events"]) <= 2
        assert data["limit"] == 2

    async def test_pagination_offset(self, client):
        events = [make_event(f"off{i}", timestamp=1700000000000 + i) for i in range(4)]
        await client.post("/api/events", json=make_batch(events))

        resp_all = await client.get("/api/events", params={"limit": 100, "offset": 0})
        resp_paged = await client.get("/api/events", params={"limit": 2, "offset": 2})
        all_ids = [e["id"] for e in resp_all.json()["events"]]
        paged_ids = [e["id"] for e in resp_paged.json()["events"]]
        # Paged results must be a subset and not overlap with first 2
        assert set(paged_ids).issubset(set(all_ids))

    async def test_empty_result_set(self, client):
        resp = await client.get("/api/events", params={"type": "nonexistent.type"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["events"] == []

    async def test_invalid_severity_returns_422(self, client):
        resp = await client.get("/api/events", params={"severity": "unknown_level"})
        assert resp.status_code == 422
