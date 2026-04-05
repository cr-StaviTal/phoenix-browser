"""Rule storage operations."""
import json
from datetime import datetime, timezone
from phoenix_agent.storage.database import get_db


async def insert_rule(rule: dict) -> dict:
    """Insert a new rule into the database. Returns the inserted rule."""
    db = await get_db()
    await db.execute(
        """INSERT INTO rules (id, name, description, version, enabled, severity,
           author, tags, match_config, actions, run_once_per_page, cooldown_ms,
           priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            rule["id"],
            rule["name"],
            rule.get("description", ""),
            rule.get("version", 1),
            1 if rule.get("enabled", True) else 0,
            rule.get("severity", "medium"),
            rule.get("author", ""),
            json.dumps(rule.get("tags", [])),
            json.dumps(rule["match"]),
            json.dumps(rule["actions"]),
            1 if rule.get("run_once_per_page", True) else 0,
            rule.get("cooldown_ms", 0),
            rule.get("priority", 100),
            rule["created_at"],
            rule["updated_at"],
        ),
    )
    await db.commit()
    await insert_audit(rule["id"], "created", None, json.dumps(rule))
    return rule


async def get_rule(rule_id: str) -> dict | None:
    """Get a rule by ID. Returns None if not found."""
    db = await get_db()
    cursor = await db.execute("SELECT * FROM rules WHERE id = ?", (rule_id,))
    row = await cursor.fetchone()
    if row is None:
        return None
    return _row_to_dict(row)


async def list_rules(enabled_only: bool = False) -> list[dict]:
    """List all rules, ordered by priority DESC."""
    db = await get_db()
    if enabled_only:
        cursor = await db.execute(
            "SELECT * FROM rules WHERE enabled = 1 ORDER BY priority DESC"
        )
    else:
        cursor = await db.execute("SELECT * FROM rules ORDER BY priority DESC")
    rows = await cursor.fetchall()
    return [_row_to_dict(row) for row in rows]


async def update_rule(rule_id: str, updates: dict) -> dict | None:
    """Update a rule's fields and bump version. Returns updated rule or None."""
    db = await get_db()
    existing = await get_rule(rule_id)
    if existing is None:
        return None

    old_value = json.dumps(existing)

    # Apply updates
    for key, value in updates.items():
        if value is not None:
            existing[key] = value

    existing["version"] = existing.get("version", 1) + 1
    existing["updated_at"] = datetime.now(timezone.utc).isoformat()

    await db.execute(
        """UPDATE rules SET name=?, description=?, version=?, enabled=?, severity=?,
           author=?, tags=?, match_config=?, actions=?, run_once_per_page=?,
           cooldown_ms=?, priority=?, updated_at=?
           WHERE id=?""",
        (
            existing["name"],
            existing["description"],
            existing["version"],
            1 if existing["enabled"] else 0,
            existing["severity"],
            existing["author"],
            json.dumps(existing["tags"]),
            json.dumps(existing["match"]),
            json.dumps(existing["actions"]),
            1 if existing["run_once_per_page"] else 0,
            existing["cooldown_ms"],
            existing["priority"],
            existing["updated_at"],
            rule_id,
        ),
    )
    await db.commit()
    await insert_audit(rule_id, "updated", old_value, json.dumps(existing))
    return existing


async def delete_rule(rule_id: str, hard: bool = False) -> bool:
    """Delete a rule. Soft delete sets enabled=false; hard delete removes the row."""
    db = await get_db()
    existing = await get_rule(rule_id)
    if existing is None:
        return False

    if hard:
        await db.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
        await insert_audit(rule_id, "hard_deleted", json.dumps(existing), None)
    else:
        await db.execute(
            "UPDATE rules SET enabled = 0, updated_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), rule_id),
        )
        await insert_audit(rule_id, "soft_deleted", json.dumps(existing), None)

    await db.commit()
    return True


async def toggle_rule(rule_id: str) -> dict | None:
    """Toggle a rule's enabled state. Returns updated rule or None."""
    existing = await get_rule(rule_id)
    if existing is None:
        return None

    new_enabled = not existing["enabled"]
    return await update_rule(rule_id, {"enabled": new_enabled})


async def get_rule_audit(rule_id: str) -> list[dict]:
    """Get audit log entries for a rule."""
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM rule_audit WHERE rule_id = ? ORDER BY changed_at DESC",
        (rule_id,),
    )
    rows = await cursor.fetchall()
    return [
        {
            "id": row["id"],
            "rule_id": row["rule_id"],
            "action": row["action"],
            "old_value": row["old_value"],
            "new_value": row["new_value"],
            "changed_at": row["changed_at"],
            "changed_by": row["changed_by"],
        }
        for row in rows
    ]


async def insert_audit(
    rule_id: str, action: str, old_value: str | None, new_value: str | None
) -> None:
    """Log a change to the rule audit table."""
    db = await get_db()
    await db.execute(
        """INSERT INTO rule_audit (rule_id, action, old_value, new_value, changed_at, changed_by)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            rule_id,
            action,
            old_value,
            new_value,
            datetime.now(timezone.utc).isoformat(),
            "dashboard",
        ),
    )
    await db.commit()


def _row_to_dict(row) -> dict:
    """Convert a database row to a rule dict."""
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "version": row["version"],
        "enabled": bool(row["enabled"]),
        "severity": row["severity"],
        "author": row["author"],
        "tags": json.loads(row["tags"]),
        "match": json.loads(row["match_config"]),
        "actions": json.loads(row["actions"]),
        "run_once_per_page": bool(row["run_once_per_page"]),
        "cooldown_ms": row["cooldown_ms"],
        "priority": row["priority"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
