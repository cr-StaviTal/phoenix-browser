---
name: check-alerts
description: Query current alerts from the Phoenix EDR agent
match:
  - check alerts
  - show alerts
  - list alerts
  - open alerts
  - current alerts
---

Query the Phoenix EDR agent for current alerts. Always pipe through a python formatter for readable output:

```bash
# All open alerts (formatted table)
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

# Filter by severity
curl -s "http://127.0.0.1:8745/api/alerts?severity=critical&status=open&limit=50" | python3 -c "
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

Filter params: `severity` (info|low|medium|high|critical), `status` (open|resolved|dismissed), `since` (unix ms), `limit`, `offset`.
