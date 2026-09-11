#!/bin/bash
# Runs the macOS release steps in the order that produces a distributable DMG.
# notarize-dmg.sh owns submission, waiting, stapling and staple validation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/Jarvis.app"
NOTARIZE="$ROOT/scripts/notarize-dmg.sh"
STEP="startup"
BUILD_MARKER=""
DMG_MARKER=""
SOURCE_COMMIT=""
DMG=""

usage() {
  cat <<'EOF'
Usage: scripts/release.sh

Runs build:app, sign-app, smoke launch/import/recovery, build-dmg and
notarize-dmg in order. JARVIS_CODESIGN_IDENTITY and the notarization
configuration are passed to the standalone scripts without being inspected.
JARVIS_DMG_OUTPUT may override the default versioned DMG path.
EOF
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  [[ -z "$BUILD_MARKER" ]] || rm -f "$BUILD_MARKER"
  [[ -z "$DMG_MARKER" ]] || rm -f "$DMG_MARKER"
  exit "$status"
}

run_step() {
  STEP="$1"
  shift
  printf 'release: START step=%s\n' "$STEP"
  if "$@"; then
    printf 'release: PASS step=%s\n' "$STEP"
    return 0
  else
    local status=$?
    (( status == 0 )) && status=1
    printf 'release: FAILED step=%s exit=%s\n' "$STEP" "$status" >&2
    exit "$status"
  fi
}

require_executable() {
  local path="$1"
  [[ -x "$path" ]] || {
    printf 'expected executable: %s\n' "$path" >&2
    return 1
  }
}

prepare_build() {
  command -v pnpm >/dev/null 2>&1 || {
    printf 'pnpm is required\n' >&2
    return 1
  }
  command -v node >/dev/null 2>&1 || {
    printf 'node is required\n' >&2
    return 1
  }
  SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD)" || {
    printf 'source tree has no Git commit\n' >&2
    return 1
  }
  BUILD_MARKER="$(mktemp "${TMPDIR:-/tmp}/jarvis-release-build.XXXXXX")" || return 1
}

validate_app() {
  local manifest="$APP/Contents/Resources/build-manifest.json"
  [[ -d "$APP/Contents" ]] || {
    printf 'built app is missing: %s\n' "$APP" >&2
    return 1
  }
  [[ -f "$manifest" ]] || {
    printf 'build manifest is missing: %s\n' "$manifest" >&2
    return 1
  }
  [[ -n "$(find "$APP" -type f -newer "$BUILD_MARKER" -print -quit)" ]] || {
    printf 'built app is stale: no output is newer than the build start\n' >&2
    return 1
  }

  local build_commit
  build_commit="$(node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof manifest.buildCommit !== "string" || manifest.buildCommit.length === 0) process.exit(2);
    process.stdout.write(manifest.buildCommit);
  ' "$manifest")" || {
    printf 'build manifest has no valid buildCommit\n' >&2
    return 1
  }
  [[ "$build_commit" == "$SOURCE_COMMIT" ]] || {
    printf 'built app is stale: manifest commit %s differs from source %s\n' \
      "$build_commit" "$SOURCE_COMMIT" >&2
    return 1
  }
}

prepare_dmg() {
  require_executable "$ROOT/scripts/build-dmg.sh" || return 1
  local version
  version="$(plutil -extract CFBundleShortVersionString raw -o - \
    "$APP/Contents/Info.plist")" || return 1
  [[ -n "$version" ]] || return 1
  DMG="${JARVIS_DMG_OUTPUT:-$ROOT/dist/Jarvis-$version.dmg}"
  case "$DMG" in
    /*) ;;
    *) DMG="$ROOT/$DMG" ;;
  esac
  DMG_MARKER="$(mktemp "${TMPDIR:-/tmp}/jarvis-release-dmg.XXXXXX")" || return 1
}

validate_dmg() {
  [[ -s "$DMG" ]] || {
    printf 'DMG is missing or empty: %s\n' "$DMG" >&2
    return 1
  }
  [[ -n "$(find "$DMG" -newer "$DMG_MARKER" -print -quit)" ]] || {
    printf 'DMG is stale: it was not rebuilt during this release\n' >&2
    return 1
  }
}

validate_notarizer() {
  require_executable "$NOTARIZE" || return 1
  [[ -s "$DMG" ]] || {
    printf 'notarization input is missing: %s\n' "$DMG" >&2
    return 1
  }
}

if (($# > 0)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
fi

cd "$ROOT"
trap cleanup EXIT INT TERM HUP

run_step build-app prepare_build
run_step build-app pnpm run build:app
run_step build-app validate_app

run_step sign-app require_executable "$ROOT/scripts/sign-app.sh"
run_step sign-app "$ROOT/scripts/sign-app.sh" "$APP"

run_step smoke-launch "$ROOT/scripts/smoke-bundle.sh" --app "$APP" --step launch
run_step smoke-import "$ROOT/scripts/smoke-bundle.sh" --app "$APP" --step import
run_step smoke-recovery "$ROOT/scripts/smoke-bundle.sh" --app "$APP" --step recovery

run_step build-dmg prepare_dmg
run_step build-dmg "$ROOT/scripts/build-dmg.sh" --app "$APP" --output "$DMG"
run_step build-dmg validate_dmg

run_step notarize-dmg validate_notarizer
run_step notarize-dmg "$NOTARIZE" "$DMG"

printf 'release: PASS %s\n' "$DMG"
