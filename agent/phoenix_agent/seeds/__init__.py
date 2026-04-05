"""Seed data loading for Phoenix EDR Agent."""
import json
import logging
from pathlib import Path

from phoenix_agent.storage.database import get_db
from phoenix_agent.models.rules import PhoenixRule

logger = logging.getLogger(__name__)

_SEEDS_DIR = Path(__file__).parent


async def load_default_rules() -> int:
    """Load default rules from JSON seed file if the rules table is empty.

    Returns the number of rules loaded.
    """
    db = await get_db()
    cursor = await db.execute("SELECT COUNT(*) FROM rules")
    row = await cursor.fetchone()
    if row[0] > 0:
        logger.debug("Rules table already has %d rules, skipping seed.", row[0])
        return 0

    seed_path = _SEEDS_DIR / "default_rules.json"
    if not seed_path.exists():
        logger.warning("Seed file not found: %s", seed_path)
        return 0

    with open(seed_path) as f:
        seed_data = json.load(f)

    loaded = 0
    for rule_data in seed_data:
        try:
            rule = PhoenixRule(**rule_data)
            rule_dict = rule.model_dump()
            await db.execute(
                """INSERT INTO rules (id, name, description, version, enabled, severity,
                   author, tags, match_config, actions, run_once_per_page, cooldown_ms,
                   priority, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rule_dict["id"],
                    rule_dict["name"],
                    rule_dict["description"],
                    rule_dict["version"],
                    1 if rule_dict["enabled"] else 0,
                    rule_dict["severity"],
                    rule_dict["author"],
                    json.dumps(rule_dict["tags"]),
                    json.dumps(rule_dict["match"]),
                    json.dumps(rule_dict["actions"]),
                    1 if rule_dict["run_once_per_page"] else 0,
                    rule_dict["cooldown_ms"],
                    rule_dict["priority"],
                    rule_dict["created_at"],
                    rule_dict["updated_at"],
                ),
            )
            loaded += 1
        except Exception as e:
            logger.error("Failed to load seed rule '%s': %s", rule_data.get("name", "unknown"), e)

    await db.commit()
    logger.info("Loaded %d default rules from seed file.", loaded)
    return loaded
