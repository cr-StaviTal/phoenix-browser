"""Event ingestion and query endpoints."""
import uuid
from fastapi import APIRouter, Query

from phoenix_agent.models.event import (
    EventBatchRequest,
    EventBatchResponse,
    Severity,
)
from phoenix_agent.storage import event_store
from phoenix_agent.services.alert_engine import evaluate_batch

router = APIRouter(tags=["events"])


@router.post("/events", response_model=EventBatchResponse, status_code=202)
async def ingest_events(batch: EventBatchRequest):
    """Receive a batch of events from the extension."""
    batch_id = str(uuid.uuid4())

    events_dicts = [e.model_dump() for e in batch.events]
    accepted, rejected, errors = await event_store.insert_events(
        events=events_dicts,
        extension_id=batch.extension_id,
        machine_id=batch.machine_id,
        batch_id=batch_id,
    )

    # Evaluate events for alert generation
    await evaluate_batch(batch.events)

    return EventBatchResponse(accepted=accepted, rejected=rejected, errors=errors)


@router.get("/events")
async def query_events(
    type: str | None = Query(None),
    severity: Severity | None = Query(None),
    since: int | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Query stored events with filters."""
    events, total = await event_store.query_events(
        event_type=type,
        severity=severity.value if severity else None,
        since=since,
        limit=limit,
        offset=offset,
    )
    return {"events": events, "total": total, "limit": limit, "offset": offset}
