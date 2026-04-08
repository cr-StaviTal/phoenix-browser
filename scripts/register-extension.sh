#!/usr/bin/env bash
#
# register-extension.sh — Build the Phoenix Shield extension and print
# instructions for loading it into Chrome.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/extension/dist"

echo "=== Phoenix Shield — Extension Setup ==="
echo ""

# Build if dist doesn't exist or --rebuild flag passed
if [[ ! -d "$DIST" || "${1:-}" == "--rebuild" ]]; then
  echo "Building extension..."
  cd "$REPO_ROOT/extension"
  npm install --silent
  npm run build
  echo ""
fi

echo "Extension built at: $DIST"
echo ""
echo "Load in Chrome:"
echo "  1. Open chrome://extensions/"
echo "  2. Enable 'Developer mode' (toggle, top-right)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: $DIST"
echo ""
echo "After loading, find your Extension ID on chrome://extensions/"
echo "It looks like: abcdefghijklmnopabcdefghijklmnop  (32 lowercase letters)"
echo ""
echo "Then run:"
echo "  scripts/register-native-host.sh <extension-id>"
