"""Tests for policy management endpoints."""
import pytest


class TestGetPolicy:
    async def test_returns_default_policy(self, client):
        resp = await client.get("/api/policy")
        assert resp.status_code == 200

    async def test_policy_has_correct_structure(self, client):
        resp = await client.get("/api/policy")
        data = resp.json()
        assert "version" in data
        assert "threat_detection" in data
        assert "dlp" in data
        assert "extension_monitor" in data
        assert "identity_protection" in data
        assert "forensic_logger" in data
        assert "governance" in data
        assert "edr_reporter" in data

    async def test_default_policy_version(self, client):
        resp = await client.get("/api/policy")
        data = resp.json()
        assert data["version"] == "1.0.0"

    async def test_default_threat_detection_enabled(self, client):
        resp = await client.get("/api/policy")
        data = resp.json()
        assert data["threat_detection"]["enabled"] is True

    async def test_default_dlp_enabled(self, client):
        resp = await client.get("/api/policy")
        data = resp.json()
        assert data["dlp"]["enabled"] is True


class TestPutPolicy:
    async def test_update_policy_with_valid_data(self, client):
        new_policy = {
            "version": "2.0.0",
            "updated_at": "",
            "threat_detection": {
                "enabled": False,
                "blocked_urls": ["https://blocked.com"],
                "blocked_domains": [],
                "blocked_patterns": [],
                "action": "warn",
            },
            "dlp": {
                "enabled": True,
                "file_upload": {
                    "blocked_extensions": [".exe"],
                    "max_file_size_mb": 10,
                    "blocked_domains": [],
                },
                "clipboard": {"monitor_paste": True, "monitor_copy": False},
                "sensitive_patterns": {
                    "ssn": True,
                    "credit_card": False,
                    "email": True,
                    "custom_patterns": [],
                },
            },
            "extension_monitor": {
                "enabled": True,
                "blocked_extensions": [],
                "max_permissions_risk_score": 80,
                "auto_disable_risky": False,
            },
            "identity_protection": {
                "enabled": True,
                "monitored_domains": ["corp.example.com"],
                "alert_on_session_cookie_removal": True,
            },
            "forensic_logger": {
                "enabled": True,
                "retention_days": 14,
                "max_storage_mb": 100,
            },
            "governance": {
                "copy_paste_restrictions": [],
                "download_restrictions": {
                    "blocked_extensions": [".torrent"],
                    "require_scan": False,
                },
            },
            "edr_reporter": {
                "endpoint": "http://localhost:8745/api",
                "batch_interval_seconds": 60,
                "max_batch_size": 200,
                "retry_attempts": 3,
                "retry_backoff_ms": 1000,
            },
        }
        resp = await client.put("/api/policy", json=new_policy)
        assert resp.status_code == 200
        data = resp.json()
        assert data["version"] == "2.0.0"
        assert "updated_at" in data

    async def test_updated_policy_returned_on_next_get(self, client):
        new_policy = {
            "version": "3.0.0",
            "updated_at": "",
            "threat_detection": {
                "enabled": False,
                "blocked_urls": [],
                "blocked_domains": [],
                "blocked_patterns": [],
                "action": "block",
            },
            "dlp": {
                "enabled": False,
                "file_upload": {
                    "blocked_extensions": [],
                    "max_file_size_mb": 25,
                    "blocked_domains": [],
                },
                "clipboard": {"monitor_paste": False, "monitor_copy": False},
                "sensitive_patterns": {
                    "ssn": False,
                    "credit_card": False,
                    "email": False,
                    "custom_patterns": [],
                },
            },
            "extension_monitor": {
                "enabled": False,
                "blocked_extensions": [],
                "max_permissions_risk_score": 70,
                "auto_disable_risky": False,
            },
            "identity_protection": {
                "enabled": False,
                "monitored_domains": [],
                "alert_on_session_cookie_removal": False,
            },
            "forensic_logger": {
                "enabled": False,
                "retention_days": 7,
                "max_storage_mb": 80,
            },
            "governance": {
                "copy_paste_restrictions": [],
                "download_restrictions": {
                    "blocked_extensions": [],
                    "require_scan": False,
                },
            },
            "edr_reporter": {
                "endpoint": "http://localhost:8745/api",
                "batch_interval_seconds": 30,
                "max_batch_size": 500,
                "retry_attempts": 3,
                "retry_backoff_ms": 1000,
            },
        }
        await client.put("/api/policy", json=new_policy)

        resp = await client.get("/api/policy")
        data = resp.json()
        assert data["version"] == "3.0.0"
        assert data["threat_detection"]["enabled"] is False

    async def test_invalid_policy_structure_returns_422(self, client):
        bad_policy = {"version": 999, "threat_detection": "not-an-object"}
        resp = await client.put("/api/policy", json=bad_policy)
        assert resp.status_code == 422
