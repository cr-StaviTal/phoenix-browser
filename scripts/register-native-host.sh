#!/usr/bin/env bash
#
# register-native-host.sh — Build and register the Phoenix Shield native
# messaging host with Chrome on macOS or Linux.
#
# Usage:
#   ./scripts/register-native-host.sh <chrome-extension-id>
#
# Find your extension ID at chrome://extensions (enable Developer mode).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo ""
  echo "  Find your extension ID at chrome://extensions (enable Developer mode)."
  echo "  Then rerun: $0 abcdefghijklmnopabcdefghijklmnop"
  exit 1
fi

exec "$REPO_ROOT/native-host/install.sh" "$1"
