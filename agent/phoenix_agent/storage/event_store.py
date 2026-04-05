"""Event storage operations."""
import json
import time
from phoenix_agent.storage.database import get_db


async def insert_events(
    events: list[dict],
    extension_id: str,
    machine_id: str,
    batch_id: str,
) -> tuple[int, int, list[str]]:
    """Insert a batch of events. Returns (accepted, rejected, errors)."""
    db = await get_db()
    accepted = 0
    rejected = 0
    errors: list[str] = []
    received_at = int(time.time() * 1000)

    for event in events:
        try:
            await db.execute(
                """INSERT INTO events (id, type, timestamp, severity, source_module,
                   extension_id, machine_id, payload, received_at, batch_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    event["id"],
                    event["type"],
                    event["timestamp"],
                    event["severity"],
                    event["source"],
                    extension_id,
                    machine_id,
                    json.dumps(event["payload"]),
                    received_at,
                    batch_id,
                ),
            )
            accepted += 1
        except Exception as e:
            rejected += 1
            errors.append(f"Event {event.get('id', 'unknown')}: {str(e)}")

    await db.commit()
    return accepted, rejected, errors


async def query_events(
    event_type: str | None = None,
    severity: str | None = None,
    since: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Query events with filters. Returns (events, total_count)."""
    db = await get_db()
    conditions: list[str] = []
    params: list = []

    if event_type:
        conditions.append("type = ?")
        params.append(event_type)
    if severity:
        conditions.append("severity = ?")
        params.append(severity)
    if since:
        conditions.append("timestamp >= ?")
        params.append(since)

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    # Get total count
    cursor = await db.execute(f"SELECT COUNT(*) FROM events WHERE {where_clause}", params)
    row = await cursor.fetchone()
    total = row[0]

    # Get paginated results
    cursor = await db.execute(
        f"""SELECT * FROM events WHERE {where_clause}
            ORDER BY timestamp DESC LIMIT ? OFFSET ?""",
        params + [limit, offset],
    )
    rows = await cursor.fetchall()
    events = []
    for row in rows:
        events.append({
            "id": row["id"],
            "type": row["type"],
            "timestamp": row["timestamp"],
            "severity": row["severity"],
            "source": row["source_module"],
            "payload": json.loads(row["payload"]),
            "received_at": row["received_at"],
        })

    return events, total


async def delete_before(cutoff_timestamp: int) -> int:
    """Delete events older than cutoff. Returns count deleted."""
    db = await get_db()
    cursor = await db.execute("DELETE FROM events WHERE timestamp < ?", (cutoff_timestamp,))
    await db.commit()
    return cursor.rowcount


async def get_event_count() -> int:
    """Get total event count."""
    db = await get_db()
    cursor = await db.execute("SELECT COUNT(*) FROM events")
    row = await cursor.fetchone()
    return row[0]
