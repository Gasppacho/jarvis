#!/bin/bash
# Assembles dist/Jarvis.app from the SwiftPM binary and the engine bundle.
#
# ADR 0013: SwiftPM compiles, this script assembles. There is no Xcode project,
# so the bundle layout MACOS_APP.md describes is built here explicitly. Ticket
# 19 signs and notarises what this produces; it deliberately does neither.
set -euo pipefail

CONFIGURATION="${1:-debug}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/Jarvis.app"
CONTENTS="$APP/Contents"

if [ ! -f "$ROOT/dist/engine/engine.bundle.mjs" ]; then
  echo "build-app: dist/engine is missing. Run 'pnpm build:engine' first." >&2
  exit 1
fi

echo "build-app: compiling the Swift binary ($CONFIGURATION)"
swift build --package-path "$ROOT/apps/macos" --configuration "$CONFIGURATION" >/dev/null
BINARY="$(swift build --package-path "$ROOT/apps/macos" --configuration "$CONFIGURATION" --show-bin-path)/Jarvis"

echo "build-app: assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

cp "$BINARY" "$CONTENTS/MacOS/Jarvis"
# The engine tree, exactly as TECHNOLOGY_STACK.md "Build outputs" describes it.
cp -R "$ROOT/dist/engine" "$CONTENTS/Resources/engine"
# ADR 0015: dist/engine also carries engine.test-bundle.mjs, the Application
# Harness's build with the failpoint/test-hooks mechanism compiled in. Only
# engine.bundle.mjs (defined __JARVIS_TEST_HOOKS__ false) is production; strip
# the test bundle explicitly so it can never ship even if this copy step ever
# changes.
rm -f "$CONTENTS/Resources/engine/engine.test-bundle.mjs" \
      "$CONTENTS/Resources/engine/engine.test-bundle.mjs.map"

VERSION="$(node -p "require('$ROOT/package.json').version")"

# Without an Info.plist the binary is a terminal process: no dock icon, no
# activation, no bundle identity for the Keychain and security-scoped bookmarks
# tickets 02 and 03 need.
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Jarvis</string>
    <key>CFBundleDisplayName</key><string>Jarvis</string>
    <key>CFBundleIdentifier</key><string>dev.jarvis.app</string>
    <key>CFBundleExecutable</key><string>Jarvis</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>LSMinimumSystemVersion</key><string>15.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "build-app: $APP"
