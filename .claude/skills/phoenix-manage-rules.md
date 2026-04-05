---
name: manage-rules
description: CRUD operations for Phoenix EDR detection rules
match:
  - create rule
  - add rule
  - new rule
  - manage rules
  - list rules
  - show rules
  - update rule
  - delete rule
  - toggle rule
---

Manage Phoenix EDR detection rules via the agent API.

## List Rules
```bash
curl -s "http://127.0.0.1:8745/api/rules" | python3 -c "
import json,sys
rules=json.load(sys.stdin)
if isinstance(rules,dict): rules=rules.get('rules',rules.get('items',[]))
if not isinstance(rules,list): rules=[rules]
print(f'Total: {len(rules)}\n')
print(f'{\"NAME\":<35} {\"SEV\":<9} {\"ENABLED\":<9} {\"PRIORITY\":<9} TAGS')
print('-'*85)
for r in rules:
    tags=','.join(r.get('tags',[]))
    print(f'{r[\"name\"][:34]:<35} {r.get(\"severity\",\"-\"):<9} {str(r.get(\"enabled\",True)):<9} {str(r.get(\"priority\",0)):<9} {tags}')
"

# Enabled only
curl -s "http://127.0.0.1:8745/api/rules?enabled=true" | python3 -c "
import json,sys
rules=json.load(sys.stdin)
if isinstance(rules,dict): rules=rules.get('rules',rules.get('items',[]))
if not isinstance(rules,list): rules=[rules]
print(f'Total: {len(rules)}\n')
print(f'{\"NAME\":<35} {\"SEV\":<9} {\"ENABLED\":<9} {\"PRIORITY\":<9} TAGS')
print('-'*85)
for r in rules:
    tags=','.join(r.get('tags',[]))
    print(f'{r[\"name\"][:34]:<35} {r.get(\"severity\",\"-\"):<9} {str(r.get(\"enabled\",True)):<9} {str(r.get(\"priority\",0)):<9} {tags}')
"
```

## Create a Rule
```bash
curl -s -X POST http://127.0.0.1:8745/api/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Rule Name",
    "description": "What this rule does",
    "severity": "high",
    "match": {
      "domains": ["example.com"],
      "trigger": { "type": "page_load" },
      "dom_conditions": [
        { "type": "element_exists", "selector": "#dangerous-element" }
      ]
    },
    "actions": [
      { "type": "hide_element", "params": { "selector": "#dangerous-element" } },
      { "type": "alert", "params": { "message": "Dangerous element hidden" } }
    ],
    "priority": 100,
    "tags": ["security"]
  }' | python3 -m json.tool
```

### Trigger types
`page_load`, `dom_mutation`, `form_submit`, `click`, `interval` (needs `ms`), `url_change`, `clipboard` (needs `direction`: copy/paste/both), `input_submit`

### DOM condition types
`element_exists`, `element_absent`, `element_count` (with `operator`+`value`), `element_text_matches` (with `pattern`), `element_attr_matches` (with `attribute`+`pattern`), `page_text_matches` (with `pattern`)

### Action types
`hide_element`, `remove_element`, `add_overlay`, `highlight_element`, `set_attribute`, `add_class`, `block_form_submit`, `block_click`, `block_navigation`, `log_event`, `alert`, `extract_data`, `inject_banner`, `inject_tooltip`, `redirect` (params: `url`), `close_tab`, `notify` (params: `message`)

## Update a Rule
```bash
curl -s -X PUT http://127.0.0.1:8745/api/rules/RULE_ID \
  -H "Content-Type: application/json" \
  -d '{"enabled": false, "severity": "critical"}' | python3 -m json.tool
```

## Toggle / Delete / Duplicate
```bash
curl -s -X POST http://127.0.0.1:8745/api/rules/RULE_ID/toggle | python3 -m json.tool
curl -s -X DELETE "http://127.0.0.1:8745/api/rules/RULE_ID" | python3 -m json.tool
curl -s -X DELETE "http://127.0.0.1:8745/api/rules/RULE_ID?hard=true" | python3 -m json.tool
curl -s -X POST http://127.0.0.1:8745/api/rules/RULE_ID/duplicate | python3 -m json.tool
```

## Validate Without Saving
```bash
curl -s -X POST http://127.0.0.1:8745/api/rules/validate \
  -H "Content-Type: application/json" \
  -d '{ "name": "test", "match": { "trigger": { "type": "page_load" } }, "actions": [] }' | python3 -m json.tool
```

## Export / Import
```bash
curl -s http://127.0.0.1:8745/api/rules/export > rules_backup.json
curl -s -X POST http://127.0.0.1:8745/api/rules/import \
  -H "Content-Type: application/json" \
  -d @rules_backup.json | python3 -m json.tool
```
