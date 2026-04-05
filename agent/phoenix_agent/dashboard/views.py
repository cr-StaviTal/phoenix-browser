"""Dashboard HTML views."""
import json
import time
from datetime import datetime, timezone
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

from phoenix_agent.storage import event_store, alert_store, rule_store

router = APIRouter(tags=["dashboard"])
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


def _epoch_ms_to_human(epoch_ms: int | None) -> str:
    """Convert epoch milliseconds to a human-readable datetime string."""
    if epoch_ms is None:
        return "Unknown"
    try:
        dt = datetime.fromtimestamp(int(epoch_ms) / 1000, tz=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except (ValueError, OSError, OverflowError):
        return str(epoch_ms)


def _relative_time(epoch_ms: int | None) -> str:
    """Return a human-friendly relative time string (e.g. '3 minutes ago')."""
    if epoch_ms is None:
        return "Unknown"
    try:
        now_ms = int(time.time() * 1000)
        delta_s = (now_ms - int(epoch_ms)) / 1000
        if delta_s < 60:
            return f"{int(delta_s)}s ago"
        elif delta_s < 3600:
            return f"{int(delta_s // 60)}m ago"
        elif delta_s < 86400:
            return f"{int(delta_s // 3600)}h ago"
        else:
            return f"{int(delta_s // 86400)}d ago"
    except Exception:
        return str(epoch_ms)


# Register custom Jinja2 filters
templates.env.filters["epoch_ms_to_human"] = _epoch_ms_to_human
templates.env.filters["relative_time"] = _relative_time


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Main dashboard page."""
    events, total_events = await event_store.query_events(limit=20)
    alerts_list, total_alerts = await alert_store.query_alerts(status="open", limit=10)

    # Get events by severity for summary
    severity_counts = {}
    for sev in ["info", "low", "medium", "high", "critical"]:
        evts, count = await event_store.query_events(severity=sev, limit=1)
        severity_counts[sev] = count

    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "events": events,
            "total_events": total_events,
            "alerts": alerts_list,
            "total_alerts": total_alerts,
            "severity_counts": severity_counts,
        },
    )


@router.get("/dashboard/alerts", response_class=HTMLResponse)
async def alerts_page(request: Request):
    """Alerts detail page."""
    alerts_list, total = await alert_store.query_alerts(limit=50)

    # Compute per-severity counts for the summary bar
    severity_counts: dict[str, int] = {}
    for alert in alerts_list:
        sev = alert.get("severity", "unknown")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    return templates.TemplateResponse(
        request,
        "alerts.html",
        {
            "alerts": alerts_list,
            "total": total,
            "severity_counts": severity_counts,
        },
    )


@router.get("/dashboard/rules", response_class=HTMLResponse)
async def rules_page(request: Request):
    """Rules list page."""
    rules = await rule_store.list_rules()
    enabled_count = sum(1 for r in rules if r.get("enabled"))
    severity_counts: dict[str, int] = {}
    for rule in rules:
        sev = rule.get("severity", "medium")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    return templates.TemplateResponse(
        request,
        "rules.html",
        {
            "rules": rules,
            "total": len(rules),
            "enabled_count": enabled_count,
            "severity_counts": severity_counts,
        },
    )


@router.get("/dashboard/rules/new", response_class=HTMLResponse)
async def new_rule_page(request: Request):
    """New rule editor page."""
    return templates.TemplateResponse(
        request,
        "rule_editor.html",
        {"rule": None, "rule_json": "null"},
    )


@router.get("/dashboard/rules/{rule_id}/edit", response_class=HTMLResponse)
async def edit_rule_page(request: Request, rule_id: str):
    """Edit rule editor page."""
    rule = await rule_store.get_rule(rule_id)
    if rule is None:
        return templates.TemplateResponse(
            request,
            "rule_editor.html",
            {"rule": None, "rule_json": "null"},
        )
    return templates.TemplateResponse(
        request,
        "rule_editor.html",
        {"rule": rule, "rule_json": json.dumps(rule)},
    )


@router.get("/dashboard/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Module settings page."""
    return templates.TemplateResponse(
        request,
        "settings.html",
        {},
    )
