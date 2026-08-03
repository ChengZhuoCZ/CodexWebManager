#!/usr/bin/env bash
set -euo pipefail

readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly ROUTER_CURRENT="${ROUTER_QUALIFY_CURRENT:-/opt/codex-account-router/releases/codex-account-router-0.2.35-linux-x64}"
readonly WEB_CURRENT="${WEB_QUALIFY_CURRENT:-/opt/0xcaff-codex-web-router/releases/c3e92f0f-20260803-m69-router-r119-manager-framing}"
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3
readonly MANAGER_SOCKET_PATH=/run/codex-router-account-manager.sock
readonly APP_CREDENTIAL=/etc/codex-account-router/credentials/app-server-auth.json
readonly CONTROLLER=router-account-controller-041ab79a.js

success=0
snapshot_complete=0
switch_started=0
workdir=

sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_value() { systemctl show -p "$1" --value "$2"; }
effective_unit_sha256() { systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1; }
expect_active() { [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]; }
must() { local label=$1; shift; "$@" || { printf 'qualification_error=%s\n' "$label" >&2; exit 1; }; }

web_listening() {
  curl --noproxy '*' -fsS --max-time 2 -o /dev/null \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' http://127.0.0.1:8216/
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
    request.on("error",()=>process.exit(4));request.end();
  '
}

idle_on_route() {
  local expected=$1 route ready requests streams
  IFS='|' read -r route ready requests streams <<<"$(router_state)"
  [[ "$route" == "$expected" && "$ready" -eq 1 && "$requests" -eq 0 && "$streams" -eq 0 ]] || return 1
  [[ -z "$(ss -Hnt state established '( sport = :18317 or dport = :18317 )' 2>/dev/null)" ]]
}

verify_8215() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START" ]] || return 1
  [[ "$(effective_unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_EFFECTIVE" ]] || return 1
  [[ "$(effective_unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_EFFECTIVE" ]]
}

start_browser_session() {
  local slug=$1
  : >"$workdir/cookies-${slug}"
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies-${slug}" http://127.0.0.1:8216/ >"$workdir/index-${slug}.html" || return 1
  grep -Fq "./assets/${CONTROLLER}" "$workdir/index-${slug}.html" || return 1
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies-${slug}" -c "$workdir/cookies-${slug}" \
    http://127.0.0.1:8216/__backend/session >"$workdir/session-${slug}.json" || return 1
  INPUT_SESSION="$workdir/session-${slug}.json" /usr/bin/node -e '
    const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(process.env.INPUT_SESSION,"utf8"));
    if(typeof value?.csrfToken!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken))process.exit(1);
  '
}

browser_status() {
  local slug=$1 expected=$2
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies-${slug}" http://127.0.0.1:8216/__backend/codex-router/status | \
    EXPECTED_ROUTE="$expected" /usr/bin/node -e '
      const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(0,"utf8")),router=value?.router;
      if(!router||router.status!=="ready"||router.accounts?.length!==2||router.active_streams!==0||
        router.current_route?.account_alias!==process.env.EXPECTED_ROUTE||
        router.current_route?.continuity!=="new_backend_session")process.exit(1);
    '
}

wait_after_switch() {
  local expected=$1 old_web_pid=$2 old_app_pid=$3 ready=0
  for _attempt in $(seq 1 160); do
    if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && \
      [[ "$(unit_value MainPID "$WEB_SERVICE")" != "$old_web_pid" ]] && \
      [[ "$(unit_value MainPID "$APP_SERVICE")" != "$old_app_pid" ]] && idle_on_route "$expected" && \
      web_listening; then
      ready=1; break
    fi
    sleep 0.25
  done
  [[ "$ready" -eq 1 ]]
}

web_switch() {
  local from=$1 target=$2 slug=$3 csrf old_web_pid old_app_pid old_app_start
  must "not_idle_before_${slug}" idle_on_route "$from"
  must "session_failed_${slug}" start_browser_session "$slug"
  must "browser_status_before_${slug}" browser_status "$slug" "$from"
  csrf=$(INPUT_SESSION="$workdir/session-${slug}.json" /usr/bin/node -e '
    const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.env.INPUT_SESSION,"utf8")).csrfToken);
  ')
  old_web_pid=$(unit_value MainPID "$WEB_SERVICE")
  old_app_pid=$(unit_value MainPID "$APP_SERVICE")
  old_app_start=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
  printf '{"account_alias":"%s","reason":"manual"}' "$target" >"$workdir/request-${slug}.json"
  switch_started=1
  curl --noproxy '*' -fsS --max-time 35 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -H 'Origin: http://100.95.50.98:8216' -H 'Sec-Fetch-Site: same-origin' \
    -H "x-codex-csrf: ${csrf}" -b "$workdir/cookies-${slug}" \
    --data-binary "@$workdir/request-${slug}.json" \
    http://127.0.0.1:8216/__backend/codex-router/switch >"$workdir/switch-${slug}.json"
  INPUT_SWITCH="$workdir/switch-${slug}.json" EXPECTED_ALIAS="$target" /usr/bin/node -e '
    const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(process.env.INPUT_SWITCH,"utf8"));
    if(value?.enabled!==true||value.accepted!==true||value.account_alias!==process.env.EXPECTED_ALIAS||
      value.continuity!=="new_backend_session"||value.architecture_mode!=="LIMITED_MODE"||
      value.native_identity_rebound!==true||value.web_restart_required!==true)process.exit(1);
  '
  must "services_not_ready_${slug}" wait_after_switch "$target" "$old_web_pid" "$old_app_pid"
  must "app_start_unchanged_${slug}" test "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" != "$old_app_start"
  must "new_session_failed_${slug}" start_browser_session "${slug}-after"
  must "browser_status_after_${slug}" browser_status "${slug}-after" "$target"
  must "standalone_changed_${slug}" verify_8215
}

manager_restore() {
  local alias=$1
  EXPECTED_ALIAS="$alias" /usr/bin/node -e '
    const net=require("node:net"),alias=process.env.EXPECTED_ALIAS,socket=net.createConnection("/run/codex-router-account-manager.sock");
    const chunks=[];let done=false;const timer=setTimeout(()=>socket.destroy(new Error("timeout")),120000);
    socket.once("connect",()=>socket.write(`${JSON.stringify({operation:"switch",alias})}\n`));
    socket.on("data",chunk=>chunks.push(chunk));socket.once("error",()=>{clearTimeout(timer);process.exit(2)});
    socket.once("end",()=>{clearTimeout(timer);try{const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(value?.ok!==true||value.account_alias!==alias||value.native_identity_rebound!==true)process.exit(3);
    }catch{process.exit(4)}});
  '
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$snapshot_complete" -eq 1 ]]; then
    local current=""
    current=$(router_state 2>/dev/null | cut -d '|' -f 1 || true)
    if [[ "$current" != "$ORIGINAL_ROUTE" && "$switch_started" -eq 1 ]]; then
      manager_restore "$ORIGINAL_ROUTE" >/dev/null 2>&1 || true
      systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$(sha256 "$APP_CREDENTIAL" 2>/dev/null || true)" != "$APP_CREDENTIAL_SHA256" ]]; then
      systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
      install -o root -g root -m 0600 "$workdir/app-server-auth.before" "${APP_CREDENTIAL}.r119-test-rollback.$$" || true
      mv -f "${APP_CREDENTIAL}.r119-test-rollback.$$" "$APP_CREDENTIAL" 2>/dev/null || true
      systemctl start "$APP_SERVICE" >/dev/null 2>&1 || true
    fi
    printf 'qualification_status=rolled_back\n'
    verify_8215 || code=1
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  exit "$code"
}
trap rollback EXIT

printf 'qualification_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r119-roundtrip.XXXXXX)
for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$WEB_SERVICE" "$APP_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must router_release_wrong test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must web_release_wrong test "$(readlink -f /opt/0xcaff-codex-web-router/current)" = "$WEB_CURRENT"

STANDALONE_WEB_PID=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
STANDALONE_WEB_EFFECTIVE=$(effective_unit_sha256 "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_EFFECTIVE=$(effective_unit_sha256 "$STANDALONE_APP_SERVICE")
APP_EFFECTIVE=$(effective_unit_sha256 "$APP_SERVICE")
APP_CREDENTIAL_SHA256=$(sha256 "$APP_CREDENTIAL")
cp -p "$APP_CREDENTIAL" "$workdir/app-server-auth.before"
IFS='|' read -r ORIGINAL_ROUTE READY REQUESTS STREAMS <<<"$(router_state)"
must router_not_ready test "$READY" -eq 1
must active_request_present test "$REQUESTS" -eq 0
must active_stream_present test "$STREAMS" -eq 0
if [[ "$ORIGINAL_ROUTE" == Primary ]]; then TARGET_ROUTE=Secondary; else TARGET_ROUTE=Primary; fi
must initial_idle idle_on_route "$ORIGINAL_ROUTE"
must initial_8215 verify_8215
snapshot_complete=1

web_switch "$ORIGINAL_ROUTE" "$TARGET_ROUTE" outward
must credential_did_not_change test "$(sha256 "$APP_CREDENTIAL")" != "$APP_CREDENTIAL_SHA256"
web_switch "$TARGET_ROUTE" "$ORIGINAL_ROUTE" return
must credential_not_restored test "$(sha256 "$APP_CREDENTIAL")" = "$APP_CREDENTIAL_SHA256"
must final_idle idle_on_route "$ORIGINAL_ROUTE"
must app_unit_changed test "$(effective_unit_sha256 "$APP_SERVICE")" = "$APP_EFFECTIVE"
must final_8215 verify_8215

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'qualification_status=success\n'
printf 'manual_switch_roundtrip=true\n'
printf 'original_route_restored=true\n'
printf 'native_identity_rebound_each_direction=true\n'
printf 'new_web_session_each_direction=true\n'
printf 'active_requests_before_each_switch=0\n'
printf 'active_streams_before_each_switch=0\n'
printf 'routed_8216_app_server_restarted_by_helper=true\n'
printf 'standalone_8215_unchanged=true\n'
printf 'model_request_sent=false\n'
printf 'semantic_output_replay_attempted=false\n'
printf 'continuity=new_backend_session\n'
