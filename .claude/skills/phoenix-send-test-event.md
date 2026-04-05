---
name: send-test-event
description: Send a test event batch to the Phoenix EDR agent
match:
  - send test event
  - test event
  - simulate event
  - inject event
  - fake event
---

Send test events to the running Phoenix EDR agent to verify alerting:

## Threat Detection Event
```bash
curl -s -X POST http://127.0.0.1:8745/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "extension_id": "test-cli",
    "extension_version": "1.0.0",
    "machine_id": "test-machine",
    "timestamp": '"$(date +%s000)"',
    "events": [{
      "id": "test-'"$(date +%s)"'",
      "type": "threat.detected",
      "timestamp": '"$(date +%s000)"',
      "severity": "high",
      "source": "threat-detection",
      "payload": { "url": "https://evil.example.com", "threatType": "phishing", "matchedRule": "evil.example.com", "listSource": "domain", "action": "blocked" }
    }]
  }' | python3 -m json.tool
```

## DLP Sensitive Data Event
```bash
curl -s -X POST http://127.0.0.1:8745/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "extension_id": "test-cli",
    "extension_version": "1.0.0",
    "machine_id": "test-machine",
    "timestamp": '"$(date +%s000)"',
    "events": [{
      "id": "test-dlp-'"$(date +%s)"'",
      "type": "dlp.sensitive_data",
      "timestamp": '"$(date +%s000)"',
      "severity": "high",
      "source": "dlp-engine",
      "payload": { "url": "https://example.com/form", "dataType": "ssn", "matchedPattern": "SSN", "action": "blocked" }
    }]
  }' | python3 -m json.tool
```

## Rule Matched Event
```bash
curl -s -X POST http://127.0.0.1:8745/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "extension_id": "test-cli",
    "extension_version": "1.0.0",
    "machine_id": "test-machine",
    "timestamp": '"$(date +%s000)"',
    "events": [{
      "id": "test-rule-'"$(date +%s)"'",
      "type": "rule_matched",
      "timestamp": '"$(date +%s000)"',
      "severity": "high",
      "source": "rule-engine",
      "payload": { "rule_name": "Test Rule", "rule_severity": "high", "trigger": "page_load", "action": "alert", "url": "https://example.com", "user_input": "", "message": "Test rule triggered" }
    }]
  }' | python3 -m json.tool
```

After sending, check alerts: `curl -s http://127.0.0.1:8745/api/alerts?status=open | python3 -m json.tool`
