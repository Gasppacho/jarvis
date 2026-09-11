#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/build-dmg.sh"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "build-dmg.test: skipped (requires arm64 macOS)"
  exit 0
fi

for tool in codesign ditto hdiutil; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "build-dmg.test: missing required tool: $tool" >&2
    exit 1
  }
done

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-build-dmg-test.XXXXXX")"
TEST_MOUNT="$TEST_ROOT/mount"

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ -d "$TEST_MOUNT" ]]; then
    hdiutil detach "$TEST_MOUNT" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_ROOT"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

APP="$TEST_ROOT/Jarvis.app"
OUTPUT="$TEST_ROOT/release/Jarvis-0.1.0.dmg"
mkdir -p "$APP/Contents/MacOS" "$TEST_ROOT/release"
cp /usr/bin/true "$APP/Contents/MacOS/Jarvis"
printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0"><dict>' \
  '<key>CFBundleIdentifier</key><string>dev.jarvis.test</string>' \
  '<key>CFBundleName</key><string>Jarvis</string>' \
  '<key>CFBundleExecutable</key><string>Jarvis</string>' \
  '<key>CFBundlePackageType</key><string>APPL</string>' \
  '<key>CFBundleShortVersionString</key><string>0.1.0</string>' \
  '<key>CFBundleVersion</key><string>0.1.0</string>' \
  '</dict></plist>' > "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" >/dev/null

run_and_assert_image() {
  rm -rf "$TEST_MOUNT" "$TEST_ROOT/extracted"
  mkdir -p "$TEST_MOUNT" "$TEST_ROOT/extracted"
  hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$TEST_MOUNT" "$OUTPUT" >/dev/null
  [[ -d "$TEST_MOUNT/Jarvis.app" ]]
  [[ -L "$TEST_MOUNT/Applications" ]]
  [[ "$(readlink "$TEST_MOUNT/Applications")" == "/Applications" ]]
  if touch "$TEST_MOUNT/should-not-write" 2>/dev/null; then
    echo "build-dmg.test: mounted image is writable" >&2
    exit 1
  fi
  codesign --verify --deep --strict "$TEST_MOUNT/Jarvis.app" >/dev/null
  ditto "$TEST_MOUNT/Jarvis.app" "$TEST_ROOT/extracted/Jarvis.app"
  codesign --verify --deep --strict "$TEST_ROOT/extracted/Jarvis.app" >/dev/null
  hdiutil detach "$TEST_MOUNT" -force >/dev/null
}

JARVIS_APP_PATH="$APP" \
JARVIS_DMG_OUTPUT="$OUTPUT" \
JARVIS_CODESIGN_IDENTITY=- \
  "$SCRIPT"
[[ -f "$OUTPUT" ]]
codesign --verify --strict "$OUTPUT" >/dev/null
hdiutil imageinfo "$OUTPUT" | grep -F 'Format: UDZO' >/dev/null
run_and_assert_image

# A second run replaces the deterministic output and remains fully verifiable.
JARVIS_APP_PATH="$APP" \
JARVIS_DMG_OUTPUT="$OUTPUT" \
JARVIS_CODESIGN_IDENTITY=- \
  "$SCRIPT"
[[ -f "$OUTPUT" ]]
codesign --verify --strict "$OUTPUT" >/dev/null
run_and_assert_image

# Fail after attach and prove the script detaches and removes its temporary image.
FAIL_ROOT="$TEST_ROOT/failure"
FAIL_OUTPUT="$FAIL_ROOT/release/Jarvis-0.1.0.dmg"
mkdir -p "$FAIL_ROOT/bin" "$(dirname "$FAIL_OUTPUT")"
printf '%s\n' \
  '#!/bin/bash' \
  'set -euo pipefail' \
  'for argument in "$@"; do' \
  '  case "$argument" in' \
  '    */mount/Jarvis.app) echo "forced mounted-app verification failure" >&2; exit 91 ;;' \
  '  esac' \
  'done' \
  'exec /usr/bin/codesign "$@"' > "$FAIL_ROOT/bin/codesign"
chmod +x "$FAIL_ROOT/bin/codesign"
if PATH="$FAIL_ROOT/bin:$PATH" \
  JARVIS_APP_PATH="$APP" \
  JARVIS_DMG_OUTPUT="$FAIL_OUTPUT" \
  JARVIS_CODESIGN_IDENTITY=- \
  "$SCRIPT" > "$FAIL_ROOT/output.log" 2>&1; then
  echo "build-dmg.test: expected mounted verification failure" >&2
  exit 1
fi
[[ ! -e "$FAIL_OUTPUT" ]]
if hdiutil info | grep -F "$FAIL_ROOT" >/dev/null; then
  echo "build-dmg.test: failed run left a mounted image" >&2
  exit 1
fi

echo "build-dmg.test: ok"
