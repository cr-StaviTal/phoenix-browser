"""SQLite database initialization and connection management."""
import aiosqlite
from pathlib import Path

_db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    """Get the database connection, initializing if needed."""
    global _db
    if _db is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return _db


async def init_db(db_path: str = "phoenix_edr.db") -> None:
    """Initialize the database and create tables."""
    global _db
    _db = await aiosqlite.connect(db_path)
    _db.row_factory = aiosqlite.Row

    await _db.executescript("""
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
    await _db.commit()

    # Seed default rules on first startup
    from phoenix_agent.seeds import load_default_rules
    await load_default_rules()


async def close_db() -> None:
    """Close the database connection."""
    global _db
    if _db is not None:
        await _db.close()
        _db = None
