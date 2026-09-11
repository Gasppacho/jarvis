#!/bin/bash
# Signs an assembled Jarvis.app. Nested Mach-O files are signed explicitly
# because codesign --deep does not discover code below Contents/Resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_APP="$ROOT/dist/Jarvis.app"
ENGINE_ENTITLEMENTS="$ROOT/scripts/jarvis-engine.entitlements.plist"

usage() {
  printf '%s\n' \
    "Usage: scripts/sign-app.sh [APP_PATH] [IDENTITY]" \
    "  APP_PATH defaults to dist/Jarvis.app." \
    "  IDENTITY defaults to JARVIS_CODESIGN_IDENTITY or ad-hoc (-)."
}

die() {
  printf 'sign-app: error: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -gt 2 ]; then
  usage >&2
  exit 2
fi

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

APP="${1:-$DEFAULT_APP}"
IDENTITY="${2:-${JARVIS_CODESIGN_IDENTITY:--}}"
MAIN_BINARY="$APP/Contents/MacOS/Jarvis"
ENGINE_NODE="$APP/Contents/Resources/engine/node"

for command in codesign file find mktemp plutil; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

[ -d "$APP/Contents" ] || die "app bundle not found: $APP"
[ -f "$ENGINE_ENTITLEMENTS" ] || die "entitlements file not found: $ENGINE_ENTITLEMENTS"
plutil -lint "$ENGINE_ENTITLEMENTS" >/dev/null || die "invalid entitlements file: $ENGINE_ENTITLEMENTS"

if [ "$IDENTITY" = "-" ]; then
  printf '%s\n' "sign-app: using ad-hoc identity (-); this is locally verifiable, not Developer ID or notarized."
else
  printf 'sign-app: using configured identity: %s\n' "$IDENTITY"
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-sign.XXXXXX")" || die "could not create temporary directory"
trap 'rm -rf "$WORK_DIR"' EXIT

ALL_FILES="$WORK_DIR/all-files"
MACHO_FILES="$WORK_DIR/macho-files"
: > "$MACHO_FILES"
find "$APP" -type f -print0 > "$ALL_FILES" || die "could not enumerate files in $APP"

MACHO_COUNT=0
while IFS= read -r -d '' path; do
  if ! description="$(file -b "$path" 2>/dev/null)"; then
    die "could not inspect file: $path"
  fi
  case "$description" in
    *Mach-O*)
      printf '%s\0' "$path" >> "$MACHO_FILES"
      MACHO_COUNT=$((MACHO_COUNT + 1))
      ;;
  esac
done < "$ALL_FILES"

[ "$MACHO_COUNT" -gt 0 ] || die "no Mach-O files found in $APP"

require_macho() {
  local path="$1"
  [ -f "$path" ] || die "required Mach-O is missing: $path"
  local description
  description="$(file -b "$path" 2>/dev/null)" || die "could not inspect required Mach-O: $path"
  case "$description" in
    *Mach-O*) ;;
    *) die "required path is not Mach-O: $path" ;;
  esac
}

require_macho "$MAIN_BINARY"
require_macho "$ENGINE_NODE"

SIGN_ARGS=(--force --sign "$IDENTITY" --options runtime)
if [ "$IDENTITY" = "-" ]; then
  SIGN_ARGS+=(--timestamp=none)
fi

sign_macho() {
  local path="$1"
  printf 'sign-app: signing nested Mach-O %s\n' "$path"
  if [ "$path" = "$ENGINE_NODE" ]; then
    if ! codesign "${SIGN_ARGS[@]}" --entitlements "$ENGINE_ENTITLEMENTS" "$path"; then
      die "failed to sign Mach-O: $path"
    fi
  elif ! codesign "${SIGN_ARGS[@]}" "$path"; then
    die "failed to sign Mach-O: $path"
  fi
}

# The main binary is intentionally deferred until every nested Mach-O is done.
while IFS= read -r -d '' path; do
  [ "$path" = "$MAIN_BINARY" ] && continue
  sign_macho "$path"
done < "$MACHO_FILES"

printf 'sign-app: signing main binary %s\n' "$MAIN_BINARY"
if ! codesign "${SIGN_ARGS[@]}" "$MAIN_BINARY"; then
  die "failed to sign main binary: $MAIN_BINARY"
fi

printf 'sign-app: signing app bundle %s\n' "$APP"
if ! codesign "${SIGN_ARGS[@]}" "$APP"; then
  die "failed to sign app bundle: $APP"
fi

EXPECTED_ENTITLEMENTS="$WORK_DIR/expected-entitlements.plist"
ACTUAL_ENTITLEMENTS="$WORK_DIR/actual-entitlements.plist"
plutil -convert xml1 -o "$EXPECTED_ENTITLEMENTS" "$ENGINE_ENTITLEMENTS" \
  || die "could not normalize entitlements file"

verify_code_signature() {
  local path="$1"
  local details
  details="$(codesign --display --verbose=4 "$path" 2>&1)" \
    || die "could not inspect signature: $path"
  case "$details" in
    *"flags="*"runtime"*) ;;
    *) die "hardened runtime is missing: $path" ;;
  esac

  : > "$ACTUAL_ENTITLEMENTS"
  if ! codesign --display --entitlements - --xml "$path" \
    > "$ACTUAL_ENTITLEMENTS" 2>/dev/null; then
    die "could not inspect entitlements: $path"
  fi
  if [ "$path" = "$ENGINE_NODE" ]; then
    plutil -convert xml1 -o "$ACTUAL_ENTITLEMENTS.normalized" "$ACTUAL_ENTITLEMENTS" \
      || die "Node entitlements are not valid: $path"
    if ! cmp -s "$EXPECTED_ENTITLEMENTS" "$ACTUAL_ENTITLEMENTS.normalized"; then
      die "Node entitlements differ from $ENGINE_ENTITLEMENTS: $path"
    fi
  elif [ -s "$ACTUAL_ENTITLEMENTS" ]; then
    die "unexpected entitlements on $path"
  fi
}

verify_macho() {
  local path="$1"
  if ! codesign --verify --strict --verbose=2 "$path"; then
    die "Mach-O is unsigned or invalid: $path"
  fi
  verify_code_signature "$path"
}

while IFS= read -r -d '' path; do
  verify_macho "$path"
done < "$MACHO_FILES"

if ! codesign --verify --strict --verbose=2 "$APP"; then
  die "app bundle signature is invalid: $APP"
fi
verify_code_signature "$APP"

printf 'sign-app: verifying bundle recursively\n'
if ! codesign --verify --deep --strict --verbose=2 "$APP"; then
  die "recursive bundle verification failed: $APP"
fi

printf 'sign-app: signed and verified %s Mach-O file(s); hardened runtime is enabled.\n' "$MACHO_COUNT"
printf '%s\n' "sign-app: Node entitlements are exactly $ENGINE_ENTITLEMENTS; app and native addons have none."
