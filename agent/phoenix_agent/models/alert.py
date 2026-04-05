"""Alert models."""
from enum import Enum
from pydantic import BaseModel, Field
from phoenix_agent.models.event import Severity


class AlertStatus(str, Enum):
    open = "open"
    acknowledged = "acknowledged"
    resolved = "resolved"


class Alert(BaseModel):
    id: str
    created_at: str
    severity: Severity
    status: AlertStatus = AlertStatus.open
    title: str
    description: str | None = None
    source_event_id: str | None = None
    source_module: str
    metadata: dict = Field(default_factory=dict)


class AlertQueryParams(BaseModel):
    severity: Severity | None = None
    status: AlertStatus | None = None
    since: int | None = None
    limit: int = Field(default=50, le=500, ge=1)
    offset: int = Field(default=0, ge=0)
