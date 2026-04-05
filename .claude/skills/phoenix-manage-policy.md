---
name: manage-policy
description: View and update Phoenix EDR policy configuration
match:
  - get policy
  - show policy
  - update policy
  - change policy
  - manage policy
  - policy config
---

View and update the Phoenix EDR policy configuration.

## Get Current Policy
```bash
curl -s http://127.0.0.1:8745/api/policy | python3 -m json.tool
```

## Update Policy
Send the full PolicyConfig object. The extension periodically fetches this and distributes to all modules.

```bash
curl -s -X PUT http://127.0.0.1:8745/api/policy \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.1.0",
    "threat_detection": {
      "enabled": true,
      "blocked_urls": [],
      "blocked_domains": ["evil-phishing.example.com", "malware-download.example.net"],
      "blocked_patterns": ["*phishing*", "*malware*"],
      "action": "block"
    },
    "dlp": {
      "enabled": true,
      "file_upload": {
        "blocked_extensions": [".exe", ".bat", ".ps1", ".cmd", ".scr"],
        "max_file_size_mb": 25,
        "blocked_domains": ["pastebin.com"]
      },
      "clipboard": { "monitor_paste": true, "monitor_copy": true },
      "sensitive_patterns": { "ssn": true, "credit_card": true, "email": true, "custom_patterns": [] }
    },
    "extension_monitor": {
      "enabled": true,
      "blocked_extensions": [],
      "max_permissions_risk_score": 70,
      "auto_disable_risky": false
    },
    "identity_protection": {
      "enabled": true,
      "monitored_domains": [],
      "alert_on_session_cookie_removal": true
    },
    "forensic_logger": { "enabled": true, "retention_days": 7, "max_storage_mb": 80 },
    "governance": {
      "copy_paste_restrictions": [],
      "download_restrictions": { "blocked_extensions": [".torrent"], "require_scan": false }
    },
    "edr_reporter": {
      "endpoint": "http://localhost:8745/api",
      "batch_interval_seconds": 30,
      "max_batch_size": 500,
      "retry_attempts": 3,
      "retry_backoff_ms": 1000
    }
  }' | python3 -m json.tool
```

## Policy Sections
- **threat_detection**: blocked URLs/domains/patterns, action (block)
- **dlp**: file upload restrictions (extensions, size, domains), clipboard monitoring, sensitive data patterns (SSN, CC, email, custom regex)
- **extension_monitor**: blocked extension IDs, max risk score, auto-disable toggle
- **identity_protection**: monitored domains for cookie/session tracking
- **forensic_logger**: retention days, max storage MB
- **governance**: copy/paste restrictions (source_domain → target_domain rules), download blocked extensions
- **edr_reporter**: agent endpoint, batch interval, batch size, retry config
