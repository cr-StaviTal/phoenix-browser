---
name: start-agent
description: Start the Phoenix EDR agent dev server
match:
  - start agent
  - run agent
  - start server
  - start backend
---

Start the Phoenix EDR agent development server:

```bash
cd /Users/tal.stavi/Projects/phoenix-browser/agent && source .venv/bin/activate && python -m uvicorn phoenix_agent.main:app --reload --host 127.0.0.1 --port 8745
```

The agent will be available at http://127.0.0.1:8745. Dashboard at http://127.0.0.1:8745/dashboard.
API docs at http://127.0.0.1:8745/docs.
