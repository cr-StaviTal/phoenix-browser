"""Tests for the dashboard HTML views."""
import pytest


class TestDashboardMain:
    async def test_returns_200(self, client):
        resp = await client.get("/dashboard")
        assert resp.status_code == 200

    async def test_returns_html_content_type(self, client):
        resp = await client.get("/dashboard")
        assert "text/html" in resp.headers["content-type"]

    async def test_contains_phoenix_edr(self, client):
        resp = await client.get("/dashboard")
        assert "Phoenix EDR" in resp.text

    async def test_contains_events_section(self, client):
        resp = await client.get("/dashboard")
        # The template includes "Recent Events" heading
        assert "Events" in resp.text

    async def test_contains_alerts_section(self, client):
        resp = await client.get("/dashboard")
        assert "Alerts" in resp.text


class TestDashboardAlerts:
    async def test_alerts_page_returns_200(self, client):
        resp = await client.get("/dashboard/alerts")
        assert resp.status_code == 200

    async def test_alerts_page_returns_html(self, client):
        resp = await client.get("/dashboard/alerts")
        assert "text/html" in resp.headers["content-type"]

    async def test_alerts_page_has_content(self, client):
        resp = await client.get("/dashboard/alerts")
        # Page should render something meaningful
        assert len(resp.text) > 0
