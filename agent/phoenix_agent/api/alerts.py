"""Alert query endpoints."""
from fastapi import APIRouter, Query

from phoenix_agent.models.event import Severity
from phoenix_agent.models.alert import AlertStatus
from phoenix_agent.storage import alert_store

router = APIRouter(tags=["alerts"])


@router.get("/alerts")
async def query_alerts(
    severity: Severity | None = Query(None),
    status: AlertStatus | None = Query(None),
    since: int | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Query alerts with filters."""
    alerts, total = await alert_store.query_alerts(
        severity=severity.value if severity else None,
        status=status.value if status else None,
        since=since,
        limit=limit,
        offset=offset,
    )
    return {"alerts": alerts, "total": total, "limit": limit, "offset": offset}
