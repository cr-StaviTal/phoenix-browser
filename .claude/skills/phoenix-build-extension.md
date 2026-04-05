---
name: build-extension
description: Build the Phoenix Shield Chrome extension
match:
  - build extension
  - build chrome
  - webpack build
  - build dist
---

Build the Phoenix Shield Chrome extension:

```bash
cd /Users/tal.stavi/Projects/phoenix-browser/extension && npm run build
```

Output goes to `extension/dist/`. To load in Chrome: chrome://extensions > Developer mode > Load unpacked > select `extension/dist/`.

For development with watch mode:
```bash
cd /Users/tal.stavi/Projects/phoenix-browser/extension && npm run dev
```

Webpack entry points: `background/service-worker`, `popup/popup`, `options/options`, `blocked/blocked`, and 4 content scripts (`dlp-content`, `form-content`, `governance-content`, `rule-content`).
