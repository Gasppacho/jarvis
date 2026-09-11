#!/bin/bash
# Smoke-test the Engine exactly as the assembled app ships it.
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_APP="$(cd "$SCRIPT_DIR/.." && pwd)/dist/Jarvis.app"
readonly MINIMAL_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
readonly READY_TIMEOUT_SECONDS="${JARVIS_SMOKE_READY_TIMEOUT_SECONDS:-20}"
readonly SHUTDOWN_TIMEOUT_SECONDS="${JARVIS_SMOKE_SHUTDOWN_TIMEOUT_SECONDS:-15}"
readonly CURL="/usr/bin/curl"
readonly ENV="/usr/bin/env"
readonly MKTEMP="/usr/bin/mktemp"
readonly PS="/bin/ps"
readonly RM="/bin/rm"
readonly GIT="/usr/bin/git"
readonly SQLITE="/usr/bin/sqlite3"

APP="${JARVIS_APP_PATH:-$DEFAULT_APP}"
APP_SET=0
STEP="launch"
RUN_ROOT=""
ENGINE_PID=""
ENGINE_REAPED=0
ENGINE_EXIT_CODE=""
SECOND_ENGINE_PID=""
SECOND_ENGINE_REAPED=0
SECOND_ENGINE_EXIT_CODE=""
TOKEN=""
IMPORTED_PROJECT_ID=""
SCHEMA_VERSION_BEFORE=""
SCHEMA_VERSION_AFTER=""

usage() {
  cat <<'EOF'
Usage: scripts/smoke-bundle.sh [--app PATH] [--step launch|import|recovery]

Launches the Engine from PATH/Contents/Resources/engine with a temporary data
root, checks the ready handshake and health, then shuts it down through HTTP.
The default app is dist/Jarvis.app; pass --app when testing an installed app.
EOF
}

fail() {
  printf 'smoke-bundle: ERROR %s\n' "$*" >&2
  exit 1
}

require_positive_integer() {
  case "$1" in
    ""|*[!0-9]*) fail "CONFIG_INVALID: timeout must be a positive integer." ;;
  esac
  (( "$1" > 0 )) || fail "CONFIG_INVALID: timeout must be a positive integer."
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --app)
      [[ "$#" -ge 2 ]] || fail "USAGE_ERROR: --app requires a bundle path."
      [[ "$APP_SET" -eq 0 ]] || fail "USAGE_ERROR: bundle path was provided more than once."
      APP="$2"
      APP_SET=1
      shift 2
      ;;
    --step)
      [[ "$#" -ge 2 ]] || fail "USAGE_ERROR: --step requires a name."
      STEP="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      [[ "$#" -eq 0 ]] || fail "USAGE_ERROR: unexpected argument: $1"
      ;;
    -* )
      fail "USAGE_ERROR: unknown option: $1"
      ;;
    *)
      [[ "$APP_SET" -eq 0 ]] || fail "USAGE_ERROR: bundle path was provided more than once."
      APP="$1"
      APP_SET=1
      shift
      ;;
  esac
done

require_positive_integer "$READY_TIMEOUT_SECONDS"
require_positive_integer "$SHUTDOWN_TIMEOUT_SECONDS"

case "$STEP" in
  launch|import|recovery) ;;
  *) fail "STEP_UNSUPPORTED: supported steps are launch, import and recovery (received $STEP)." ;;
esac

[[ -d "$APP" ]] || fail "BUNDLE_NOT_FOUND: app bundle does not exist: $APP"
APP="$(cd "$APP" && pwd)"

ENGINE_DIR="$APP/Contents/Resources/engine"
NODE="$ENGINE_DIR/node"
BUNDLE="$ENGINE_DIR/engine.bundle.mjs"
[[ -x "$NODE" ]] || fail "BUNDLED_NODE_MISSING: expected executable at $NODE"
[[ -f "$BUNDLE" ]] || fail "ENGINE_BUNDLE_MISSING: expected bundle at $BUNDLE"
[[ -x "$CURL" ]] || fail "SYSTEM_TOOL_MISSING: expected curl at $CURL"
[[ -x "$ENV" ]] || fail "SYSTEM_TOOL_MISSING: expected env at $ENV"

if PATH="$MINIMAL_PATH" command -v node >/dev/null 2>&1; then
  fail "PATH_ASSERTION_FAILED: minimal PATH resolves node."
fi
if PATH="$MINIMAL_PATH" command -v pnpm >/dev/null 2>&1; then
  fail "PATH_ASSERTION_FAILED: minimal PATH resolves pnpm."
fi

umask 077
RUN_ROOT="$($MKTEMP -d /tmp/jarvis-bundle-smoke.XXXXXX)" ||
  fail "TEMP_ROOT_FAILED: could not create a temporary run directory."
DATA_ROOT="$RUN_ROOT/data"
HOME_ROOT="$RUN_ROOT/home"
TMP_ROOT="$RUN_ROOT/tmp"
STDOUT_FILE="$RUN_ROOT/engine.stdout"
STDERR_FILE="$RUN_ROOT/engine.stderr"
SECOND_STDOUT_FILE="$RUN_ROOT/second-engine.stdout"
SECOND_STDERR_FILE="$RUN_ROOT/second-engine.stderr"
HANDSHAKE_FILE="$RUN_ROOT/handshake.json"
HEALTH_FILE="$RUN_ROOT/health.json"
PROJECT_FILE="$RUN_ROOT/project.json"
PROJECT_LIST_FILE="$RUN_ROOT/projects.json"
ERROR_FILE="$RUN_ROOT/import-error.json"
SCHEMA_ERROR_FILE="$RUN_ROOT/schema.error"
mkdir -p "$DATA_ROOT" "$HOME_ROOT" "$TMP_ROOT" ||
  fail "TEMP_ROOT_FAILED: could not prepare the temporary run directory."

TOKEN="$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n')"
[[ -n "$TOKEN" ]] || fail "TOKEN_GENERATION_FAILED: could not create a session token."

pid_state() {
  "$PS" -p "$1" -o state= 2>/dev/null | tr -d '[:space:]'
}

pid_is_running() {
  local state
  state="$(pid_state "$1")"
  [[ -n "$state" && "$state" != Z* ]]
}

reap_engine() {
  local pid="$ENGINE_PID"
  if [[ "$ENGINE_REAPED" -eq 0 ]]; then
    if wait "$pid"; then
      ENGINE_EXIT_CODE=0
    else
      ENGINE_EXIT_CODE=$?
    fi
    ENGINE_REAPED=1
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "$SECOND_ENGINE_PID" && "$SECOND_ENGINE_REAPED" -eq 0 ]]; then
    if pid_is_running "$SECOND_ENGINE_PID"; then
      kill -KILL "$SECOND_ENGINE_PID" 2>/dev/null || true
    fi
    wait "$SECOND_ENGINE_PID" 2>/dev/null || true
    SECOND_ENGINE_REAPED=1
  fi
  if [[ -n "$ENGINE_PID" && "$ENGINE_REAPED" -eq 0 ]]; then
    if pid_is_running "$ENGINE_PID"; then
      kill -TERM "$ENGINE_PID" 2>/dev/null || true
      sleep 1
      if pid_is_running "$ENGINE_PID"; then
        kill -KILL "$ENGINE_PID" 2>/dev/null || true
      fi
    fi
    wait "$ENGINE_PID" 2>/dev/null || true
    ENGINE_REAPED=1
  fi
  if [[ -n "$RUN_ROOT" && -d "$RUN_ROOT" ]]; then
    "$RM" -rf "$RUN_ROOT"
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_engine() {
  ENGINE_REAPED=0
  ENGINE_EXIT_CODE=""
  (
    cd "$RUN_ROOT"
    exec "$ENV" -i \
      "PATH=$MINIMAL_PATH" \
      "HOME=$HOME_ROOT" \
      "TMPDIR=$TMP_ROOT" \
      "LANG=C" \
      "LC_ALL=C" \
      "JARVIS_DATA_ROOT=$DATA_ROOT" \
      "JARVIS_API_TOKEN=$TOKEN" \
      "$NODE" "$BUNDLE"
  ) >"$STDOUT_FILE" 2>"$STDERR_FILE" &
  ENGINE_PID=$!
}

start_second_engine() {
  SECOND_ENGINE_REAPED=0
  SECOND_ENGINE_EXIT_CODE=""
  (
    cd "$RUN_ROOT"
    exec "$ENV" -i \
      "PATH=$MINIMAL_PATH" \
      "HOME=$HOME_ROOT" \
      "TMPDIR=$TMP_ROOT" \
      "LANG=C" \
      "LC_ALL=C" \
      "JARVIS_DATA_ROOT=$DATA_ROOT" \
      "JARVIS_API_TOKEN=$TOKEN" \
      "$NODE" "$BUNDLE"
  ) >"$SECOND_STDOUT_FILE" 2>"$SECOND_STDERR_FILE" &
  SECOND_ENGINE_PID=$!
}

wait_for_handshake() {
  local deadline=$(( $(date +%s) + READY_TIMEOUT_SECONDS ))
  local line
  while true; do
    if IFS= read -r line < "$STDOUT_FILE"; then
      printf '%s\n' "$line" >"$HANDSHAKE_FILE"
      return
    fi
    if ! pid_is_running "$ENGINE_PID"; then
      reap_engine
      fail "READY_HANDSHAKE_FAILED: Engine exited before ready (exit $ENGINE_EXIT_CODE)."
    fi
    if (( $(date +%s) >= deadline )); then
      fail "READY_HANDSHAKE_TIMEOUT: Engine did not report ready within ${READY_TIMEOUT_SECONDS}s."
    fi
    sleep 0.1
  done
}

json_field() {
  local field="$1"
  local file="$2"
  "$NODE" - "$field" "$file" 2>"$RUN_ROOT/json.error" <<'NODE'
const fs = require("node:fs");
const [field, file] = process.argv.slice(2);
try {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) process.exit(2);
  const fieldValue = value[field];
  if (fieldValue === null || typeof fieldValue === "object" || typeof fieldValue === "undefined") process.exit(2);
  process.stdout.write(String(fieldValue));
} catch {
  process.exit(1);
}
NODE
}

json_error_code() {
  "$NODE" - "$1" <<'NODE'
const fs = require("node:fs");
try {
  const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const code = body?.error?.code;
  if (typeof code !== "string" || code.length === 0) process.exit(2);
  process.stdout.write(code);
} catch {
  process.exit(1);
}
NODE
}

assert_project_list_contains() {
  "$NODE" - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [expectedId, file] = process.argv.slice(2);
try {
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(body?.items) || !body.items.some((item) => item?.id === expectedId)) {
    process.exit(2);
  }
} catch {
  process.exit(1);
}
NODE
}

read_handshake() {
  local handshake_type
  local api_version
  local session_id
  if ! handshake_type="$(json_field type "$HANDSHAKE_FILE")"; then
    fail "READY_HANDSHAKE_INVALID: handshake is not valid JSON."
  fi
  if ! HANDSHAKE_PORT="$(json_field port "$HANDSHAKE_FILE")"; then
    fail "READY_HANDSHAKE_INVALID: handshake has no valid port."
  fi
  if ! api_version="$(json_field apiVersion "$HANDSHAKE_FILE")"; then
    fail "READY_HANDSHAKE_INVALID: handshake has no API version."
  fi
  if ! session_id="$(json_field sessionId "$HANDSHAKE_FILE")"; then
    fail "READY_HANDSHAKE_INVALID: handshake has no session id."
  fi
  [[ "$handshake_type" == "ready" ]] ||
    fail "READY_HANDSHAKE_INVALID: handshake type is not ready."
  [[ "$api_version" == "v1" ]] ||
    fail "READY_HANDSHAKE_INVALID: unsupported handshake API version."
  case "$HANDSHAKE_PORT" in
    ""|*[!0-9]*) fail "READY_HANDSHAKE_INVALID: handshake port is not numeric." ;;
  esac
  (( HANDSHAKE_PORT > 0 && HANDSHAKE_PORT < 65536 )) ||
    fail "READY_HANDSHAKE_INVALID: handshake port is out of range."
  [[ -n "$session_id" ]] || fail "READY_HANDSHAKE_INVALID: handshake session id is empty."
}

check_health() {
  if ! HEALTH_STATUS="$(
    "$CURL" -sS --connect-timeout 2 --max-time 5 \
      -o "$HEALTH_FILE" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "$BASE_URL/v1/health" 2>"$RUN_ROOT/health.error"
  )"; then
    fail "HEALTH_REQUEST_FAILED: GET /v1/health could not be completed."
  fi
  [[ "$HEALTH_STATUS" == "200" ]] ||
    fail "HEALTH_REQUEST_FAILED: GET /v1/health returned HTTP $HEALTH_STATUS."

  if ! HEALTH_STATE="$(json_field status "$HEALTH_FILE")"; then
    fail "HEALTH_RESPONSE_INVALID: health response is not valid JSON."
  fi
  if ! DATABASE_STATE="$(json_field database "$HEALTH_FILE")"; then
    fail "HEALTH_RESPONSE_INVALID: health response has no database state."
  fi
  [[ "$HEALTH_STATE" == "ready" ]] ||
    fail "HEALTH_NOT_READY: /v1/health status was not ready."
  [[ "$DATABASE_STATE" == "ready" ]] ||
    fail "HEALTH_NOT_READY: /v1/health database was not ready."
  assert_no_token_output
}

read_schema_version() {
  [[ -x "$SQLITE" ]] || fail "RECOVERY_SCHEMA_TOOL_MISSING: expected sqlite3 at $SQLITE."
  local schema_version
  if ! schema_version="$(
    "$SQLITE" "$DATA_ROOT/jarvis.sqlite" \
      'SELECT version FROM schema_migrations ORDER BY rowid DESC LIMIT 1;' \
      2>"$SCHEMA_ERROR_FILE"
  )"; then
    fail "RECOVERY_SCHEMA_READ_FAILED: could not read the database schema version."
  fi
  [[ -n "$schema_version" ]] ||
    fail "RECOVERY_SCHEMA_READ_FAILED: database schema version is empty."
  printf '%s' "$schema_version"
}

wait_for_second_engine_refusal() {
  local pid="$SECOND_ENGINE_PID"
  local deadline=$(( $(date +%s) + READY_TIMEOUT_SECONDS ))
  while pid_is_running "$pid"; do
    if (( $(date +%s) >= deadline )); then
      fail "RECOVERY_SECOND_ENGINE_TIMEOUT: second Engine did not refuse the data root."
    fi
    sleep 0.1
  done
  if wait "$pid" 2>/dev/null; then
    SECOND_ENGINE_EXIT_CODE=0
  else
    SECOND_ENGINE_EXIT_CODE=$?
  fi
  SECOND_ENGINE_REAPED=1
  SECOND_ENGINE_PID=""
  [[ "$SECOND_ENGINE_EXIT_CODE" -ne 0 ]] ||
    fail "RECOVERY_SECOND_ENGINE_ACCEPTED: second Engine unexpectedly started."
  grep -Fq 'system.engine-already-running' "$SECOND_STDERR_FILE" ||
    fail "RECOVERY_SECOND_ENGINE_WRONG_REFUSAL: second Engine did not report system.engine-already-running."
  assert_no_token_output
}

kill_engine_uncleanly() {
  local pid="$ENGINE_PID"
  kill -KILL "$pid" 2>/dev/null ||
    fail "RECOVERY_KILL_FAILED: could not uncleanly terminate the Engine."
  if wait "$pid" 2>/dev/null; then
    ENGINE_EXIT_CODE=0
  else
    ENGINE_EXIT_CODE=$?
  fi
  ENGINE_REAPED=1
  ENGINE_PID=""
  [[ "$ENGINE_EXIT_CODE" -ne 0 ]] ||
    fail "RECOVERY_KILL_FAILED: unclean Engine termination exited cleanly."
  if pid_is_running "$pid"; then
    fail "RECOVERY_KILL_FAILED: killed Engine process is still running."
  fi
}

run_recovery_step() {
  [[ -n "$IMPORTED_PROJECT_ID" ]] ||
    fail "RECOVERY_IMPORT_MISSING: recovery requires the imported Project."
  if ! SCHEMA_VERSION_BEFORE="$(read_schema_version)"; then
    fail "RECOVERY_SCHEMA_READ_FAILED: could not record the schema version before the kill."
  fi

  start_second_engine
  wait_for_second_engine_refusal
  kill_engine_uncleanly

  start_engine
  wait_for_handshake
  read_handshake
  BASE_URL="http://127.0.0.1:$HANDSHAKE_PORT"
  check_health

  local recovered_list_status
  recovered_list_status="$(
    "$CURL" -sS --connect-timeout 2 --max-time 5 \
      -o "$PROJECT_LIST_FILE" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "$BASE_URL/v1/projects" 2>"$RUN_ROOT/recovered-projects.error"
  )" || fail "RECOVERY_PROJECT_LIST_FAILED: project listing could not be completed."
  [[ "$recovered_list_status" == "200" ]] ||
    fail "RECOVERY_PROJECT_LIST_FAILED: project listing returned HTTP $recovered_list_status."
  assert_project_list_contains "$IMPORTED_PROJECT_ID" "$PROJECT_LIST_FILE" ||
    fail "RECOVERY_PROJECT_MISSING: imported Project was not listed after recovery."

  if ! SCHEMA_VERSION_AFTER="$(read_schema_version)"; then
    fail "RECOVERY_SCHEMA_READ_FAILED: could not read the schema version after recovery."
  fi
  [[ "$SCHEMA_VERSION_AFTER" == "$SCHEMA_VERSION_BEFORE" ]] ||
    fail "RECOVERY_SCHEMA_MISMATCH: schema version changed from $SCHEMA_VERSION_BEFORE to $SCHEMA_VERSION_AFTER."
  assert_no_token_output
}

run_import_step() {
  [[ -x "$GIT" ]] || fail "SYSTEM_TOOL_MISSING: expected git at $GIT."

  local repository="$RUN_ROOT/repository"
  local plain_directory="$RUN_ROOT/not-a-git-repository"
  mkdir -p "$repository" "$plain_directory"
  "$GIT" -C "$repository" init -q
  "$GIT" -C "$repository" config user.email smoke@example.invalid
  "$GIT" -C "$repository" config user.name Jarvis-Smoke
  printf 'packaged-engine-smoke\n' >"$repository/README.md"
  "$GIT" -C "$repository" add README.md
  "$GIT" -C "$repository" commit -q -m smoke

  local import_body
  import_body="$("$NODE" -e 'process.stdout.write(JSON.stringify({ repositoryPath: process.argv[1] }))' "$repository")"
  local import_status
  import_status="$(
    "$CURL" -sS --connect-timeout 2 --max-time 5 \
      -o "$PROJECT_FILE" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -X POST -d "$import_body" \
      "$BASE_URL/v1/projects" 2>"$RUN_ROOT/import.error"
  )" || fail "PROJECT_IMPORT_FAILED: import request could not be completed."
  [[ "$import_status" == "201" ]] ||
    fail "PROJECT_IMPORT_FAILED: import request returned HTTP $import_status."

  if ! IMPORTED_PROJECT_ID="$(json_field id "$PROJECT_FILE")"; then
    fail "PROJECT_IMPORT_FAILED: import response has no Project identity."
  fi

  local list_status
  list_status="$(
    "$CURL" -sS --connect-timeout 2 --max-time 5 \
      -o "$PROJECT_LIST_FILE" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "$BASE_URL/v1/projects" 2>"$RUN_ROOT/projects.error"
  )" || fail "PROJECT_LIST_FAILED: project listing could not be completed."
  [[ "$list_status" == "200" ]] ||
    fail "PROJECT_LIST_FAILED: project listing returned HTTP $list_status."
  assert_project_list_contains "$IMPORTED_PROJECT_ID" "$PROJECT_LIST_FILE" ||
    fail "PROJECT_LIST_FAILED: imported Project was not listed."

  local plain_body plain_status plain_code
  plain_body="$("$NODE" -e 'process.stdout.write(JSON.stringify({ repositoryPath: process.argv[1] }))' "$plain_directory")"
  plain_status="$(
    "$CURL" -sS --connect-timeout 2 --max-time 5 \
      -o "$ERROR_FILE" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -X POST -d "$plain_body" \
      "$BASE_URL/v1/projects" 2>"$RUN_ROOT/not-git.error"
  )" || fail "NON_GIT_IMPORT_FAILED: negative import request could not be completed."
  [[ "$plain_status" == "400" ]] ||
    fail "NON_GIT_IMPORT_FAILED: plain directory returned HTTP $plain_status."
  if ! plain_code="$(json_error_code "$ERROR_FILE")"; then
    fail "NON_GIT_IMPORT_FAILED: negative import response has no error code."
  fi
  [[ "$plain_code" == "repository.not-git" ]] ||
    fail "NON_GIT_IMPORT_FAILED: expected repository.not-git, got $plain_code."
}

assert_no_token_output() {
  local file
  for file in "$STDOUT_FILE" "$STDERR_FILE" "$SECOND_STDOUT_FILE" "$SECOND_STDERR_FILE" "$HANDSHAKE_FILE" "$HEALTH_FILE" "$PROJECT_FILE" "$PROJECT_LIST_FILE" "$ERROR_FILE"; do
    if [[ -f "$file" ]] && grep -Fq "$TOKEN" "$file"; then
      fail "SECRET_OUTPUT: session token appeared in captured output."
    fi
  done
}

wait_for_engine_exit() {
  local pid="$ENGINE_PID"
  local deadline=$(( $(date +%s) + SHUTDOWN_TIMEOUT_SECONDS ))
  while pid_is_running "$pid"; do
    if (( $(date +%s) >= deadline )); then
      fail "ENGINE_EXIT_TIMEOUT: Engine did not stop within ${SHUTDOWN_TIMEOUT_SECONDS}s."
    fi
    sleep 0.1
  done
  reap_engine
  [[ "$ENGINE_EXIT_CODE" -eq 0 ]] ||
    fail "ENGINE_EXIT_FAILED: Engine exited with code $ENGINE_EXIT_CODE after shutdown."
  if pid_is_running "$pid"; then
    fail "ENGINE_STILL_RUNNING: Engine process survived shutdown."
  fi
  ENGINE_PID=""
}

start_engine
wait_for_handshake
read_handshake
assert_no_token_output

BASE_URL="http://127.0.0.1:$HANDSHAKE_PORT"
check_health

if [[ "$STEP" == "import" || "$STEP" == "recovery" ]]; then
  run_import_step
fi

if [[ "$STEP" == "recovery" ]]; then
  run_recovery_step
fi

if ! SHUTDOWN_STATUS="$(
  "$CURL" -sS --connect-timeout 2 --max-time 5 \
    -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -X POST "$BASE_URL/v1/system/shutdown" 2>"$RUN_ROOT/shutdown.error"
)"; then
  fail "SHUTDOWN_REQUEST_FAILED: POST /v1/system/shutdown could not be completed."
fi
[[ "$SHUTDOWN_STATUS" == "202" ]] ||
  fail "SHUTDOWN_REQUEST_FAILED: POST /v1/system/shutdown returned HTTP $SHUTDOWN_STATUS."
wait_for_engine_exit
assert_no_token_output

if [[ "$STEP" != "recovery" ]]; then
  printf 'smoke-bundle: PASS launch (embedded Node, health ready, database ready, graceful shutdown, no Engine process survived)\n'
fi
if [[ "$STEP" == "import" ]]; then
  printf 'smoke-bundle: PASS import (Project identity listed; non-Git directory rejected)\n'
fi
if [[ "$STEP" == "recovery" ]]; then
  printf 'smoke-bundle: PASS recovery (unclean kill, same-root relaunch, Project retained, schema unchanged, second Engine refused)\n'
fi
