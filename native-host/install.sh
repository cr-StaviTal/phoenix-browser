#!/usr/bin/env bash
#
# install.sh — Build the Rust native host and register it with Chrome.
#
# Usage:
#   ./install.sh <chrome-extension-id>
#
# Example:
#   ./install.sh abcdefghijklmnopabcdefghijklmnop
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.phoenix.shield"
BINARY_NAME="phoenix-native-host"

# ---- Validate args ----

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo ""
  echo "  Find your extension ID at chrome://extensions (enable Developer mode)."
  exit 1
fi

EXT_ID="$1"

# ---- Build the Rust binary ----

echo "Building Rust native host (release)..."
cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml"

BINARY_PATH="$SCRIPT_DIR/target/release/$BINARY_NAME"
if [[ ! -f "$BINARY_PATH" ]]; then
  echo "ERROR: Build produced no binary at $BINARY_PATH"
  exit 1
fi

echo "Binary built: $BINARY_PATH"

# ---- Determine OS and install paths ----

OS="$(uname -s)"

case "$OS" in
  Darwin)
    # macOS — per-user location
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    # Linux — per-user location
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, use install.bat or manually add the registry key."
    echo "See README in this directory for details."
    exit 1
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

mkdir -p "$MANIFEST_DIR"

# ---- Generate the host manifest ----

MANIFEST_PATH="$MANIFEST_DIR/${HOST_NAME}.json"

cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Phoenix Shield Native Messaging Host — clipboard bridge",
  "type": "stdio",
  "path": "${BINARY_PATH}",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF

echo ""
echo "Host manifest installed to:"
echo "  $MANIFEST_PATH"
echo ""
echo "Contents:"
cat "$MANIFEST_PATH"
echo ""
echo "Done. Restart Chrome for changes to take effect."
