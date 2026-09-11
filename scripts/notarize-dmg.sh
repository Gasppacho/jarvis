#!/bin/bash
# Submit a signed Jarvis DMG, staple the accepted ticket, and validate it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT="${JARVIS_DMG_PATH:-${JARVIS_DMG_OUTPUT:-}}"
PROFILE="${JARVIS_NOTARY_KEYCHAIN_PROFILE:-}"
KEYCHAIN="${JARVIS_NOTARY_KEYCHAIN:-}"
API_KEY_PATH="${JARVIS_NOTARY_API_KEY_PATH:-${JARVIS_NOTARY_KEY:-}}"
API_KEY_ID="${JARVIS_NOTARY_API_KEY_ID:-${JARVIS_NOTARY_KEY_ID:-}}"
API_ISSUER_ID="${JARVIS_NOTARY_API_ISSUER_ID:-${JARVIS_NOTARY_ISSUER:-}}"
XCRUN="${JARVIS_XCRUN_BIN:-xcrun}"

usage() {
  cat <<'EOF'
Usage: scripts/notarize-dmg.sh [DMG_PATH]

The input defaults to JARVIS_DMG_PATH, JARVIS_DMG_OUTPUT, or the only
dist/Jarvis-*.dmg file. The input is replaced only after stapling and
validation succeed.

Authentication (configure exactly one):
  JARVIS_NOTARY_KEYCHAIN_PROFILE   notarytool keychain profile name
  JARVIS_NOTARY_KEYCHAIN            optional keychain path for that profile

  JARVIS_NOTARY_API_KEY_PATH        App Store Connect .p8 private-key path
  JARVIS_NOTARY_API_KEY_ID          App Store Connect API key ID
  JARVIS_NOTARY_API_ISSUER_ID       issuer ID (optional for individual keys)

JARVIS_XCRUN_BIN is a test seam; it defaults to xcrun.
EOF
}

die() {
  printf 'notarize-dmg: error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --input|-i)
      (($# >= 2)) || die "missing value for $1"
      INPUT="$2"
      shift 2
      ;;
    --keychain-profile)
      (($# >= 2)) || die "missing value for $1"
      PROFILE="$2"
      shift 2
      ;;
    --keychain)
      (($# >= 2)) || die "missing value for $1"
      KEYCHAIN="$2"
      shift 2
      ;;
    --api-key)
      (($# >= 2)) || die "missing value for $1"
      API_KEY_PATH="$2"
      shift 2
      ;;
    --key-id)
      (($# >= 2)) || die "missing value for $1"
      API_KEY_ID="$2"
      shift 2
      ;;
    --issuer)
      (($# >= 2)) || die "missing value for $1"
      API_ISSUER_ID="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      die "unknown argument: $1"
      ;;
    *)
      [[ -z "$INPUT" ]] || die "multiple DMG paths supplied"
      INPUT="$1"
      shift
      ;;
  esac
done

if [[ "$XCRUN" == */* ]]; then
  [[ -x "$XCRUN" ]] || die "xcrun executable not found: $XCRUN"
else
  XCRUN="$(command -v "$XCRUN")" || die "required command not found: xcrun"
fi
command -v plutil >/dev/null 2>&1 || die "required command not found: plutil"
command -v cp >/dev/null 2>&1 || die "required command not found: cp"
command -v mv >/dev/null 2>&1 || die "required command not found: mv"
command -v mktemp >/dev/null 2>&1 || die "required command not found: mktemp"

PROFILE_CONFIGURED=0
API_CONFIGURED=0
[[ -n "$PROFILE" ]] && PROFILE_CONFIGURED=1
[[ -n "$KEYCHAIN" && -z "$PROFILE" ]] && \
  die "JARVIS_NOTARY_KEYCHAIN requires JARVIS_NOTARY_KEYCHAIN_PROFILE"
[[ -n "$API_KEY_PATH" || -n "$API_KEY_ID" || -n "$API_ISSUER_ID" ]] && API_CONFIGURED=1

if ((PROFILE_CONFIGURED && API_CONFIGURED)); then
  die "configure either a notarytool keychain profile (JARVIS_NOTARY_KEYCHAIN_PROFILE) or an App Store Connect API-key configuration, not both"
fi
if ((PROFILE_CONFIGURED == 0 && API_CONFIGURED == 0)); then
  die "no notarization credentials configured; set JARVIS_NOTARY_KEYCHAIN_PROFILE for a notarytool keychain profile, or configure JARVIS_NOTARY_API_KEY_PATH and JARVIS_NOTARY_API_KEY_ID for an App Store Connect API key"
fi
if ((API_CONFIGURED)); then
  [[ -n "$API_KEY_PATH" && -n "$API_KEY_ID" ]] || \
    die "App Store Connect API-key configuration requires JARVIS_NOTARY_API_KEY_PATH and JARVIS_NOTARY_API_KEY_ID"
  [[ -f "$API_KEY_PATH" ]] || die "App Store Connect API-key private key file not found"
fi

if [[ -z "$INPUT" ]]; then
  shopt -s nullglob
  DMGS=("$ROOT"/dist/Jarvis-*.dmg)
  shopt -u nullglob
  ((${#DMGS[@]} == 1)) || \
    die "expected exactly one versioned DMG in $ROOT/dist; pass its path explicitly"
  INPUT="${DMGS[0]}"
fi

INPUT_DIR="$(cd "$(dirname "$INPUT")" 2>/dev/null && pwd)" || \
  die "cannot resolve DMG directory: $(dirname "$INPUT")"
INPUT="$INPUT_DIR/$(basename "$INPUT")"
[[ -f "$INPUT" && ! -L "$INPUT" ]] || die "DMG not found or is a symlink: $INPUT"
case "$INPUT" in
  *.dmg) ;;
  *) die "input must be a DMG: $INPUT" ;;
esac

if "$XCRUN" stapler validate "$INPUT" >/dev/null 2>&1; then
  printf 'notarize-dmg: already stapled and valid: %s\n' "$INPUT"
  exit 0
fi

NOTARY_AUTH_ARGS=()
if ((PROFILE_CONFIGURED)); then
  NOTARY_AUTH_ARGS+=(--keychain-profile "$PROFILE")
  [[ -n "$KEYCHAIN" ]] && NOTARY_AUTH_ARGS+=(--keychain "$KEYCHAIN")
else
  NOTARY_AUTH_ARGS+=(--key "$API_KEY_PATH" --key-id "$API_KEY_ID")
  [[ -n "$API_ISSUER_ID" ]] && NOTARY_AUTH_ARGS+=(--issuer "$API_ISSUER_ID")
fi

WORK_DIR=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR" || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

WORK_DIR="$(mktemp -d "$INPUT_DIR/.jarvis-notary.XXXXXX")" || \
  die "could not create temporary notarization directory"
SUBMIT_OUTPUT="$WORK_DIR/submit.json"
SUBMIT_ERROR="$WORK_DIR/submit.error"

printf 'notarize-dmg: submitting %s and waiting for verdict\n' "$(basename "$INPUT")"
set +e
"$XCRUN" notarytool submit \
  "${NOTARY_AUTH_ARGS[@]}" \
  --output-format json \
  --no-progress \
  --wait \
  "$INPUT" >"$SUBMIT_OUTPUT" 2>"$SUBMIT_ERROR"
SUBMIT_EXIT=$?
set -e

SUBMISSION_ID="$(plutil -extract id raw -o - "$SUBMIT_OUTPUT" 2>/dev/null || true)"
STATUS="$(plutil -extract status raw -o - "$SUBMIT_OUTPUT" 2>/dev/null || true)"
[[ -n "$STATUS" ]] || \
  die "notarytool submit failed before a final verdict (exit $SUBMIT_EXIT); the DMG was not changed"

case "$STATUS" in
  Invalid|Rejected)
    [[ -n "$SUBMISSION_ID" ]] || die "notarytool rejected the DMG without a submission identifier"
    NOTARY_LOG="$WORK_DIR/notary.log"
    NOTARY_LOG_ERROR="$WORK_DIR/notary-log.error"
    printf 'notarize-dmg: submission %s was rejected; retrieving the notary log\n' "$SUBMISSION_ID" >&2
    set +e
    "$XCRUN" notarytool log \
      "${NOTARY_AUTH_ARGS[@]}" \
      "$SUBMISSION_ID" >"$NOTARY_LOG" 2>"$NOTARY_LOG_ERROR"
    LOG_EXIT=$?
    set -e
    if [[ -s "$NOTARY_LOG" ]]; then
      printf '%s\n' '--- notary log ---' >&2
      cat "$NOTARY_LOG" >&2
      printf '%s\n' '--- end notary log ---' >&2
    fi
    ((LOG_EXIT == 0)) || die "could not retrieve the notary log for submission $SUBMISSION_ID"
    exit 1
    ;;
  Accepted)
    ((SUBMIT_EXIT == 0)) || \
      die "notarytool reported Accepted but exited with status $SUBMIT_EXIT; the DMG was not changed"
    ;;
  *)
    die "notarytool returned unhandled status $STATUS (exit $SUBMIT_EXIT); the DMG was not changed"
    ;;
esac

STAGED="$WORK_DIR/$(basename "$INPUT")"
cp -p "$INPUT" "$STAGED" || die "could not stage the DMG for stapling; the original was not changed"

STAPLE_OUTPUT="$WORK_DIR/staple.output"
STAPLE_ERROR="$WORK_DIR/staple.error"
set +e
"$XCRUN" stapler staple "$STAGED" >"$STAPLE_OUTPUT" 2>"$STAPLE_ERROR"
STAPLE_EXIT=$?
set -e
((STAPLE_EXIT == 0)) || die "stapler could not attach the ticket; the original DMG was not changed"

VALIDATE_OUTPUT="$WORK_DIR/validate.output"
VALIDATE_ERROR="$WORK_DIR/validate.error"
set +e
"$XCRUN" stapler validate "$STAGED" >"$VALIDATE_OUTPUT" 2>"$VALIDATE_ERROR"
VALIDATE_EXIT=$?
set -e
((VALIDATE_EXIT == 0)) || die "stapler validation failed; the original DMG was not changed"

mv -f "$STAGED" "$INPUT" || die "could not publish the stapled DMG; the original was not changed"
printf 'notarize-dmg: stapled ticket validated: %s\n' "$INPUT"
