---
name: check-events
description: Query events from the Phoenix EDR agent
match:
  - check events
  - show events
  - list events
  - recent events
  - query events
---

Query the Phoenix EDR agent for stored events. Always pipe through a python formatter for readable output:

```bash
# Recent events (formatted table)
curl -s "http://127.0.0.1:8745/api/events?limit=50" | python3 -c "
import json,sys
from datetime import datetime
data=json.load(sys.stdin)
events=data.get('events',[])
print(f'Total: {len(events)}\n')
print(f'{\"TYPE\":<25} {\"SEVERITY\":<10} {\"TIME\":<17} SOURCE')
print('-'*80)
for e in events:
    dt=datetime.fromtimestamp(e['timestamp']/1000).strftime('%Y-%m-%d %H:%M')
    print(f'{e[\"type\"]:<25} {e[\"severity\"].upper():<10} {dt:<17} {e.get(\"source\",\"\")}')
"

# Filter by type
curl -s "http://127.0.0.1:8745/api/events?type=threat.detected&limit=50" | python3 -c "
import json,sys
from datetime import datetime
data=json.load(sys.stdin)
events=data.get('events',[])
print(f'Total: {len(events)}\n')
print(f'{\"TYPE\":<25} {\"SEVERITY\":<10} {\"TIME\":<17} SOURCE')
print('-'*80)
for e in events:
    dt=datetime.fromtimestamp(e['timestamp']/1000).strftime('%Y-%m-%d %H:%M')
    print(f'{e[\"type\"]:<25} {e[\"severity\"].upper():<10} {dt:<17} {e.get(\"source\",\"\")}')
"
```

Event types: `threat.detected`, `threat.blocked`, `dlp.file_upload`, `dlp.clipboard`, `dlp.sensitive_data`, `extension.installed`, `extension.uninstalled`, `identity.session_anomaly`, `identity.cookie_change`, `policy.violated`, `rule_matched`, `navigation.visited`.

Filter params: `type`, `severity` (info|low|medium|high|critical), `since` (unix ms), `limit` (1-1000, default 100), `offset`.
