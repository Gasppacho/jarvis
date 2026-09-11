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

# Validate the assembled copy, not dist/engine: this gate must inspect exactly
# what would be signed and shipped. A path outside the declared output shapes
# is a release failure, even when a later cleanup could remove it.
ENGINE="$CONTENTS/Resources/engine"
reject_engine_artifact() {
  echo "build-app: refusing to ship unexpected artifact in assembled engine bundle: $1" >&2
  exit 1
}

while IFS= read -r -d '' path; do
  [ "$path" = "$ENGINE" ] && continue
  relative="${path#"$ENGINE/"}"
  name="${relative##*/}"

  case "$name" in
    .env|.env.*|engine.test-bundle.mjs|engine.test-bundle.mjs.map)
      reject_engine_artifact "$path"
      ;;
  esac

  IFS='/' read -r -a components <<< "$relative"
  for component in "${components[@]}"; do
    case "$component" in
      fixture|fixtures|test|tests)
        reject_engine_artifact "$path"
        ;;
    esac
  done

  case "$relative" in
    engine.bundle.mjs|engine.bundle.mjs.map|module-registry.json|node|native|native/better_sqlite3.node|modules|modules/*|contracts|contracts/*|migrations|migrations/*)
      ;;
    *)
      reject_engine_artifact "$path"
      ;;
  esac
done < <(find "$ENGINE" -print0)

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

# Record the artifact facts after assembly, from the exact bundle that will be
# signed. The helper starts that Engine for its live version/API health check.
node "$ROOT/scripts/build-manifest.mjs" --app "$APP" --source-root "$ROOT"

echo "build-app: $APP"
