#!/usr/bin/env bash
set -euo pipefail

readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly PRIMARY=/etc/credstore/codex-account-router.auth.primary
readonly SECONDARY=/etc/credstore/codex-account-router.auth.secondary
readonly APP_CREDENTIAL=/etc/codex-account-router/credentials/app-server-auth.json
readonly CIRCUIT_STATE=/var/lib/codex-account-router/circuit-state.json
readonly ROUTING_STATE=/var/lib/codex-account-router/routing-state.json
readonly EXPECTED_ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.37-linux-x64
readonly EXPECTED_WEB_CURRENT=/opt/0xcaff-codex-web-router/releases/c3e92f0f-20260803-m69-router-r123-current-quota-identity
readonly EXPECTED_STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

workdir=
snapshot_complete=0
primary_replaced=0
success=0

unit_value() { systemctl show -p "$1" --value "$2"; }
unit_sha256() { systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1; }
file_sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
expect_active() { [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]; }
must() { local label=$1; shift; "$@" || { printf 'e2e_error=%s\n' "$label" >&2; exit 1; }; }

ready_with_account_count() {
  local minimum=$1
  curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:18318/readyz 2>/dev/null |
    MINIMUM="$minimum" /usr/bin/node -e '
      const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(0,"utf8"));
      if(value?.status!=="ready"||!Number.isSafeInteger(value.usable_accounts)||
        value.usable_accounts<Number(process.env.MINIMUM))process.exit(1);
    ' 2>/dev/null
}

router_state() {
  /usr/bin/node -e '
    const fs=require("node:fs"),http=require("node:http");
    const token=fs.readFileSync("/etc/codex-account-router/credentials/admin-token","utf8").trim();
    const request=http.request({host:"127.0.0.1",port:18318,path:"/v1/status",method:"GET",
      headers:{authorization:`Bearer ${token}`,accept:"application/json"},timeout:3000},response=>{
      const chunks=[]; response.on("data",chunk=>chunks.push(chunk)); response.on("end",()=>{
        if(response.statusCode!==200)process.exit(2);
        const status=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const alias=status.current_route?.account_alias;
        if(typeof alias!=="string"||!/^(Primary|Secondary)$/u.test(alias))process.exit(3);
        const ready=status.status==="ready"?1:0;
        const requests=Number.isInteger(status.active_requests)?status.active_requests:-1;
        const streams=Number.isInteger(status.active_streams)?status.active_streams:-1;
        process.stdout.write(`${alias}|${ready}|${requests}|${streams}\n`);
      });
    });
    request.on("timeout",()=>request.destroy(new Error("timeout")));
    request.on("error",()=>process.exit(4)); request.end();
  '
}

idle_on_route() {
  local expected=$1 route ready requests streams
  IFS='|' read -r route ready requests streams <<<"$(router_state)"
  [[ "$route" == "$expected" && "$ready" -eq 1 && "$requests" -eq 0 && "$streams" -eq 0 ]] || return 1
  [[ -z "$(ss -Hnt state established '( sport = :18317 or dport = :18317 )' 2>/dev/null)" ]]
}

quiescent_on_route() {
  local expected=$1 route ready requests streams
  IFS='|' read -r route ready requests streams <<<"$(router_state)"
  [[ "$route" == "$expected" && "$ready" -eq 1 && "$requests" -eq 0 && "$streams" -eq 0 ]]
}

wait_ready() {
  local minimum=$1
  for _attempt in $(seq 1 200); do
    if expect_active "$ROUTER_SERVICE" && ready_with_account_count "$minimum"; then return 0; fi
    sleep 0.25
  done
  return 1
}

wait_route() {
  local alias=$1
  for _attempt in $(seq 1 240); do
    if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" &&
      quiescent_on_route "$alias"; then return 0; fi
    sleep 0.25
  done
  return 1
}

wait_secondary_native_identity() {
  for _attempt in $(seq 1 240); do
    if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" &&
      quiescent_on_route Secondary &&
      [[ "$(file_sha256 "$APP_CREDENTIAL")" == "$APP_CREDENTIAL_SHA256" ]] &&
      web_listening; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

web_listening() {
  curl --noproxy '*' -fsS --max-time 3 -o /dev/null \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' http://127.0.0.1:8216/
}

start_browser_session() {
  local slug=$1
  : >"$workdir/cookies-${slug}"
  curl --noproxy '*' -fsS --max-time 5 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies-${slug}" http://127.0.0.1:8216/ >/dev/null || return 1
  curl --noproxy '*' -fsS --max-time 5 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies-${slug}" -c "$workdir/cookies-${slug}" \
    http://127.0.0.1:8216/__backend/session >"$workdir/session-${slug}.json" || return 1
  INPUT_SESSION="$workdir/session-${slug}.json" /usr/bin/node -e '
    const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(process.env.INPUT_SESSION,"utf8"));
    if(typeof value?.csrfToken!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken))process.exit(1);
  '
}

browser_status() {
  local slug=$1 expected=$2
  start_browser_session "$slug" || return 1
  curl --noproxy '*' -fsS --max-time 6 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies-${slug}" \
    http://127.0.0.1:8216/__backend/codex-router/status |
    EXPECTED_ROUTE="$expected" /usr/bin/node -e '
      const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(0,"utf8")),router=value?.router;
      if(!router||router.status!=="ready"||router.accounts?.length!==2||
        router.active_requests!==0||router.active_streams!==0||
        router.current_route?.account_alias!==process.env.EXPECTED_ROUTE||
        router.current_route?.continuity!=="new_backend_session")process.exit(1);
    '
}

web_switch_to_primary() {
  local csrf old_web_pid old_app_pid
  must not_idle_before_primary idle_on_route Secondary
  must switch_session_failed start_browser_session switch-primary
  csrf=$(INPUT_SESSION="$workdir/session-switch-primary.json" /usr/bin/node -e '
    const fs=require("node:fs");
    process.stdout.write(JSON.parse(fs.readFileSync(process.env.INPUT_SESSION,"utf8")).csrfToken);
  ')
  old_web_pid=$(unit_value MainPID "$WEB_SERVICE")
  old_app_pid=$(unit_value MainPID "$APP_SERVICE")
  printf '%s\n' '{"account_alias":"Primary","reason":"manual"}' >"$workdir/switch-request.json"
  curl --noproxy '*' -fsS --max-time 40 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -H 'Content-Type: application/json' -H 'Origin: http://100.95.50.98:8216' \
    -H 'Sec-Fetch-Site: same-origin' -H "x-codex-csrf: ${csrf}" \
    -b "$workdir/cookies-switch-primary" --data-binary "@$workdir/switch-request.json" \
    http://127.0.0.1:8216/__backend/codex-router/switch >"$workdir/switch-response.json"
  INPUT_SWITCH="$workdir/switch-response.json" /usr/bin/node -e '
    const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(process.env.INPUT_SWITCH,"utf8"));
    if(value?.enabled!==true||value.accepted!==true||value.account_alias!=="Primary"||
      value.continuity!=="new_backend_session"||value.native_identity_rebound!==true||
      value.web_restart_required!==true)process.exit(1);
  '
  for _attempt in $(seq 1 240); do
    if [[ "$(unit_value MainPID "$WEB_SERVICE")" != "$old_web_pid" &&
      "$(unit_value MainPID "$APP_SERVICE")" != "$old_app_pid" ]] &&
      wait_route Primary && web_listening; then return 0; fi
    sleep 0.25
  done
  return 1
}

install_invalid_primary() {
  INPUT_PRIMARY="$PRIMARY" OUTPUT_PRIMARY="$workdir/invalid-primary" /usr/bin/node --input-type=module <<'NODE'
import fs from "node:fs";
const document=JSON.parse(fs.readFileSync(process.env.INPUT_PRIMARY,"utf8"));
const field=["access","token"].join("_");
if(!document?.tokens||typeof document.tokens[field]!=="string")process.exit(1);
document.tokens[field]="m69-r124-intentionally-invalid";
fs.writeFileSync(process.env.OUTPUT_PRIMARY,`${JSON.stringify(document)}\n`,{mode:0o600});
NODE
  install -o root -g root -m 0600 "$workdir/invalid-primary" "${PRIMARY}.r124.$$"
  mv -fT "${PRIMARY}.r124.$$" "$PRIMARY"
  primary_replaced=1
}

restore_primary() {
  local staged="${PRIMARY}.r124-restore.$$"
  install -o root -g root -m 0600 "$workdir/primary.before" "$staged"
  mv -fT "$staged" "$PRIMARY"
  primary_replaced=0
  cmp -s "$workdir/primary.before" "$PRIMARY"
}

perform_minimal_response() {
  printf '%s\n' '{"model":"gpt-5.6-sol","instructions":"Return exactly READY.","input":[{"role":"user","content":[{"type":"input_text","text":"Return exactly READY."}]}],"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false,"stream":true}' >"$workdir/request.json"
  curl --noproxy '*' -sS --max-time 120 \
    -D "$workdir/response.headers" -o "$workdir/response.body" \
    -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
    -H 'Originator: codex_cli_rs' --data-binary "@$workdir/request.json" \
    http://127.0.0.1:18317/backend-api/codex/responses
  INPUT_HEADERS="$workdir/response.headers" INPUT_BODY="$workdir/response.body" /usr/bin/node -e '
    const fs=require("node:fs"),headers=fs.readFileSync(process.env.INPUT_HEADERS,"utf8"),
      body=fs.readFileSync(process.env.INPUT_BODY,"utf8");
    if(!/^HTTP\/1\.[01] 200\r?$/mu.test(headers)||
      !/^content-type:\s*text\/event-stream(?:;|\r?$)/imu.test(headers)||
      !/^event:\s*response\.completed\r?$/mu.test(body)||/^event:\s*error\r?$/mu.test(body))process.exit(1);
  '
  : >"$workdir/response.body"
  : >"$workdir/response.headers"
}

restore_router_state() {
  systemctl stop "$ROUTER_SERVICE"
  cp --preserve=mode,ownership,timestamps \
    "$workdir/circuit-state.before" "${CIRCUIT_STATE}.r124.$$"
  mv -fT "${CIRCUIT_STATE}.r124.$$" "$CIRCUIT_STATE"
  cp --preserve=mode,ownership,timestamps \
    "$workdir/routing-state.before" "${ROUTING_STATE}.r124.$$"
  mv -fT "${ROUTING_STATE}.r124.$$" "$ROUTING_STATE"
  systemctl start "$ROUTER_SERVICE"
}

verify_8215() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$EXPECTED_STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT" ]]
}

verify_8216_units() {
  [[ "$(readlink -f /opt/codex-account-router/current)" == "$EXPECTED_ROUTER_CURRENT" ]] || return 1
  [[ "$(readlink -f /opt/0xcaff-codex-web-router/current)" == "$EXPECTED_WEB_CURRENT" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_UNIT" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT" ]] || return 1
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT" ]]
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$snapshot_complete" -eq 1 ]]; then
    [[ "$primary_replaced" -eq 0 ]] || restore_primary >/dev/null 2>&1 || code=1
    systemctl stop "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    cp --preserve=mode,ownership,timestamps "$workdir/circuit-state.before" "${CIRCUIT_STATE}.r124-rollback.$$" >/dev/null 2>&1 || true
    mv -fT "${CIRCUIT_STATE}.r124-rollback.$$" "$CIRCUIT_STATE" >/dev/null 2>&1 || true
    cp --preserve=mode,ownership,timestamps "$workdir/routing-state.before" "${ROUTING_STATE}.r124-rollback.$$" >/dev/null 2>&1 || true
    mv -fT "${ROUTING_STATE}.r124-rollback.$$" "$ROUTING_STATE" >/dev/null 2>&1 || true
    systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
    install -o root -g root -m 0600 "$workdir/app-server-auth.before" "${APP_CREDENTIAL}.r124-rollback.$$" >/dev/null 2>&1 || true
    mv -fT "${APP_CREDENTIAL}.r124-rollback.$$" "$APP_CREDENTIAL" >/dev/null 2>&1 || true
    systemctl start "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    systemctl start "$APP_SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    printf 'e2e_status=rolled_back\n'
    verify_8215 || code=1
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  exit "$code"
}
trap rollback EXIT

printf 'e2e_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /run/m69-r124-real-e2e.XXXXXX)
for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$WEB_SERVICE" "$APP_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
  must "pending_reload_${unit}" test "$(unit_value NeedDaemonReload "$unit")" = no
done
must router_release_changed test "$(readlink -f /opt/codex-account-router/current)" = "$EXPECTED_ROUTER_CURRENT"
must web_release_changed test "$(readlink -f /opt/0xcaff-codex-web-router/current)" = "$EXPECTED_WEB_CURRENT"
must state_file_missing test -f "$CIRCUIT_STATE"
must route_file_missing test -f "$ROUTING_STATE"
must distinct_credentials_required test ! "$PRIMARY" -ef "$SECONDARY"

STANDALONE_WEB_PID=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_UNIT=$(unit_sha256 "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
STANDALONE_APP_UNIT=$(unit_sha256 "$STANDALONE_APP_SERVICE")
ROUTER_UNIT=$(unit_sha256 "$ROUTER_SERVICE")
MANAGER_UNIT=$(unit_sha256 "$MANAGER_SERVICE")
MANAGER_SOCKET_UNIT=$(unit_sha256 "$MANAGER_SOCKET")
WEB_UNIT=$(unit_sha256 "$WEB_SERVICE")
APP_UNIT=$(unit_sha256 "$APP_SERVICE")

must primary_backup_failed cp --preserve=mode,ownership,timestamps "$PRIMARY" "$workdir/primary.before"
must app_backup_failed cp --preserve=mode,ownership,timestamps "$APP_CREDENTIAL" "$workdir/app-server-auth.before"
must circuit_backup_failed cp --preserve=mode,ownership,timestamps "$CIRCUIT_STATE" "$workdir/circuit-state.before"
must routing_backup_failed cp --preserve=mode,ownership,timestamps "$ROUTING_STATE" "$workdir/routing-state.before"
APP_CREDENTIAL_SHA256=$(file_sha256 "$APP_CREDENTIAL")
snapshot_complete=1

must standalone_changed_initially verify_8215
must units_changed_initially verify_8216_units
must original_route_not_secondary idle_on_route Secondary
must two_accounts_not_ready ready_with_account_count 2
must pre_browser_status_failed browser_status pre Secondary

must primary_route_selection_failed web_switch_to_primary
must primary_native_identity_not_rebound test "$(file_sha256 "$APP_CREDENTIAL")" != "$APP_CREDENTIAL_SHA256"
must primary_browser_status_failed browser_status primary Primary
must standalone_changed_after_manual_switch verify_8215

must invalid_primary_install_failed install_invalid_primary
must router_restart_failed systemctl restart "$ROUTER_SERVICE"
must router_not_ready_for_failover wait_ready 1
must real_response_failed perform_minimal_response
must primary_restore_failed restore_primary
must automatic_secondary_route_failed wait_route Secondary
must secondary_native_identity_not_rebound wait_secondary_native_identity
must post_browser_status_failed browser_status post Secondary
must standalone_changed_after_auto_switch verify_8215

must router_not_quiescent_before_state_restore quiescent_on_route Secondary
must state_restore_failed restore_router_state
must router_not_fully_restored wait_ready 2
must restored_route_failed wait_route Secondary
must final_browser_status_failed browser_status final Secondary
must primary_credential_changed cmp -s "$workdir/primary.before" "$PRIMARY"
must app_identity_not_restored cmp -s "$workdir/app-server-auth.before" "$APP_CREDENTIAL"
must units_changed_finally verify_8216_units
must standalone_changed_finally verify_8215

success=1
trap - EXIT
rm -rf -- "$workdir"
workdir=
printf 'e2e_status=success\n'
printf 'real_accounts_used=true\n'
printf 'new_initial_request_only=true\n'
printf 'primary_failed_before_semantic_output=true\n'
printf 'automatic_secondary_selection=true\n'
printf 'secondary_response_completed=true\n'
printf 'primary_credential_restored=true\n'
printf 'router_state_restored=true\n'
printf 'native_identity_restored=Secondary\n'
printf 'semantic_output_replay_attempted=false\n'
printf 'continuity=new_backend_session\n'
printf 'standalone_8215_unchanged=true\n'
