# Phoenix Shield

Browser EDR (Endpoint Detection and Response) system that monitors browser activity in real time and reports security events to a centralized agent.

## Components

### Chrome Extension (`extension/`)

A Chrome MV3 extension with a modular, event-driven architecture. The service worker bootstraps an **EventBus** and **ModuleRegistry** that manage 10 detection modules:

| Module | What it does |
|---|---|
| **PolicyEngine** | Fetches and caches policy config from the agent; distributes to all modules |
| **UrlMonitor** | Tracks page navigations via `chrome.webNavigation` with dedup and referrer tracking |
| **ThreatDetection** | Blocklist-based URL threat detection; redirects threats to a block page before load |
| **DlpEngine** | Data Loss Prevention — blocks risky file uploads, scans clipboard for sensitive data (SSN, credit cards, emails) |
| **ExtensionMonitor** | Watches extension installs/uninstalls, scores risk by permissions, auto-disables risky extensions |
| **IdentityProtection** | Detects session cookie anomalies (hijack attempts, unexpected removal) |
| **GovernanceEngine** | Enforces org policies on copy/paste and downloads |
| **RuleEngine** | Executes dynamic detection rules fetched from the agent (DOM triggers, conditions, actions) |
| **ForensicLogger** | Full event audit trail in IndexedDB with rotation and retention |
| **EdrReporter** | Batches all events and POSTs to the agent with retry queue |

### Agent Backend (`agent/`)

Python FastAPI server that receives events, stores them in SQLite, evaluates alert rules, and serves a web dashboard.

- **API routers** — events (batch ingest), alerts (CRUD), policy (get/update), rules (full CRUD with audit trail), health
- **Alert engine** — rule-based evaluation that auto-creates alerts from ingested events
- **Retention scheduler** — periodic cleanup of old events
- **Dashboard** — Jinja2 web UI for viewing alerts, events, rules, and settings

## Project Structure

```
phoenix-browser/
├── extension/
│   ├── src/
│   │   ├── background/       # Service worker + message router
│   │   ├── content-scripts/  # DLP, form, governance, rule content scripts
│   │   ├── modules/          # 10 detection modules
│   │   ├── core/             # EventBus, ModuleRegistry, constants
│   │   ├── types/            # TypeScript type definitions
│   │   ├── popup/            # Extension popup UI
│   │   ├── options/          # Extension options page
│   │   └── blocked/          # Threat block page
│   └── tests/
├── agent/
│   ├── phoenix_agent/
│   │   ├── api/              # FastAPI route handlers
│   │   ├── models/           # Pydantic models (event, alert, policy, rules)
│   │   ├── storage/          # Async SQLite stores
│   │   ├── services/         # Alert engine, retention scheduler
│   │   ├── dashboard/        # Jinja2 templates + static assets
│   │   └── policies/         # Default policy JSON
│   └── tests/
└── tests/
    └── e2e/                  # Integration tests (extension <-> agent)
```

## Getting Started

### Prerequisites

- **Node.js** (v18+) and npm
- **Python** 3.11+
- **Chrome** browser

### 1. Start the Agent

```bash
cd agent
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m uvicorn phoenix_agent.main:app --reload --port 8745
```

The agent runs at `http://127.0.0.1:8745`. Visit this URL to see the dashboard.

### 2. Build and Load the Extension

```bash
cd extension
npm install
npm run build
```

Then load it in Chrome:

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` directory

The extension will automatically connect to the agent and start reporting events.

### Development Mode

```bash
# Extension — watch mode (rebuilds on file changes)
cd extension && npm run dev

# Agent — auto-reload on file changes
cd agent && python -m uvicorn phoenix_agent.main:app --reload --port 8745
```

## Running Tests

```bash
# Extension tests
cd extension && npm test

# Agent tests
cd agent && pytest

# E2E integration tests (from repo root)
pytest tests/e2e/
```

### Linting and Type Checking

```bash
# Extension
cd extension
npm run lint
npm run typecheck

# Agent
cd agent
ruff check .
ruff format .
```

## API Overview

Base URL: `http://127.0.0.1:8745/api`

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Server health and uptime |
| `/api/events` | POST | Ingest event batches from the extension |
| `/api/events` | GET | Query stored events (filter by type, severity, time) |
| `/api/alerts` | GET | Query alerts (filter by severity, status) |
| `/api/policy` | GET/PUT | Read or replace the policy config |
| `/api/rules` | GET/POST | List or create detection rules |
| `/api/rules/{id}` | GET/PUT/DELETE | Read, update, or delete a rule |
| `/api/rules/{id}/toggle` | POST | Enable/disable a rule |
| `/api/rules/{id}/duplicate` | POST | Clone a rule |
| `/api/rules/export` | GET | Export all rules as JSON |
| `/api/rules/import` | POST | Bulk import rules |

## How It Works

1. The **extension** monitors browser activity through Chrome APIs (navigation, downloads, cookies, extensions, content scripts)
2. Each **detection module** analyzes activity and publishes typed events to the EventBus
3. The **EdrReporter** collects all events, batches them, and sends them to the agent via `POST /api/events`
4. The **agent's alert engine** evaluates each event against configured rules and auto-creates alerts
5. The **dashboard** provides visibility into events, alerts, rules, and policy configuration
6. The **PolicyEngine** periodically fetches policy from the agent, keeping the extension's detection behavior in sync

## Configuration

The agent uses `pydantic-settings` with the `PHOENIX_` env prefix:

| Variable | Default | Description |
|---|---|---|
| `PHOENIX_HOST` | `127.0.0.1` | Server bind address |
| `PHOENIX_PORT` | `8745` | Server port |
| `PHOENIX_DB_PATH` | `phoenix_edr.db` | SQLite database path |
| `PHOENIX_RETENTION_DAYS` | `30` | Event retention period |

Policy is managed via the `/api/policy` endpoint and controls per-module behavior (threat blocklists, DLP rules, governance restrictions, etc.).

## License

Private project.
