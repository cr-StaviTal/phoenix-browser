"""Health check endpoint."""
import time
from fastapi import APIRouter
from phoenix_agent.storage import event_store

router = APIRouter(tags=["health"])

_start_time = time.time()


@router.get("/health")
async def health_check():
    """Return agent health status."""
    event_count = await event_store.get_event_count()
    uptime = int(time.time() - _start_time)

    return {
        "status": "healthy",
        "uptime_seconds": uptime,
        "total_events": event_count,
    }
