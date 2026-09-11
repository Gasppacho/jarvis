#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-release-test.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  rm -rf "$TEST_ROOT"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'release.test: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local needle="$1"
  local file="$2"
  if ! grep -F "$needle" "$file" >/dev/null; then
    sed -n '1,160p' "$file" >&2
    fail "expected $needle in $file"
  fi
}

make_fixture() {
  local name="$1"
  local mode="$2"
  local root="$TEST_ROOT/$name"
  mkdir -p "$root/bin" "$root/scripts" "$root/dist"
  cp "$SCRIPT" "$root/scripts/release.sh"
  chmod +x "$root/scripts/release.sh"

  git -C "$root" init -q
  git -C "$root" config user.email release-test@example.invalid
  git -C "$root" config user.name Release-Test
  git -C "$root" add scripts/release.sh
  git -C "$root" commit -q -m fixture

  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    '[[ "${1:-}" == run && "${2:-}" == build:app ]] || exit 64' \
    'root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    'if [[ "${RELEASE_BUILD_MODE:-fresh}" == stale ]]; then exit 0; fi' \
    'mkdir -p "$root/dist/Jarvis.app/Contents/Resources"' \
    'printf build > "$root/build.marker"' \
    'printf "%s\n" "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>" > "$root/dist/Jarvis.app/Contents/Info.plist"' \
    'commit="$(git -C "$root" rev-parse HEAD)"' \
    'printf "{\"buildCommit\":\"%s\"}\n" "$commit" > "$root/dist/Jarvis.app/Contents/Resources/build-manifest.json"' \
    > "$root/bin/pnpm"
  chmod +x "$root/bin/pnpm"

  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    'printf sign > "$root/sign.marker"' \
    > "$root/scripts/sign-app.sh"
  chmod +x "$root/scripts/sign-app.sh"

  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    'step=unknown' \
    'while (($# > 0)); do [[ "$1" == --step ]] && step="$2" && shift 2 || shift; done' \
    'printf "%s\n" "$step" >> "$root/smoke.steps"' \
    'if [[ "${RELEASE_FAIL_SMOKE:-}" == "$step" ]]; then exit 71; fi' \
    > "$root/scripts/smoke-bundle.sh"
  chmod +x "$root/scripts/smoke-bundle.sh"

  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    'output=' \
    'while (($# > 0)); do [[ "$1" == --output ]] && output="$2" && shift 2 || shift; done' \
    'mkdir -p "$(dirname "$output")"' \
    'printf dmg > "$output"' \
    'printf dmg > "$root/dmg.marker"' \
    > "$root/scripts/build-dmg.sh"
  chmod +x "$root/scripts/build-dmg.sh"

  printf '%s\n' \
    '#!/bin/bash' \
    'set -euo pipefail' \
    'root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    'if [[ "${RELEASE_NOTARY_MODE:-missing}" == missing ]]; then' \
    '  printf "notary credentials missing: configure a keychain profile or API key\n" >&2' \
    '  exit 64' \
    'fi' \
    'printf notarized > "$root/notarize.marker"' \
    > "$root/scripts/notarize-dmg.sh"
  chmod +x "$root/scripts/notarize-dmg.sh"

  if [[ "$mode" == stale ]]; then
    mkdir -p "$root/dist/Jarvis.app/Contents/Resources"
    printf '%s\n' \
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>' \
      > "$root/dist/Jarvis.app/Contents/Info.plist"
    printf '%s\n' '{"buildCommit":"old-build"}' \
      > "$root/dist/Jarvis.app/Contents/Resources/build-manifest.json"
  fi

  printf '%s\n' "$root"
}

bash -n "$SCRIPT"
bash -n "$BASH_SOURCE"

NO_CREDENTIALS_ROOT="$(make_fixture no-credentials fresh)"
NO_CREDENTIALS_LOG="$NO_CREDENTIALS_ROOT/release.log"
if ! (
  cd "$NO_CREDENTIALS_ROOT"
  PATH="$NO_CREDENTIALS_ROOT/bin:$PATH" \
    RELEASE_NOTARY_MODE=missing \
    scripts/release.sh >"$NO_CREDENTIALS_LOG" 2>&1
); then
  :
else
  fail "no-credentials release unexpectedly succeeded"
fi
assert_contains 'release: FAILED step=notarize-dmg' "$NO_CREDENTIALS_LOG"
assert_contains 'notary credentials missing' "$NO_CREDENTIALS_LOG"
[[ -f "$NO_CREDENTIALS_ROOT/build.marker" ]] || fail 'build did not run'
[[ -f "$NO_CREDENTIALS_ROOT/sign.marker" ]] || fail 'sign did not run'
[[ "$(tr '\n' ' ' < "$NO_CREDENTIALS_ROOT/smoke.steps")" == 'launch import recovery ' ]] ||
  fail 'smoke steps did not run in order'
[[ -f "$NO_CREDENTIALS_ROOT/dmg.marker" ]] || fail 'DMG did not run'
[[ -f "$NO_CREDENTIALS_ROOT/dist/Jarvis-0.1.0.dmg" ]] || fail 'DMG output is missing'
[[ ! -e "$NO_CREDENTIALS_ROOT/notarize.marker" ]] || fail 'notarization marker exists after failure'

STALE_ROOT="$(make_fixture stale stale)"
STALE_LOG="$STALE_ROOT/release.log"
if (
  cd "$STALE_ROOT"
  PATH="$STALE_ROOT/bin:$PATH" \
    RELEASE_BUILD_MODE=stale \
    scripts/release.sh >"$STALE_LOG" 2>&1
); then
  fail 'stale build unexpectedly succeeded'
fi
assert_contains 'release: FAILED step=build-app' "$STALE_LOG"
assert_contains 'built app is stale' "$STALE_LOG"
[[ ! -e "$STALE_ROOT/sign.marker" ]] || fail 'stale app reached signing'
[[ ! -e "$STALE_ROOT/dmg.marker" ]] || fail 'stale app reached DMG creation'

SMOKE_ROOT="$(make_fixture smoke-failure fresh)"
SMOKE_LOG="$SMOKE_ROOT/release.log"
if (
  cd "$SMOKE_ROOT"
  PATH="$SMOKE_ROOT/bin:$PATH" \
    RELEASE_FAIL_SMOKE=import \
    scripts/release.sh >"$SMOKE_LOG" 2>&1
); then
  fail 'smoke failure unexpectedly succeeded'
fi
assert_contains 'release: FAILED step=smoke-import' "$SMOKE_LOG"
[[ ! -e "$SMOKE_ROOT/dmg.marker" ]] || fail 'DMG ran after smoke failure'
[[ ! -e "$SMOKE_ROOT/notarize.marker" ]] || fail 'notarization ran after smoke failure'

printf 'release.test: ok\n'
