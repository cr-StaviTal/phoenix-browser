---
name: health-check
description: Check Phoenix EDR agent health and status
match:
  - health check
  - agent status
  - is agent running
  - check health
  - phoenix status
---

Check if the Phoenix EDR agent is running and healthy:

```bash
curl -s http://127.0.0.1:8745/api/health | python3 -m json.tool
```

Returns: `{ "status": "healthy", "uptime_seconds": N, "total_events": N }`

If the agent is not running, start it:
```bash
cd /Users/tal.stavi/Projects/phoenix-browser/agent && source .venv/bin/activate && python -m uvicorn phoenix_agent.main:app --reload --host 127.0.0.1 --port 8745
```
