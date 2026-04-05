"""Data retention service - cleans up old events and alerts."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from phoenix_agent.storage import event_store, alert_store

logger = logging.getLogger(__name__)


class RetentionService:
    def __init__(self, retention_days: int = 7):
        self.retention_days = retention_days

    async def cleanup(self) -> dict:
        """Delete events and resolved alerts older than retention period."""
        cutoff = int(
            (datetime.now(timezone.utc) - timedelta(days=self.retention_days)).timestamp() * 1000
        )
        deleted_events = await event_store.delete_before(cutoff)
        deleted_alerts = await alert_store.delete_resolved_before(cutoff)

        logger.info(
            "Retention cleanup: deleted %d events and %d alerts",
            deleted_events,
            deleted_alerts,
        )
        return {
            "deleted_events": deleted_events,
            "deleted_alerts": deleted_alerts,
            "cutoff_timestamp": cutoff,
        }


async def start_retention_scheduler(retention_days: int = 7) -> asyncio.Task:
    """Run cleanup every hour."""
    service = RetentionService(retention_days)

    async def loop():
        while True:
            await asyncio.sleep(3600)
            try:
                await service.cleanup()
            except Exception as e:
                logger.error("Retention cleanup failed: %s", e)

    return asyncio.create_task(loop())
