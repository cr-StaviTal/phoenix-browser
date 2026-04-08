#!/bin/bash
set -e

cargo xwin build --release --target aarch64-pc-windows-msvc

RELEASE=target/aarch64-pc-windows-msvc/release
DEST=~/Documents

cp "$RELEASE/phoenix-etw-monitor.exe" "$DEST/"
cp "$RELEASE/phoenix-native-host.exe" "$DEST/"

echo "Copied binaries to $DEST"
