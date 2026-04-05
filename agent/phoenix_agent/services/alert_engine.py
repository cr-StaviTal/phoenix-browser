"""Rule-based alert engine - evaluates events and creates alerts."""
from dataclasses import dataclass
from typing import Callable
from phoenix_agent.models.event import AgentEvent, Severity
from phoenix_agent.storage import alert_store


@dataclass
class AlertRule:
    event_type: str
    min_severity: Severity = Severity.info
    title_template: str = ""
    description_template: str = ""
    alert_severity: Severity = Severity.medium
    condition: Callable[[AgentEvent], bool] | None = None


ALERT_RULES: list[AlertRule] = [
    AlertRule(
        event_type="threat.detected",
        min_severity=Severity.medium,
        title_template="Threat detected: {threatType} at {url}",
        description_template=(
            "A {threatType} threat was detected when navigating to {url}. "
            "The URL matched blocklist rule '{matchedRule}' from source '{listSource}'. "
            "Action taken: {action}."
        ),
        alert_severity=Severity.high,
    ),
    AlertRule(
        event_type="threat.blocked",
        min_severity=Severity.low,
        title_template="Threat blocked: {url}",
        description_template=(
            "Navigation to {url} was blocked. "
            "Threat type: {threatType}. "
            "Matched rule: {matchedRule}."
        ),
        alert_severity=Severity.medium,
    ),
    AlertRule(
        event_type="dlp.file_upload",
        title_template="File upload blocked: {fileName}",
        description_template=(
            "File upload of '{fileName}' ({fileSize} bytes) was {action} on {url}. "
            "File type matched DLP policy restriction."
        ),
        alert_severity=Severity.high,
        condition=lambda e: e.payload.get("action") == "blocked",
    ),
    AlertRule(
        event_type="dlp.sensitive_data",
        min_severity=Severity.medium,
        title_template="Sensitive data detected: {dataType}",
        description_template=(
            "Sensitive data of type '{dataType}' was detected on {url}. "
            "Pattern matched: {matchedPattern}. "
            "Action: {action}."
        ),
        alert_severity=Severity.critical,
    ),
    AlertRule(
        event_type="extension.installed",
        title_template="Risky extension installed: {name}",
        description_template=(
            "Extension '{name}' (ID: {extensionId}) was installed with a risk score of {riskScore}/100. "
            "Flagged permissions: {permissions}."
        ),
        alert_severity=Severity.high,
        condition=lambda e: e.payload.get("riskScore", 0) > 70,
    ),
    # Session anomaly rule disabled — too noisy on modern SPA sites like Claude
    # AlertRule(
    #     event_type="identity.session_anomaly",
    #     ...
    # ),
    AlertRule(
        event_type="dlp.clipboard",
        title_template="Clipboard {type} operation detected",
        description_template=(
            "Clipboard {type} operation detected on {url}. "
            "Data type: {dataType}. "
            "Action: {action}."
        ),
        alert_severity=Severity.medium,
    ),
    AlertRule(
        event_type="policy.violated",
        title_template="Policy violation: {violatedRule}",
        description_template=(
            "Policy violation: {violatedRule}. {details}"
        ),
        alert_severity=Severity.high,
    ),
    AlertRule(
        event_type="rule_matched",
        min_severity=Severity.low,
        title_template="AI Safety Rule: {rule_name}",
        description_template=(
            "Rule \"{rule_name}\" (severity: {rule_severity}) was triggered on {url}. "
            "Trigger: {trigger}. Action taken: {action}. "
            "User input: \"{user_input}\". "
            "{message}"
        ),
        alert_severity=Severity.critical,
        condition=lambda e: e.payload.get("rule_name") is not None,
    ),
]


def _format_template(template: str, payload: dict) -> str:
    """Format a template string from payload with safe fallbacks for missing keys."""
    if not template:
        return ""

    class SafeDict(dict):
        def __missing__(self, key: str) -> str:
            return f"<{key}: N/A>"

    try:
        return template.format_map(SafeDict(payload))
    except Exception:
        return template


async def evaluate_event(event: AgentEvent) -> dict | None:
    """Evaluate a single event against alert rules. Returns alert if matched."""
    severity_order = list(Severity)

    for rule in ALERT_RULES:
        if event.type != rule.event_type:
            continue

        event_severity_idx = severity_order.index(event.severity)
        min_severity_idx = severity_order.index(rule.min_severity)
        if event_severity_idx < min_severity_idx:
            continue

        if rule.condition and not rule.condition(event):
            continue

        title = _format_template(rule.title_template, event.payload)
        description = _format_template(rule.description_template, event.payload)
        alert = await alert_store.create_alert(
            severity=rule.alert_severity.value,
            title=title,
            source_module=event.source,
            description=description,
            source_event_id=event.id,
            metadata={"event_payload": event.payload},
        )
        return alert

    return None


async def evaluate_batch(events: list[AgentEvent]) -> list[dict]:
    """Evaluate all events in a batch."""
    alerts = []
    for event in events:
        alert = await evaluate_event(event)
        if alert:
            alerts.append(alert)
    return alerts
