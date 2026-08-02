#!/usr/bin/env bash
set -euo pipefail

readonly ROUTER_SERVICE=codex-account-router.service
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly PRIMARY=/etc/credstore/codex-account-router.auth.primary
readonly SECONDARY=/etc/credstore/codex-account-router.auth.secondary
readonly EXPECTED_ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.6-linux-x64
readonly EXPECTED_WEB_CURRENT=/opt/0xcaff-codex-web-router/releases/c3e92f0f-20260802-m69-router-r92-server-bridge
readonly EXPECTED_STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

working_directory=
primary_replaced=0
success=0

unit_value() {
  systemctl show -p "$1" --value "$2"
}

unit_sha256() {
  systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1
}

must() {
  local label=$1
  shift
  "$@" || { printf 'e2e_error=%s\n' "$label" >&2; exit 1; }
}

capture_protected_state() {
  readonly WEB_PID_BEFORE="$(unit_value MainPID "$WEB_SERVICE")"
  readonly WEB_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$WEB_SERVICE")"
  readonly WEB_UNIT_BEFORE="$(unit_sha256 "$WEB_SERVICE")"
  readonly APP_PID_BEFORE="$(unit_value MainPID "$APP_SERVICE")"
  readonly APP_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")"
  readonly APP_UNIT_BEFORE="$(unit_sha256 "$APP_SERVICE")"
  readonly STANDALONE_WEB_PID_BEFORE="$(unit_value MainPID "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_WEB_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_WEB_UNIT_BEFORE="$(unit_sha256 "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_APP_PID_BEFORE="$(unit_value MainPID "$STANDALONE_APP_SERVICE")"
  readonly STANDALONE_APP_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")"
  readonly STANDALONE_APP_UNIT_BEFORE="$(unit_sha256 "$STANDALONE_APP_SERVICE")"
}

expect_protected_unchanged() {
  [[ "$(readlink -f /opt/0xcaff-codex-web-router/current)" == "$EXPECTED_WEB_CURRENT" ]]
  [[ "$(unit_value MainPID "$WEB_SERVICE")" == "$WEB_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$WEB_SERVICE")" == "$WEB_START_BEFORE" ]]
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_BEFORE" ]]
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$APP_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$APP_START_BEFORE" ]]
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_BEFORE" ]]
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$EXPECTED_STANDALONE_CURRENT" ]]
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]]
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_BEFORE" ]]
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]]
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_BEFORE" ]]
}

ready_with_account_count() {
  local minimum=$1
  curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:18318/readyz 2>/dev/null |
    MINIMUM="$minimum" node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      if (!value || value.status !== "ready" ||
          !Number.isSafeInteger(value.usable_accounts) ||
          value.usable_accounts < Number(process.env.MINIMUM)) process.exit(1);
    ' 2>/dev/null
}

wait_ready() {
  local minimum=$1
  for _attempt in $(seq 1 150); do
    if test "$(systemctl is-active "$ROUTER_SERVICE" 2>/dev/null || true)" = active &&
      ready_with_account_count "$minimum"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_browser_session() {
  : >"${working_directory}/cookies"
  curl --noproxy '*' -fsS --max-time 3 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: text/html' \
    -c "${working_directory}/cookies" \
    http://127.0.0.1:8216/ >/dev/null || return 1
  curl --noproxy '*' -fsS --max-time 3 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: application/json' \
    -b "${working_directory}/cookies" \
    -c "${working_directory}/cookies" \
    http://127.0.0.1:8216/__backend/session >"${working_directory}/session.json" || return 1
}

status_document() {
  local output=$1
  start_browser_session || return 1
  curl --noproxy '*' -fsS --max-time 6 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: application/json' \
    -b "${working_directory}/cookies" \
    -c "${working_directory}/cookies" \
    http://127.0.0.1:8216/__backend/codex-router/status >"$output" || return 1
}

assert_pre_status() {
  INPUT_STATUS=$1 node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_STATUS, "utf8"));
    const router = value?.router;
    if (!router || router.current_route?.account_alias !== "Primary" ||
        router.active_streams !== 0 || !Array.isArray(router.accounts) ||
        router.accounts.length !== 2) process.exit(1);
  '
}

assert_post_status() {
  INPUT_STATUS=$1 node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_STATUS, "utf8"));
    const router = value?.router;
    const primary = router?.accounts?.find((item) => item.alias === "Primary");
    const secondary = router?.accounts?.find((item) => item.alias === "Secondary");
    if (!router || router.current_route?.account_alias !== "Secondary" ||
        router.current_route?.continuity !== "new_backend_session" ||
        router.active_streams !== 0 || !primary || !secondary ||
        secondary.state !== "healthy") process.exit(1);
  '
}

ensure_primary_route() {
  local status_file=$1
  if INPUT_STATUS="$status_file" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_STATUS, "utf8"));
    process.exit(value?.router?.current_route?.account_alias === "Primary" ? 0 : 1);
  '; then
    return 0
  fi
  start_browser_session || return 1
  local csrf
  csrf=$(INPUT_SESSION="${working_directory}/session.json" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_SESSION, "utf8"));
    if (!value || typeof value.csrfToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) process.exit(1);
    process.stdout.write(value.csrfToken);
  ')
  curl --noproxy '*' -fsS --max-time 6 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H 'Origin: http://100.95.50.98:8216' \
    -H 'Sec-Fetch-Site: same-origin' \
    -H "x-codex-csrf: ${csrf}" \
    -b "${working_directory}/cookies" \
    -c "${working_directory}/cookies" \
    --data-binary '{"account_alias":"Primary","reason":"manual"}' \
    http://127.0.0.1:8216/__backend/codex-router/switch >"${working_directory}/switch.json" || return 1
  INPUT_SWITCH="${working_directory}/switch.json" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_SWITCH, "utf8"));
    if (!value || value.accepted !== true || value.account_alias !== "Primary" ||
        value.continuity !== "new_backend_session") process.exit(1);
  '
  : >"${working_directory}/session.json"
}

install_invalid_primary() {
  INPUT_PRIMARY="$PRIMARY" OUTPUT_PRIMARY="${working_directory}/invalid-primary" \
    node --input-type=module <<'NODE'
import fs from "node:fs";
const document = JSON.parse(fs.readFileSync(process.env.INPUT_PRIMARY, "utf8"));
const field = ["access", "token"].join("_");
if (!document?.tokens || typeof document.tokens[field] !== "string") process.exit(1);
document.tokens[field] = "m69-r92-intentionally-invalid";
fs.writeFileSync(process.env.OUTPUT_PRIMARY, `${JSON.stringify(document)}\n`, { mode: 0o600 });
NODE
  install -o root -g root -m 0600 "${working_directory}/invalid-primary" "${PRIMARY}.e2e.$$"
  mv -fT "${PRIMARY}.e2e.$$" "$PRIMARY"
  primary_replaced=1
}

restore_primary() {
  local staged="${PRIMARY}.restore.$$"
  install -o root -g root -m 0600 "${working_directory}/primary.auth" "$staged"
  mv -fT "$staged" "$PRIMARY"
  primary_replaced=0
  cmp -s "${working_directory}/primary.auth" "$PRIMARY"
}

perform_minimal_response() {
  cat >"${working_directory}/request.json" <<'JSON'
{"model":"gpt-5.6-sol","instructions":"Return exactly READY.","input":[{"role":"user","content":[{"type":"input_text","text":"Return exactly READY."}]}],"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false,"stream":true}
JSON
  curl --noproxy '*' -sS --max-time 120 \
    -D "${working_directory}/response.headers" \
    -o "${working_directory}/response.body" \
    -H 'Accept: text/event-stream' \
    -H 'Content-Type: application/json' \
    -H 'Originator: codex_cli_rs' \
    --data-binary "@${working_directory}/request.json" \
    http://127.0.0.1:18317/backend-api/codex/responses
  INPUT_HEADERS="${working_directory}/response.headers" \
    INPUT_BODY="${working_directory}/response.body" node -e '
    const fs = require("node:fs");
    const headers = fs.readFileSync(process.env.INPUT_HEADERS, "utf8");
    const body = fs.readFileSync(process.env.INPUT_BODY, "utf8");
    if (!/^HTTP\/1\.[01] 200\r?$/m.test(headers) ||
        !/^content-type:\s*text\/event-stream(?:;|\r?$)/im.test(headers) ||
        !/^event:\s*response\.completed\r?$/m.test(body) ||
        /^event:\s*error\r?$/m.test(body)) process.exit(1);
  '
  : >"${working_directory}/response.body"
  : >"${working_directory}/response.headers"
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ "$primary_replaced" -eq 1 ]]; then
    restore_primary >/dev/null 2>&1 || exit_code=1
  fi
  if [[ -n "$working_directory" ]]; then
    rm -rf -- "$working_directory"
  fi
  if declare -p WEB_PID_BEFORE >/dev/null 2>&1; then
    expect_protected_unchanged || exit_code=1
  fi
  if [[ "$success" -ne 1 ]]; then
    printf 'e2e_status=rolled_back\n'
  fi
  exit "$exit_code"
}
trap cleanup EXIT

printf 'e2e_status=preflight\n'
must root_required test "$EUID" -eq 0
must router_release_changed test "$(readlink -f /opt/codex-account-router/current)" = "$EXPECTED_ROUTER_CURRENT"
for unit in "$ROUTER_SERVICE" "$WEB_SERVICE" "$APP_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" test "$(systemctl is-active "$unit")" = active
  must "pending_reload_${unit}" test "$(unit_value NeedDaemonReload "$unit")" = no
done
capture_protected_state
must protected_service_changed expect_protected_unchanged
must two_accounts_not_ready ready_with_account_count 2
if ! working_directory=$(mktemp -d /run/m69-r92-real-e2e.XXXXXX); then
  printf 'e2e_error=working_directory_create_failed\n' >&2
  exit 1
fi
chmod 0700 "$working_directory"
must primary_backup_failed cp --preserve=mode,ownership,timestamps "$PRIMARY" "${working_directory}/primary.auth"
must distinct_credentials_required test ! "$PRIMARY" -ef "$SECONDARY"
must pre_status_failed status_document "${working_directory}/pre-status.json"
must primary_route_selection_failed ensure_primary_route "${working_directory}/pre-status.json"
must pre_status_failed status_document "${working_directory}/pre-status.json"
must pre_status_failed assert_pre_status "${working_directory}/pre-status.json"
must invalid_primary_install_failed install_invalid_primary
must protected_service_changed expect_protected_unchanged
must router_restart_failed systemctl restart "$ROUTER_SERVICE"
must router_not_ready wait_ready 1
must real_response_failed perform_minimal_response
must primary_restore_failed restore_primary
must protected_service_changed expect_protected_unchanged
must post_status_failed status_document "${working_directory}/post-status.json"
must post_status_failed assert_post_status "${working_directory}/post-status.json"
must primary_restore_changed cmp -s "${working_directory}/primary.auth" "$PRIMARY"

rm -rf -- "$working_directory"
working_directory=
success=1
trap - EXIT
printf 'e2e_status=success\n'
printf 'real_accounts_used=true\n'
printf 'initial_request_only=true\n'
printf 'primary_failed_before_semantic_output=true\n'
printf 'automatic_secondary_selection=true\n'
printf 'secondary_response_completed=true\n'
printf 'primary_credential_restored=true\n'
printf 'r92_web_app_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
