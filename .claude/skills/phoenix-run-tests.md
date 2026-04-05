---
name: run-tests
description: Run Phoenix EDR test suites (agent, extension, e2e)
match:
  - run tests
  - run test
  - test agent
  - test extension
  - run e2e
---

Run the Phoenix EDR test suites:

## Agent Tests
```bash
cd /Users/tal.stavi/Projects/phoenix-browser/agent && source .venv/bin/activate && pytest
```

Single file: `pytest tests/test_events.py`
Single test: `pytest tests/test_events.py -k "test_name"`
Verbose: `pytest -v`

## Extension Tests
```bash
cd /Users/tal.stavi/Projects/phoenix-browser/extension && npm run test
```

Single file: `npx vitest run tests/some-file.test.ts`
Watch mode: `npm run test:watch`

## E2E Tests
```bash
cd /Users/tal.stavi/Projects/phoenix-browser && pytest tests/e2e/
```

## All Checks (Extension)
```bash
cd /Users/tal.stavi/Projects/phoenix-browser/extension && npm run typecheck && npm run lint && npm run test
```
