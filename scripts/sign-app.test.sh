#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_APP="${JARVIS_APP_PATH:-$ROOT/dist/Jarvis.app}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-sign-app-test.XXXXXX")"
APP="$TEST_ROOT/Jarvis.app"

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  rm -rf "$TEST_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

[[ "$(uname -s)" == "Darwin" ]] || {
  echo 'sign-app.test: requires macOS' >&2
  exit 1
}
[[ -d "$SOURCE_APP" ]] || {
  echo "sign-app.test: app not found: $SOURCE_APP" >&2
  exit 1
}

ditto "$SOURCE_APP" "$APP"
"$ROOT/scripts/sign-app.sh" "$APP" >/dev/null

NATIVE="$APP/Contents/Resources/engine/native/better_sqlite3.node"
printf 'tamper' >> "$NATIVE"
if codesign --verify --strict "$APP" >/dev/null 2>&1; then
  echo 'sign-app.test: tampered nested code unexpectedly verified' >&2
  exit 1
fi

echo 'sign-app.test: ok'
