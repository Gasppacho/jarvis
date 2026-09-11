#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/notarize-dmg.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-notarize-dmg-test.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  rm -rf "$TEST_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

FAKE_XCRUN="$TEST_ROOT/xcrun"
CALLS="$TEST_ROOT/calls.log"
INPUT="$TEST_ROOT/Jarvis-0.1.0.dmg"
PRIVATE_KEY="$TEST_ROOT/AuthKey_TEST.p8"

cat > "$FAKE_XCRUN" <<'EOF'
#!/bin/bash
set -euo pipefail

CALLS_FILE="${FAKE_CALLS_FILE:?}"
printf '%s %s\n' "${1:-}" "${2:-}" >> "$CALLS_FILE"

case "${1:-}:${2:-}" in
  notarytool:submit)
    [[ " $* " == *" --wait "* ]] || exit 97
    [[ " $* " == *" --output-format json "* ]] || exit 98
    printf '{"id":"submission-123","status":"%s"}\n' "${FAKE_NOTARY_STATUS:-Accepted}"
    exit "${FAKE_SUBMIT_EXIT:-0}"
    ;;
  notarytool:log)
    [[ "${!#}" == "submission-123" ]] || exit 99
    log="${FAKE_NOTARY_LOG:-{\"issues\":[{\"message\":\"rejected\"}]}}"
    printf '%s\n' "$log"
    ;;
  stapler:staple)
    printf '\nSTAPLED-TICKET\n' >> "${3:?}"
    ;;
  stapler:validate)
    grep -F 'STAPLED-TICKET' "${3:?}" >/dev/null
    ;;
  *)
    exit 96
    ;;
esac
EOF
chmod +x "$FAKE_XCRUN"

printf 'original-dmg\n' > "$INPUT"
printf 'PRIVATE_KEY_VALUE_MUST_NOT_BE_PRINTED\n' > "$PRIVATE_KEY"

assert_contains() {
  local needle="$1"
  local haystack="$2"
  [[ "$haystack" == *"$needle"* ]] || {
    printf 'notarize-dmg.test: missing output: %s\n%s\n' "$needle" "$haystack" >&2
    exit 1
  }
}

assert_not_contains() {
  local needle="$1"
  local haystack="$2"
  [[ "$haystack" != *"$needle"* ]] || {
    printf 'notarize-dmg.test: unexpected output: %s\n%s\n' "$needle" "$haystack" >&2
    exit 1
  }
}

export FAKE_CALLS_FILE="$CALLS"
export JARVIS_XCRUN_BIN="$FAKE_XCRUN"
export JARVIS_DMG_PATH="$INPUT"

: > "$CALLS"
if output="$(
  JARVIS_NOTARY_KEYCHAIN_PROFILE= \
  JARVIS_NOTARY_KEYCHAIN= \
  JARVIS_NOTARY_API_KEY_PATH= \
  JARVIS_NOTARY_API_KEY_ID= \
  JARVIS_NOTARY_API_ISSUER_ID= \
  JARVIS_NOTARY_KEY= \
  JARVIS_NOTARY_KEY_ID= \
  JARVIS_NOTARY_ISSUER= \
    "$SCRIPT" 2>&1
)"; then
  echo "notarize-dmg.test: missing credentials unexpectedly succeeded" >&2
  exit 1
fi
assert_contains 'JARVIS_NOTARY_KEYCHAIN_PROFILE' "$output"
assert_contains 'JARVIS_NOTARY_API_KEY_PATH' "$output"
[[ ! -s "$CALLS" ]]
[[ "$(<"$INPUT")" == "original-dmg" ]]
if find "$TEST_ROOT" -name '.jarvis-notary.*' -print -quit | grep -q .; then
  echo 'notarize-dmg.test: missing-credentials path left a temporary artifact' >&2
  exit 1
fi

: > "$CALLS"
if output="$(
  JARVIS_NOTARY_API_KEY_PATH="$PRIVATE_KEY" \
  JARVIS_NOTARY_API_KEY_ID=TESTKEY123 \
  JARVIS_NOTARY_API_ISSUER_ID=issuer-test \
  FAKE_NOTARY_STATUS=Invalid \
  FAKE_NOTARY_LOG='{"issues":[{"message":"bad signature"}]}' \
    "$SCRIPT" 2>&1
)"; then
  echo "notarize-dmg.test: rejected submission unexpectedly succeeded" >&2
  exit 1
fi
assert_contains 'notarytool submit' "$(<"$CALLS")"
assert_contains 'notarytool log' "$(<"$CALLS")"
assert_not_contains 'stapler staple' "$(<"$CALLS")"
assert_contains 'bad signature' "$output"
assert_not_contains 'PRIVATE_KEY_VALUE_MUST_NOT_BE_PRINTED' "$output"
[[ "$(<"$INPUT")" == "original-dmg" ]]

: > "$CALLS"
printf 'original-dmg\n' > "$INPUT"
output="$(
  JARVIS_NOTARY_KEYCHAIN_PROFILE=release-profile \
  JARVIS_NOTARY_KEYCHAIN= \
  JARVIS_NOTARY_API_KEY_PATH= \
  JARVIS_NOTARY_API_KEY_ID= \
  JARVIS_NOTARY_API_ISSUER_ID= \
  JARVIS_NOTARY_KEY= \
  JARVIS_NOTARY_KEY_ID= \
  JARVIS_NOTARY_ISSUER= \
  FAKE_NOTARY_STATUS=Accepted \
    "$SCRIPT" 2>&1
)"
assert_contains 'stapled ticket validated' "$output"
assert_contains 'notarytool submit' "$(<"$CALLS")"
assert_contains 'stapler staple' "$(<"$CALLS")"
assert_contains 'stapler validate' "$(<"$CALLS")"
assert_not_contains 'notarytool log' "$(<"$CALLS")"
assert_contains 'STAPLED-TICKET' "$(<"$INPUT")"
if find "$TEST_ROOT" -name '.jarvis-notary.*' -print -quit | grep -q .; then
  echo 'notarize-dmg.test: accepted path left a temporary artifact' >&2
  exit 1
fi

: > "$CALLS"
output="$(
  JARVIS_NOTARY_KEYCHAIN_PROFILE=release-profile \
    "$SCRIPT" 2>&1
)"
assert_contains 'already stapled and valid' "$output"
assert_contains 'stapler validate' "$(<"$CALLS")"
assert_not_contains 'notarytool submit' "$(<"$CALLS")"

echo 'notarize-dmg.test: ok'
