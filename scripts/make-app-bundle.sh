#!/usr/bin/env bash
# Assembles an unsigned Jarvis.app around the SwiftPM executable and the built
# engine. Signing and notarisation are Ticket 19.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIGURATION="${1:-debug}"
APP="$ROOT/dist/Jarvis.app"

if [[ ! -f "$ROOT/dist/engine/engine.bundle.mjs" ]]; then
  echo "dist/engine is missing. Run: pnpm build:engine" >&2
  exit 1
fi

swift build --package-path "$ROOT/apps/macos" --configuration "$CONFIGURATION" --product Jarvis
BIN="$(swift build --package-path "$ROOT/apps/macos" --configuration "$CONFIGURATION" --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN/Jarvis" "$APP/Contents/MacOS/Jarvis"
# The engine travels with the app: no Node.js on the user's machine.
cp -R "$ROOT/dist/engine" "$APP/Contents/Resources/engine"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jarvis</string>
  <key>CFBundleDisplayName</key><string>Jarvis</string>
  <key>CFBundleIdentifier</key><string>dev.jarvis.Jarvis</string>
  <key>CFBundleExecutable</key><string>Jarvis</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "built $APP"
