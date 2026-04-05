"""Rule engine models for Phoenix EDR."""
from pydantic import BaseModel, Field
from uuid import uuid4
from datetime import datetime, timezone


class RuleTrigger(BaseModel):
    type: str  # page_load, dom_mutation, form_submit, click, interval, url_change, clipboard, input_submit
    selector: str | None = None
    ms: int | None = None  # for interval trigger
    direction: str | None = None  # for clipboard: copy/paste/both


class DomCondition(BaseModel):
    type: str  # element_exists, element_absent, element_count, element_text_matches, element_attr_matches, page_text_matches
    selector: str | None = None
    pattern: str | None = None
    attribute: str | None = None
    operator: str | None = None  # gt, lt, eq, gte, lte
    value: int | None = None


class RuleMatch(BaseModel):
    domains: list[str] | None = None
    url_patterns: list[str] | None = None
    url_regex: list[str] | None = None
    exclude_domains: list[str] | None = None
    trigger: RuleTrigger
    dom_conditions: list[DomCondition] | None = None


class RuleAction(BaseModel):
    type: str  # hide_element, remove_element, add_overlay, highlight_element, set_attribute, add_class, block_form_submit, block_click, block_navigation, log_event, alert, extract_data, inject_banner, inject_tooltip, redirect, close_tab, notify
    params: dict = Field(default_factory=dict)


class PhoenixRule(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    description: str = ""
    version: int = 1
    enabled: bool = True
    severity: str = "medium"
    author: str = ""
    tags: list[str] = Field(default_factory=list)
    match: RuleMatch
    actions: list[RuleAction]
    run_once_per_page: bool = True
    cooldown_ms: int = 0
    priority: int = 100
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class RuleCreate(BaseModel):
    """Schema for creating a new rule (no id/version/timestamps)."""
    name: str
    description: str = ""
    enabled: bool = True
    severity: str = "medium"
    author: str = ""
    tags: list[str] = Field(default_factory=list)
    match: RuleMatch
    actions: list[RuleAction]
    run_once_per_page: bool = True
    cooldown_ms: int = 0
    priority: int = 100


class RuleUpdate(BaseModel):
    """Schema for updating a rule (all fields optional)."""
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    severity: str | None = None
    author: str | None = None
    tags: list[str] | None = None
    match: RuleMatch | None = None
    actions: list[RuleAction] | None = None
    run_once_per_page: bool | None = None
    cooldown_ms: int | None = None
    priority: int | None = None
