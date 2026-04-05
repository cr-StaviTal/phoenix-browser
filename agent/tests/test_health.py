"""Tests for the health check endpoint."""
import pytest


class TestGetHealth:
    async def test_returns_200(self, client):
        resp = await client.get("/api/health")
        assert resp.status_code == 200

    async def test_returns_healthy_status(self, client):
        resp = await client.get("/api/health")
        data = resp.json()
        assert data["status"] == "healthy"

    async def test_uptime_is_non_negative(self, client):
        resp = await client.get("/api/health")
        data = resp.json()
        assert "uptime_seconds" in data
        assert data["uptime_seconds"] >= 0

    async def test_total_events_field_present(self, client):
        resp = await client.get("/api/health")
        data = resp.json()
        assert "total_events" in data

    async def test_total_events_is_integer(self, client):
        resp = await client.get("/api/health")
        data = resp.json()
        assert isinstance(data["total_events"], int)

    async def test_total_events_increases_after_ingestion(self, client):
        from tests.conftest import make_batch, make_event

        resp_before = await client.get("/api/health")
        before_count = resp_before.json()["total_events"]

        await client.post("/api/events", json=make_batch([make_event("health-e1")]))

        resp_after = await client.get("/api/health")
        after_count = resp_after.json()["total_events"]
        assert after_count == before_count + 1
