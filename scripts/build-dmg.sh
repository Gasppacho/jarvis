#!/bin/bash
# Builds a signed, compressed, read-only DMG from an already-signed Jarvis.app.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-dmg.sh [--app PATH] [--output PATH]

Environment:
  JARVIS_APP_PATH              Default: <repo>/dist/Jarvis.app
  JARVIS_DMG_OUTPUT            Default: <repo>/dist/Jarvis-<version>.dmg
  JARVIS_CODESIGN_IDENTITY     Default: - (ad-hoc)

The output filename must end in .dmg and contain the app version. This script
does not notarize or staple the image.
EOF
}

die() {
  printf 'build-dmg: %s\n' "$*" >&2
  exit 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${JARVIS_APP_PATH:-$ROOT/dist/Jarvis.app}"
OUTPUT="${JARVIS_DMG_OUTPUT:-}"
IDENTITY="${JARVIS_CODESIGN_IDENTITY:--}"

while (($# > 0)); do
  case "$1" in
    --app|-a)
      (($# >= 2)) || die "missing value for $1"
      APP="$2"
      shift 2
      ;;
    --output|-o)
      (($# >= 2)) || die "missing value for $1"
      OUTPUT="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "requires macOS"
[[ "$(uname -m)" == "arm64" ]] || die "requires arm64 macOS"

for tool in codesign ditto hdiutil plutil mktemp awk; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

case "$APP" in
  /*) ;;
  *) APP="$PWD/$APP" ;;
esac
[[ -d "$APP" ]] || die "app not found: $APP"
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

INFO_PLIST="$APP/Contents/Info.plist"
[[ -f "$INFO_PLIST" ]] || die "missing app Info.plist: $INFO_PLIST"
VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST")" || \
  die "cannot read CFBundleShortVersionString from $INFO_PLIST"
case "$VERSION" in
  ""|*[![:alnum:]._-]*) die "unsafe app version for a DMG filename: $VERSION" ;;
esac

if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$ROOT/dist/Jarvis-$VERSION.dmg"
fi
case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="$PWD/$OUTPUT" ;;
esac
OUTPUT_DIR="$(dirname "$OUTPUT")"
OUTPUT_NAME="$(basename "$OUTPUT")"
case "$OUTPUT_NAME" in
  *.dmg) ;;
  *) die "output must end in .dmg: $OUTPUT" ;;
esac
case "$OUTPUT_NAME" in
  *"$VERSION"*) ;;
  *) die "output filename must contain app version $VERSION: $OUTPUT" ;;
esac
mkdir -p "$OUTPUT_DIR"

WORK_DIR=""
STAGING=""
TEMP_DMG=""
MOUNT_POINT=""
ATTACHED_DEVICE=""
ATTACH_ATTEMPTED=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP

  if [[ "$ATTACH_ATTEMPTED" -eq 1 ]]; then
    if [[ -n "$MOUNT_POINT" ]]; then
      hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
    fi
    if [[ -n "$ATTACHED_DEVICE" ]]; then
      hdiutil detach "$ATTACHED_DEVICE" -force >/dev/null 2>&1 || true
    fi
  fi

  if [[ "$status" -ne 0 && -n "$TEMP_DMG" && -e "$TEMP_DMG" ]]; then
    rm -f "$TEMP_DMG" || true
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR" || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

WORK_DIR="$(mktemp -d "$OUTPUT_DIR/.jarvis-dmg.XXXXXX")"
STAGING="$WORK_DIR/staging"
TEMP_DMG="$WORK_DIR/Jarvis-$VERSION.dmg"
MOUNT_POINT="$WORK_DIR/mount"
mkdir -p "$STAGING" "$MOUNT_POINT"

echo "build-dmg: verifying signed source app"
codesign --verify --deep --strict --verbose=2 "$APP" >/dev/null

echo "build-dmg: copying app"
ditto "$APP" "$STAGING/Jarvis.app"
ln -s /Applications "$STAGING/Applications"
codesign --verify --deep --strict --verbose=2 "$STAGING/Jarvis.app" >/dev/null

echo "build-dmg: creating compressed read-only image"
hdiutil create \
  -quiet \
  -format UDZO \
  -volname "Jarvis $VERSION" \
  -srcfolder "$STAGING" \
  "$TEMP_DMG"

echo "build-dmg: signing image with $IDENTITY"
codesign --force --sign "$IDENTITY" "$TEMP_DMG"
codesign --verify --strict --verbose=2 "$TEMP_DMG" >/dev/null

echo "build-dmg: verifying mounted contents"
ATTACH_ATTEMPTED=1
ATTACH_OUTPUT="$(hdiutil attach \
  -nobrowse \
  -noautoopen \
  -readonly \
  -mountpoint "$MOUNT_POINT" \
  "$TEMP_DMG")"
ATTACHED_DEVICE="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '$1 ~ /^\/dev\/disk/ { device = $1 } END { print device }')"
[[ -d "$MOUNT_POINT/Jarvis.app" ]] || die "mounted image is missing Jarvis.app"
[[ -L "$MOUNT_POINT/Applications" ]] || die "mounted image is missing the Applications symlink"
[[ "$(readlink "$MOUNT_POINT/Applications")" == "/Applications" ]] || \
  die "Applications symlink does not target /Applications"
codesign --verify --deep --strict --verbose=2 "$MOUNT_POINT/Jarvis.app" >/dev/null
hdiutil detach "$MOUNT_POINT" -force >/dev/null
ATTACH_ATTEMPTED=0

mv -f "$TEMP_DMG" "$OUTPUT"
echo "build-dmg: $OUTPUT"
