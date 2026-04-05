"""Event models for EDR event ingestion."""
from enum import Enum
from pydantic import BaseModel, Field


class Severity(str, Enum):
    info = "info"
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class AgentEvent(BaseModel):
    id: str
    type: str
    timestamp: int
    severity: Severity
    source: str
    payload: dict


class EventBatchRequest(BaseModel):
    extension_id: str
    extension_version: str
    machine_id: str
    timestamp: int
    events: list[AgentEvent] = Field(max_length=500)


class EventBatchResponse(BaseModel):
    accepted: int
    rejected: int
    errors: list[str] = Field(default_factory=list)


class EventQueryParams(BaseModel):
    type: str | None = None
    severity: Severity | None = None
    since: int | None = None
    limit: int = Field(default=100, le=1000, ge=1)
    offset: int = Field(default=0, ge=0)
