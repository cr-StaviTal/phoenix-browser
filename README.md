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

### Native Host & ETW Monitor (`native-host/`)

Rust binaries that run on Windows alongside the browser:

| Binary | What it does |
|---|---|
| **phoenix-native-host** | Chrome Native Messaging host — receives clipboard events from the extension and writes them to a local queue file |
| **phoenix-etw-monitor** | ETW (Event Tracing for Windows) process monitor — watches for new processes and correlates their command lines against recent clipboard content to detect ClickFix execution |

### ClickFix Simulator (`clickfix-simulator/`)

A self-hosted Flask application for simulating ClickFix social-engineering attacks in a safe training environment. Used to demonstrate and test Phoenix Shield's end-to-end ClickFix detection.

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
├── native-host/
│   ├── src/
│   │   ├── main.rs           # phoenix-native-host (Chrome native messaging)
│   │   ├── etw_monitor.rs    # phoenix-etw-monitor (ETW process correlation)
│   │   └── process_monitor.rs
│   └── build-windows.sh      # Cross-compile for Windows ARM64 + copy to ~/Documents
├── clickfix-simulator/       # ClickFix attack simulation server (Flask)
├── scripts/
│   ├── register-extension.sh       # Build extension and print Chrome load instructions
│   ├── register-native-host.sh     # macOS/Linux: register native host with Chrome
│   ├── register-native-host.ps1    # Windows: write manifest + registry key
│   └── install-etw-monitor.ps1     # Windows: install ETW monitor as a scheduled task
├── docs/
│   └── clickfix_demo.mp4           # End-to-end demo recording
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

## ClickFix Detection

### What is ClickFix?

ClickFix (also known as ClearFake / Fake Update) is a social-engineering attack where a malicious webpage tricks the user into manually executing a command:

1. The page displays a fake error (e.g. a Teams meeting failure, a PDF that won't load)
2. The "Fix it" button silently copies a PowerShell command to the clipboard via `navigator.clipboard.writeText()`
3. The page instructs the user to open the Run dialog (Win+R), paste, and press Enter
4. Because the **user** initiates execution, traditional AV and EDR often miss it

### How Phoenix Shield Detects It

```
  Browser (Chrome)                    Windows Host
  ─────────────────                   ────────────────────────────────────────
  1. User visits lure page
     └─ clipboard.writeText(payload)
                                       
  2. Extension DLP content script
     detects clipboard write
     └─ sends message to service worker
     └─ EdrReporter → POST /api/events (agent alerted)
     └─ Native messaging → phoenix-native-host
                                           │
                                           ▼
                                   3. phoenix-native-host writes
                                      payload to queue file:
                                      phoenix-clipboard-queue.jsonl
                                           │
                                           ▼
                                   4. phoenix-etw-monitor (running as Admin)
                                      polls queue file for new clipboard entries
                                           │
  5. User presses Win+R, pastes,          │
     hits Enter                           │
     └─ powershell.exe spawns             │
                                           ▼
                                   6. ETW fires ProcessStart event
                                      └─ etw_monitor reads cmd line from PEB
                                      └─ compares args against clipboard text
                                      └─ MATCH → ALERT printed + toast shown
```

### Demo Video

https://github.com/cr-StaviTal/phoenix-browser/raw/master/docs/clickfix_demo.mp4

### Setting Up the Full Demo

#### Step 1 — Run the ClickFix Simulator

The simulator is a self-hosted Flask app that serves realistic lure pages and generates trackable PowerShell payloads.

**Docker (recommended):**

```bash
cd clickfix-simulator
docker-compose up -d
```

**Local Python:**

```bash
cd clickfix-simulator
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
flask init-db
mkdir certs
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 365 -subj "/CN=localhost"
python run.py
```

The simulator runs at `https://localhost` (HTTPS required for the Clipboard API).

- Admin dashboard: `https://localhost/admin` (user: `admin`, pass: `changeme_please`)
- Test lure: `https://localhost/s/teams_error?uid=test_user`

> **Tip:** To target a Windows VM from a host machine, replace `localhost` with the host's IP (e.g. `10.211.55.2` for Parallels). Set `SERVER_NAME=10.211.55.2:443` in `docker-compose.yml` or `.env`.

#### Step 2 — Install the Extension (Windows Chrome)

On the Windows machine where you want to detect the attack:

```bash
# From repo root (macOS/Linux dev machine — or run manually on Windows)
./scripts/register-extension.sh
```

This builds the extension and prints the steps to load it in Chrome. After loading, note the **Extension ID** from `chrome://extensions`.

#### Step 3 — Register the Native Host (Windows)

Open PowerShell as a normal user and run:

```powershell
# From repo root on the Windows machine
.\scripts\register-native-host.ps1 -ExtensionId <your-extension-id>
```

This writes the native host manifest and adds the required Chrome registry key. **Restart Chrome** after running.

The native host binary (`phoenix-native-host.exe`) must be present. Copy it from `native-host/target/aarch64-pc-windows-msvc/release/` or from `~/Documents` if you used `build-windows.sh`.

#### Step 4 — Install and Start the ETW Monitor (Windows, elevated)

Open PowerShell **as Administrator**:

```powershell
# Install and register as a scheduled task (runs as SYSTEM at logon)
.\scripts\install-etw-monitor.ps1

# Start immediately without rebooting
Start-ScheduledTask -TaskName "PhoenixETWMonitor"
```

Or run it directly in an elevated terminal:

```powershell
.\phoenix-etw-monitor.exe
```

#### Step 5 — Trigger the Attack

1. Open Chrome on the Windows machine
2. Navigate to `https://<simulator-host>/s/teams_error?uid=victim`
3. Accept the self-signed certificate warning
4. Click the "Fix it" button — the PowerShell payload is now on the clipboard
5. Press **Win+R**, paste (Ctrl+V), press Enter

#### What You'll See

The ETW monitor terminal prints:

```
!!! ALERT: Clipboard text matches new process !!!
   Process: \Device\HarddiskVolume4\Windows\System32\...\powershell.exe (PID 1234)
   Command: "C:\WINDOWS\system32\...\PowerShell.exe" -w h -c "[System.Net.ServicePointManager]..."
   Clipboard: powershell -w h -c "[System.Net.ServicePointManager]::ServerCertificateValidation...
   Source URL: https://<simulator-host>/s/teams_error?uid=victim
```

A Windows toast notification also appears. The event is simultaneously forwarded to the Phoenix agent dashboard via the extension's EdrReporter.

---

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
