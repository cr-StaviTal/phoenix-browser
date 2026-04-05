# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Phoenix Shield is a browser EDR (Endpoint Detection and Response) system with two components:

- **`extension/`** — Chrome MV3 extension ("Phoenix Shield") that monitors browser activity (URL threats, DLP, extensions, identity, governance) and reports events to the agent
- **`agent/`** — Python FastAPI backend that receives events, stores them in SQLite, evaluates alert rules, and serves a dashboard

The extension batches events and POSTs them to the agent at `http://127.0.0.1:8745/api/events`.

## Querying the Agent API

When querying any agent API endpoint (alerts, events, rules, etc.), **always pipe curl output through a python formatter in a single command** to produce a readable table. Never use `python3 -m json.tool` for list endpoints — raw JSON is too large and wastes round trips. Example:

```bash
curl -s "http://127.0.0.1:8745/api/alerts?status=open&limit=50" | python3 -c "
import json,sys
from datetime import datetime
data=json.load(sys.stdin)
alerts=data.get('alerts',[])
print(f'Total: {len(alerts)}\n')
print(f'{\"SEVERITY\":<10} {\"STATUS\":<10} {\"TIME\":<17} TITLE')
print('-'*80)
for a in alerts:
    dt=datetime.fromtimestamp(a['created_at']/1000).strftime('%Y-%m-%d %H:%M')
    print(f'{a[\"severity\"].upper():<10} {a[\"status\"]:<10} {dt:<17} {a[\"title\"][:60]}')
"
```

Use `python3 -m json.tool` only for single-object responses (create, update, health, etc.).

## Commands

### Extension (from `extension/`)
```bash
npm run build          # Webpack production build → dist/
npm run dev            # Webpack watch mode
npm run test           # Vitest (all tests)
npx vitest run tests/some-file.test.ts  # Single test file
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
```

### Agent (from `agent/`)
```bash
pip install -e ".[dev]"                # Install with dev deps (into .venv)
python -m uvicorn phoenix_agent.main:app --reload  # Run dev server (port 8745)
pytest                                 # All tests
pytest tests/test_events.py            # Single test file
pytest tests/test_events.py -k "test_name"  # Single test
ruff check .                           # Lint
ruff format .                          # Format
```

### E2E Tests (from repo root `tests/`)
```bash
pytest tests/e2e/       # Integration tests (extension ↔ agent)
```

## Architecture

### Extension — Modular Event-Driven Design

The service worker (`background/service-worker.ts`) bootstraps the system:

1. Creates an **EventBus** (pub/sub with typed events, wildcard subscribers, error isolation)
2. Creates a **ModuleRegistry** that manages module lifecycle (init in registration order, destroy in reverse)
3. Instantiates and registers **10 modules**, each implementing the `PhoenixModule` interface (`id`, `version`, `register(bus)`, `destroy()`, `getStatus()`)
4. Wires inter-module dependencies via `setPolicyEngine()` calls
5. Creates a **MessageRouter** to handle `chrome.runtime.onMessage` from content scripts

**Module registration order matters** — PolicyEngine first (others depend on it), EdrReporter last (aggregates all events).

Content scripts (`content-scripts/*.ts`) run on all pages and send messages to the service worker for DLP, form monitoring, governance, and rule evaluation.

The extension uses `chrome.alarms` for keep-alive (25s interval to beat MV3's 30s idle timeout) and periodic EDR report flushing.

### Agent — FastAPI + SQLite

- **API routers** in `api/`: `events` (batch ingest), `alerts` (CRUD), `policy` (get/update), `health`, `rules` (CRUD with audit trail)
- **Storage layer** in `storage/`: async SQLite via `aiosqlite` with `database.py` (init/close/get_db), plus `event_store`, `alert_store`, `rule_store`
- **Alert engine** (`services/alert_engine.py`): rule-based evaluation — each ingested event is matched against `ALERT_RULES` to auto-create alerts
- **Retention scheduler** (`services/retention.py`): periodic cleanup of old events
- **Dashboard** (`dashboard/`): Jinja2 HTML views + static assets
- **Config**: `pydantic-settings` with `PHOENIX_` env prefix (host, port, db_path, retention_days, etc.)

## Agent API Reference

Base URL: `http://127.0.0.1:8745/api`

### Events

- **`POST /api/events`** — Ingest a batch of events from the extension. Returns 202.
  ```json
  {
    "extension_id": "phoenix-browser-extension",
    "extension_version": "1.0.0",
    "machine_id": "machine-xyz",
    "timestamp": 1700000000000,
    "events": [
      {
        "id": "evt-001",
        "type": "threat.detected",
        "timestamp": 1700000000000,
        "severity": "high",
        "source": "threat-detection",
        "payload": { "url": "https://evil.example.com", "threatType": "malware" }
      }
    ]
  }
  ```
  Response: `{ "accepted": 1, "rejected": 0, "errors": [] }`
  Events are auto-evaluated by the alert engine on ingestion.

- **`GET /api/events`** — Query stored events. Params: `type`, `severity` (info|low|medium|high|critical), `since` (unix ms), `limit` (1-1000, default 100), `offset`.

### Alerts

- **`GET /api/alerts`** — Query alerts. Params: `severity`, `status` (open|resolved|dismissed), `since`, `limit` (1-500, default 50), `offset`.

Alerts are auto-created by the alert engine (`services/alert_engine.py`) when ingested events match `ALERT_RULES`. Rule types that generate alerts: `threat.detected`, `threat.blocked`, `dlp.file_upload` (when blocked), `dlp.sensitive_data`, `extension.installed` (risk > 70), `dlp.clipboard`, `policy.violated`, `rule_matched`.

### Policy

- **`GET /api/policy`** — Get current policy config.
- **`PUT /api/policy`** — Replace entire policy. Body is a full `PolicyConfig` JSON. Persisted to `default_policy.json`. The extension periodically fetches this and distributes it to all modules.

Policy sections: `threat_detection`, `dlp` (file_upload, clipboard, sensitive_patterns), `extension_monitor`, `identity_protection`, `forensic_logger`, `governance` (copy_paste_restrictions, download_restrictions), `edr_reporter` (endpoint, batch settings).

### Rules CRUD

Rules are dynamic detection rules pushed from the agent to the extension's RuleEngine. The extension fetches `GET /api/rules?enabled=true` periodically and on policy reload.

- **`GET /api/rules`** — List all rules. Param: `enabled` (bool filter).
- **`POST /api/rules`** — Create a rule. Body is `RuleCreate`:
  ```json
  {
    "name": "Block AI prompt injection",
    "description": "Detect prompt injection attempts",
    "severity": "high",
    "match": {
      "domains": ["chat.openai.com", "claude.ai"],
      "trigger": { "type": "input_submit" },
      "dom_conditions": [
        { "type": "element_text_matches", "selector": "textarea", "pattern": "ignore previous" }
      ]
    },
    "actions": [
      { "type": "block_form_submit", "params": {} },
      { "type": "alert", "params": { "message": "Prompt injection blocked" } }
    ],
    "priority": 200,
    "tags": ["ai-safety"]
  }
  ```
- **`GET /api/rules/{id}`** — Get single rule.
- **`PUT /api/rules/{id}`** — Partial update (any `RuleUpdate` fields).
- **`DELETE /api/rules/{id}`** — Soft delete (sets enabled=false). Pass `?hard=true` for permanent.
- **`POST /api/rules/{id}/toggle`** — Toggle enabled/disabled.
- **`POST /api/rules/{id}/duplicate`** — Clone with new ID.
- **`GET /api/rules/export`** — Export all rules as JSON array.
- **`POST /api/rules/import`** — Bulk import rules.
- **`POST /api/rules/validate`** — Validate a rule without saving.

#### Rule Model

- **match.trigger.type**: `page_load`, `dom_mutation`, `form_submit`, `click`, `interval`, `url_change`, `clipboard`, `input_submit`
- **match.dom_conditions[].type**: `element_exists`, `element_absent`, `element_count`, `element_text_matches`, `element_attr_matches`, `page_text_matches`
- **actions[].type**: `hide_element`, `remove_element`, `add_overlay`, `highlight_element`, `set_attribute`, `add_class`, `block_form_submit`, `block_click`, `block_navigation`, `log_event`, `alert`, `extract_data`, `inject_banner`, `inject_tooltip`, `redirect`, `close_tab`, `notify`
- **match.domains/url_patterns**: glob patterns (`*.example.com`), **match.url_regex**: full regex
- **match.exclude_domains**: domains to skip even if domains match
- Rules sorted by `priority` (higher = first). `run_once_per_page` and `cooldown_ms` control re-trigger behavior.

### Health

- **`GET /api/health`** — Returns `{ "status": "healthy", "uptime_seconds": N, "total_events": N }`.

## Detection Engines (Extension Modules)

### PolicyEngine (`modules/policy-engine.ts`)
Central configuration hub. Fetches policy from agent `GET /api/policy` on startup and periodically (alarm-based). Caches to `chrome.storage.local` under key `phoenix_policy`. Publishes `POLICY_LOADED` event so other modules reload their config. Falls back to hardcoded defaults if agent unreachable.

### UrlMonitor (`modules/url-monitor.ts`)
Listens to `chrome.webNavigation.onCompleted` for main-frame navigations. Deduplicates via LRU cache (keyed by `tabId:url`). Filters internal schemes (`chrome:`, `about:`, etc.). Publishes `NAVIGATION_VISITED` events with URL, tabId, transitionType, and referrer tracking.

### ThreatDetection (`modules/threat-detection.ts`)
Blocklist-based URL threat detection with three match levels: exact URL, domain, and glob pattern. **Primary path**: intercepts `chrome.webNavigation.onBeforeNavigate` to redirect threats to `blocked/blocked.html` before the page loads. **Secondary path**: reacts to `NAVIGATION_VISITED` events from UrlMonitor. Also registers `chrome.declarativeNetRequest` dynamic rules to block sub-frames. Blocklists merge hardcoded defaults with policy (`threat_detection.blocked_urls/domains/patterns`). Publishes `THREAT_DETECTED` + `THREAT_BLOCKED` events.

### DlpEngine (`modules/dlp-engine.ts`)
Data Loss Prevention. Listens for content script messages prefixed `dlp:`:
- **`dlp:file-input-detected`** — Checks file extension against blocklist, file size against max, and domain against blocked list. Actions: allow/block.
- **`dlp:paste-detected`** — Scans pasted text for sensitive data (SSN with area-number validation, credit cards with Luhn check, emails). SSN/CC matches escalate to block; others warn.
- **`dlp:sensitive-data-found`** — Content script found sensitive data in form fields.
Publishes `DLP_FILE_UPLOAD`, `DLP_CLIPBOARD`, `DLP_SENSITIVE_DATA` events.

### ExtensionMonitor (`modules/extension-monitor.ts`)
Watches `chrome.management` lifecycle events (installed, uninstalled, enabled, disabled). Calculates a 0-100 risk score from permission weights (e.g., `<all_urls>`: 40, `nativeMessaging`: 35, `webRequest`: 30, `cookies`: 25). Runs periodic full scans via alarm. If policy has `auto_disable_risky: true`, auto-disables extensions exceeding `max_permissions_risk_score` or on the blocklist.

### IdentityProtection (`modules/identity-protection.ts`)
Monitors `chrome.cookies.onChanged` for session cookie anomalies. Tracks cookies per domain. Flags: unexpected session cookie removal (not during logout), replacement with non-secure or non-httpOnly cookie. Detects logout flows via URL patterns (`/logout`, `/signout`, `/sign-out`) and suppresses false positives for 10s after logout. Policy controls which domains to monitor (`identity_protection.monitored_domains`).

### GovernanceEngine (`modules/governance-engine.ts`)
Enforces organizational policies:
- **Copy/paste restrictions**: Content scripts send `governance:paste-check` / `governance:copy-check`. Matches against `copy_paste_restrictions[]` rules with domain glob patterns, returns allow/block/warn.
- **Download restrictions**: Listens to `chrome.downloads.onCreated`. Cancels downloads matching blocked extensions (e.g., `.torrent`). Shows notification on block.
Publishes `POLICY_VIOLATED` events.

### RuleEngine (`modules/rule-engine.ts`)
Dynamic rule execution engine. Fetches enabled rules from agent `GET /api/rules?enabled=true` on startup, periodically, and on policy reload. Caches rules in `chrome.storage.local`. Content scripts request matching rules via `rules:get` message, then execute DOM-based triggers/conditions/actions client-side. When a rule matches, content script sends `rules:matched` back to service worker which: executes service-worker-side actions (redirect, close_tab, notify), publishes `RULE_MATCHED` event, and directly POSTs a `rule_matched` event to the agent for alert generation.

### ForensicLogger (`modules/forensic-logger.ts`)
Full event audit trail. Subscribes to ALL events (wildcard) and writes every event to IndexedDB with session ID. Periodic log rotation via alarm: deletes entries older than `retention_days`, evicts oldest 10% if storage exceeds `max_storage_mb`. Queryable via `queryLogs()` for the popup/dashboard.

### EdrReporter (`modules/edr-reporter.ts`)
Subscribes to ALL events (wildcard), buffers them, and flushes batches to `POST /api/events` periodically or when buffer hits `max_batch_size`. Failed batches go to a retry queue in `chrome.storage.local` with exponential backoff (up to `retry_attempts`). Queue capped at 5MB, oldest entries dropped on overflow.

## Agent Tests

Tests use `pytest-asyncio` (auto mode) with `httpx.AsyncClient` over ASGI transport. The `conftest.py` provides:
- `db` fixture: in-memory SQLite with full schema
- `client` fixture: async HTTP client bound to test app
- `make_event()` / `make_batch()` helpers for building test data

## Extension Tests

Vitest with a `tests/setup.ts` file that mocks `chrome.*` APIs. Tests are in `extension/tests/**/*.test.ts`.

## Key Types

- Extension events flow as `PhoenixEvent<T>` (type, timestamp, source, payload, severity)
- Agent receives `EventBatchRequest` (extension_id, machine_id, events[])
- Severity enum: `info`, `low`, `medium`, `high`, `critical`
- All modules implement `PhoenixModule` interface from `types/modules.ts`
- Rule model: `PhoenixRule` with `RuleMatch` (domains, url_patterns, url_regex, trigger, dom_conditions) and `RuleAction[]` (type + params)
- Policy: `PolicyConfig` with per-module sections, fetched/cached by PolicyEngine
