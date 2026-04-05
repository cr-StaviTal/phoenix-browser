"""Test configuration and shared fixtures."""
import pytest
import aiosqlite
import httpx
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
from pathlib import Path

from phoenix_agent.api import events, alerts, policy, health, rules
from phoenix_agent.dashboard import views
from phoenix_agent.storage import database
from phoenix_agent.api import policy as policy_module

_STATIC_DIR = Path(__file__).parent.parent / "phoenix_agent" / "dashboard" / "static"
_POLICY_FILE = Path(__file__).parent.parent / "phoenix_agent" / "policies" / "default_policy.json"


@pytest.fixture
def app():
    """Create a FastAPI test application without lifespan (DB managed by fixture)."""
    test_app = FastAPI(title="Phoenix EDR Test")
    test_app.include_router(events.router, prefix="/api")
    test_app.include_router(alerts.router, prefix="/api")
    test_app.include_router(policy.router, prefix="/api")
    test_app.include_router(health.router, prefix="/api")
    test_app.include_router(rules.router, prefix="/api")
    test_app.include_router(views.router)
    if _STATIC_DIR.exists():
        test_app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")
    return test_app


@pytest.fixture(autouse=True)
def patch_policy_path(monkeypatch):
    """Ensure policy tests always load from the actual default_policy.json."""
    import phoenix_agent.config as config_module
    monkeypatch.setattr(config_module.settings, "policy_path", str(_POLICY_FILE))


@pytest.fixture
async def db(monkeypatch):
    """Create an in-memory SQLite database and patch the global _db."""
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

        CREATE TABLE IF NOT EXISTS rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1,
            enabled INTEGER NOT NULL DEFAULT 1,
            severity TEXT NOT NULL DEFAULT 'medium',
            author TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            match_config TEXT NOT NULL,
            actions TEXT NOT NULL,
            run_once_per_page INTEGER NOT NULL DEFAULT 1,
            cooldown_ms INTEGER NOT NULL DEFAULT 0,
            priority INTEGER NOT NULL DEFAULT 100,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);
        CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority DESC);

        CREATE TABLE IF NOT EXISTS rule_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id TEXT NOT NULL,
            action TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT,
            changed_at TEXT NOT NULL,
            changed_by TEXT NOT NULL DEFAULT 'dashboard'
        );
    """)
    await conn.commit()

    monkeypatch.setattr(database, "_db", conn)

    yield conn

    await conn.close()
    monkeypatch.setattr(database, "_db", None)


@pytest.fixture(autouse=True)
def reset_policy(tmp_path, monkeypatch):
    """Reset the policy module's cached policy and use temp file for writes."""
    policy_module._current_policy = None
    # Create a fake settings object with policy_path pointing to temp dir
    test_policy_path = str(tmp_path / "test_policy.json")
    from phoenix_agent.config import Settings
    test_settings = Settings(policy_path=test_policy_path)
    # Patch settings in both config module and policy module
    monkeypatch.setattr("phoenix_agent.api.policy.settings", test_settings)
    monkeypatch.setattr("phoenix_agent.config.settings", test_settings)
    yield
    policy_module._current_policy = None


@pytest.fixture
async def client(app, db):
    """Create an async HTTP test client."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


def make_event(
    event_id: str = "evt-001",
    event_type: str = "threat.detected",
    severity: str = "high",
    source: str = "threat-detector",
    timestamp: int = 1700000000000,
    payload: dict | None = None,
) -> dict:
    """Build a valid event dict for use in batch requests."""
    return {
        "id": event_id,
        "type": event_type,
        "timestamp": timestamp,
        "severity": severity,
        "source": source,
        "payload": payload or {"url": "https://evil.example.com", "threatType": "malware"},
    }


def make_batch(events: list[dict] | None = None) -> dict:
    """Build a valid EventBatchRequest dict."""
    return {
        "extension_id": "ext-abc123",
        "extension_version": "1.0.0",
        "machine_id": "machine-xyz",
        "timestamp": 1700000000000,
        "events": events or [make_event()],
    }
