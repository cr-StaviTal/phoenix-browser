"""Alert storage operations."""
import json
import time
import uuid
from phoenix_agent.storage.database import get_db


async def create_alert(
    severity: str,
    title: str,
    source_module: str,
    description: str | None = None,
    source_event_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """Create a new alert. Returns the created alert."""
    db = await get_db()
    alert_id = str(uuid.uuid4())
    created_at = int(time.time() * 1000)

    await db.execute(
        """INSERT INTO alerts (id, created_at, severity, status, title, description,
           source_event_id, source_module, metadata)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)""",
        (
            alert_id,
            created_at,
            severity,
            title,
            description,
            source_event_id,
            source_module,
            json.dumps(metadata or {}),
        ),
    )
    await db.commit()

    return {
        "id": alert_id,
        "created_at": created_at,
        "severity": severity,
        "status": "open",
        "title": title,
        "description": description,
        "source_event_id": source_event_id,
        "source_module": source_module,
        "metadata": metadata or {},
    }


async def query_alerts(
    severity: str | None = None,
    status: str | None = None,
    since: int | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Query alerts with filters. Returns (alerts, total_count)."""
    db = await get_db()
    conditions: list[str] = []
    params: list = []

    if severity:
        conditions.append("severity = ?")
        params.append(severity)
    if status:
        conditions.append("status = ?")
        params.append(status)
    if since:
        conditions.append("created_at >= ?")
        params.append(since)

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    cursor = await db.execute(f"SELECT COUNT(*) FROM alerts WHERE {where_clause}", params)
    row = await cursor.fetchone()
    total = row[0]

    cursor = await db.execute(
        f"""SELECT * FROM alerts WHERE {where_clause}
            ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        params + [limit, offset],
    )
    rows = await cursor.fetchall()
    alerts = []
    for row in rows:
        alerts.append({
            "id": row["id"],
            "created_at": row["created_at"],
            "severity": row["severity"],
            "status": row["status"],
            "title": row["title"],
            "description": row["description"],
            "source_event_id": row["source_event_id"],
            "source_module": row["source_module"],
            "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
        })

    return alerts, total


async def delete_resolved_before(cutoff_timestamp: int) -> int:
    """Delete resolved alerts older than cutoff."""
    db = await get_db()
    cursor = await db.execute(
        "DELETE FROM alerts WHERE status = 'resolved' AND created_at < ?",
        (cutoff_timestamp,),
    )
    await db.commit()
    return cursor.rowcount
