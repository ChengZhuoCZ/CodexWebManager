#!/usr/bin/env bash
set -euo pipefail

readonly INPUT_ROOT="${R119_INPUT_ROOT:-/tmp/codex-r119-deploy-inputs}"
readonly ROUTER_ARCHIVE="${INPUT_ROOT}/codex-account-router-0.2.35-linux-x64.tar.gz"
readonly ROUTER_ARCHIVE_SHA256=3a7c9a4e7842aa9eca6b171d06d8f3cf5e33f2eacfeb45faa33281b7bad5adb1
readonly TRANSFORMER="${INPUT_ROOT}/replace-r119-manager-framing.mjs"
readonly TRANSFORMER_SHA256=18f3b4ded54c614061911c34c165e09559d3a165bff2bf6776bfc632acad5be6
readonly STATUS_BRIDGE="${INPUT_ROOT}/router-status-bridge-standalone.js"
readonly STATUS_BRIDGE_SHA256=ea4fdbf76505c7d8dc330fcbd415ccb8ac59c27493b62e171f5a7905952e9bdd
readonly ACCOUNT_MANAGEMENT="${INPUT_ROOT}/router-account-management-standalone.js"
readonly ACCOUNT_MANAGEMENT_SHA256=d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9

readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_OLD="${ROUTER_ROOT}/releases/codex-account-router-0.2.34-linux-x64"
readonly ROUTER_NEW="${ROUTER_ROOT}/releases/codex-account-router-0.2.35-linux-x64"
readonly ROUTER_ARCHIVE_ROOT=codex-account-router-0.2.35-linux-x64
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_OLD="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r118-native-identity-sync"
readonly WEB_NEW="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r119-manager-framing"
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly MANAGER_UNIT=/etc/systemd/system/codex-router-account-manager.service
readonly WEB_UNIT=/etc/systemd/system/codex-web-router.service
readonly APP_UNIT=/etc/systemd/system/codex-web-router-app-server.service
readonly MANAGER_SOCKET_UNIT=/etc/systemd/system/codex-router-account-manager.socket
readonly APP_CREDENTIAL=/etc/codex-account-router/credentials/app-server-auth.json

readonly MANAGER_UNIT_SHA256=15c1f8bdc57df11b74ed3b90eb52d422e3960017dd41eccf8dd0c99102d41259
readonly WEB_UNIT_SHA256=32df27d024a2f24800e82981768ded9153e8c4dcc3f544406f6e503550c8b95d
readonly APP_UNIT_SHA256=983b71a39bec32bdb1c9c74f0cd203f4c70e4f08ca4c8549df87fe8e29b141ad
readonly MANAGER_SOCKET_UNIT_SHA256=29aecb37ec655eb4c3499f400f48bc80944ccfd02ef317cf4832e449046fd53e
readonly CONTROLLER=router-account-controller-041ab79a.js
readonly CONTROLLER_SHA256=041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429
readonly INDEX=scratch/asar/webview/index.html
readonly INDEX_SHA256=f51092f7915326b14a55cb0fdfaac018ef78aad54939d9384c5287486e17855e
readonly ASSETS=scratch/asar/webview/assets

success=0
mutation_started=0
router_created=0
web_created=0
router_switched=0
web_switched=0
workdir=

sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_value() { systemctl show -p "$1" --value "$2"; }
effective_unit_sha256() { systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1; }
expect_active() { [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]; }
must() { local label=$1; shift; "$@" || { printf 'deployment_error=%s\n' "$label" >&2; exit 1; }; }
replace_link() {
  if mv --help 2>&1 | grep -q -- '-T'; then mv -Tf "$1" "$2"; else mv -hf "$1" "$2"; fi
}

router_state() {
  /usr/bin/node -e '
    const fs=require("node:fs"), http=require("node:http");
    const token=fs.readFileSync("/etc/codex-account-router/credentials/admin-token","utf8").trim();
    const request=http.request({host:"127.0.0.1",port:18318,path:"/v1/status",method:"GET",
      headers:{authorization:`Bearer ${token}`,accept:"application/json"},timeout:3000},response=>{
      const chunks=[]; response.on("data",chunk=>chunks.push(chunk)); response.on("end",()=>{
        if(response.statusCode!==200)process.exit(2);
        const status=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const alias=status.current_route?.account_alias;
        if(typeof alias!=="string"||!/^[A-Za-z0-9._-]{1,64}$/u.test(alias))process.exit(3);
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

verify_no_pending_reload() {
  local unit
  for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$WEB_SERVICE" "$APP_SERVICE" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
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

verify_web_release() {
  local root=$1
  [[ "$(sha256 "${root}/${INDEX}")" == "$INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${CONTROLLER}")" == "$CONTROLLER_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$STATUS_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-account-management.js")" == "$ACCOUNT_MANAGEMENT_SHA256" ]] || return 1
  [[ "$(stat -c %a "${root}/src/server/router-status-bridge.js")" == 644 ]] || return 1
  [[ "$(stat -c %a "${root}/src/server/router-account-management.js")" == 644 ]] || return 1
  [[ "$(grep -Foc "./assets/${CONTROLLER}" "${root}/${INDEX}")" == 1 ]] || return 1
  /usr/bin/node -e '
    const fs=require("node:fs"),z=require("node:zlib");
    for(const p of process.argv.slice(1)){const raw=fs.readFileSync(p);
      if(!raw.equals(z.gunzipSync(fs.readFileSync(`${p}.gz`))))process.exit(1);
      if(!raw.equals(z.brotliDecompressSync(fs.readFileSync(`${p}.br`))))process.exit(1);}
  ' "${root}/${INDEX}" "${root}/${ASSETS}/${CONTROLLER}"
}

browser_ready() {
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >"$workdir/index.html" || return 1
  grep -Fq "./assets/${CONTROLLER}" "$workdir/index.html" || return 1
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status | /usr/bin/node -e '
      const fs=require("node:fs"),value=JSON.parse(fs.readFileSync(0,"utf8")),router=value?.router;
      if(!router||router.status!=="ready"||router.accounts?.length<2||router.active_streams!==0||
        router.current_route?.continuity!=="new_backend_session")process.exit(1);
    '
}

restore_credential_if_changed() {
  if [[ -n "$workdir" && -f "$workdir/app-server-auth.before" && \
    "$(sha256 "$APP_CREDENTIAL" 2>/dev/null || true)" != "$APP_CREDENTIAL_SHA256" ]]; then
    systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
    install -o root -g root -m 0600 "$workdir/app-server-auth.before" "${APP_CREDENTIAL}.r119-rollback.$$" || true
    mv -f "${APP_CREDENTIAL}.r119-rollback.$$" "$APP_CREDENTIAL" 2>/dev/null || true
    systemctl start "$APP_SERVICE" >/dev/null 2>&1 || true
  fi
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$mutation_started" -eq 1 ]]; then
    if [[ "$router_switched" -eq 1 ]]; then
      ln -s "$ROUTER_OLD" "${ROUTER_ROOT}/.current-r119-rollback.$$" && \
        replace_link "${ROUTER_ROOT}/.current-r119-rollback.$$" "$ROUTER_CURRENT" || true
    fi
    if [[ "$web_switched" -eq 1 ]]; then
      ln -s "$WEB_OLD" "${WEB_ROOT}/.current-r119-rollback.$$" && \
        replace_link "${WEB_ROOT}/.current-r119-rollback.$$" "$WEB_CURRENT" || true
    fi
    systemctl restart "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$MANAGER_SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    restore_credential_if_changed
    [[ "$web_created" -eq 0 ]] || rm -rf -- "$WEB_NEW"
    [[ "$router_created" -eq 0 ]] || rm -rf -- "$ROUTER_NEW"
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r119-deploy.XXXXXX)
for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$WEB_SERVICE" "$APP_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must pending_daemon_reload verify_no_pending_reload
must unexpected_router_current test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_OLD"
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$WEB_OLD"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must manager_unit_changed test "$(sha256 "$MANAGER_UNIT")" = "$MANAGER_UNIT_SHA256"
must web_unit_changed test "$(sha256 "$WEB_UNIT")" = "$WEB_UNIT_SHA256"
must app_unit_changed test "$(sha256 "$APP_UNIT")" = "$APP_UNIT_SHA256"
must manager_socket_changed test "$(sha256 "$MANAGER_SOCKET_UNIT")" = "$MANAGER_SOCKET_UNIT_SHA256"
must router_archive_changed test "$(sha256 "$ROUTER_ARCHIVE")" = "$ROUTER_ARCHIVE_SHA256"
must transformer_changed test "$(sha256 "$TRANSFORMER")" = "$TRANSFORMER_SHA256"
must status_bridge_changed test "$(sha256 "$STATUS_BRIDGE")" = "$STATUS_BRIDGE_SHA256"
must account_management_changed test "$(sha256 "$ACCOUNT_MANAGEMENT")" = "$ACCOUNT_MANAGEMENT_SHA256"
must router_successor_exists test ! -e "$ROUTER_NEW"
must web_successor_exists test ! -e "$WEB_NEW"

STANDALONE_WEB_PID=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
STANDALONE_WEB_EFFECTIVE=$(effective_unit_sha256 "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_EFFECTIVE=$(effective_unit_sha256 "$STANDALONE_APP_SERVICE")
APP_PID=$(unit_value MainPID "$APP_SERVICE")
APP_START=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
APP_EFFECTIVE=$(effective_unit_sha256 "$APP_SERVICE")
APP_CREDENTIAL_SHA256=$(sha256 "$APP_CREDENTIAL")
ROUTER_PID=$(unit_value MainPID "$ROUTER_SERVICE")
MANAGER_PID=$(unit_value MainPID "$MANAGER_SERVICE")
WEB_PID=$(unit_value MainPID "$WEB_SERVICE")
IFS='|' read -r ROUTE_BEFORE READY_BEFORE REQUESTS_BEFORE STREAMS_BEFORE <<<"$(router_state)"
must router_not_ready test "$READY_BEFORE" -eq 1
must active_request_present test "$REQUESTS_BEFORE" -eq 0
must active_stream_present test "$STREAMS_BEFORE" -eq 0
must active_router_connections test -z "$(ss -Hnt state established '( sport = :18317 or dport = :18317 )' 2>/dev/null)"
must standalone_changed verify_8215

cp -p "$APP_CREDENTIAL" "$workdir/app-server-auth.before"
mkdir "$workdir/router"
tar -xzf "$ROUTER_ARCHIVE" --no-same-owner -C "$workdir/router"
must extracted_router_manifest test -f "$workdir/router/${ROUTER_ARCHIVE_ROOT}/manifest.json"
must extracted_router_version /usr/bin/node -e '
  const fs=require("node:fs"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(m?.version!=="0.2.35"||m?.target?.os!=="linux"||m?.target?.architecture!=="x64")process.exit(1);
' "$workdir/router/${ROUTER_ARCHIVE_ROOT}/manifest.json"
must extracted_router_symlink test -z "$(find "$workdir/router/${ROUTER_ARCHIVE_ROOT}" -type l -print -quit)"

must web_successor_create mkdir "$WEB_NEW"
web_created=1
must web_successor_copy cp -a --reflink=auto "$WEB_OLD/." "$WEB_NEW/"
must web_successor_symlinks test -z "$(find "$WEB_NEW" -type l -print -quit)"
must web_transform /usr/bin/node "$TRANSFORMER" --candidate "$WEB_NEW" \
  --status-bridge "$STATUS_BRIDGE" --account-management "$ACCOUNT_MANAGEMENT"
must web_successor_verify verify_web_release "$WEB_NEW"
must standalone_changed_before_mutation verify_8215

mutation_started=1
router_staging="${ROUTER_ROOT}/releases/.codex-account-router-0.2.35-linux-x64.r119.$$"
must router_staging_create mkdir "$router_staging"
must router_release_copy cp -a "$workdir/router/${ROUTER_ARCHIVE_ROOT}/." "$router_staging/"
must router_release_activate mv "$router_staging" "$ROUTER_NEW"
router_created=1
must router_link_stage ln -s "releases/codex-account-router-0.2.35-linux-x64" "${ROUTER_ROOT}/.current-r119.$$"
must router_link_switch replace_link "${ROUTER_ROOT}/.current-r119.$$" "$ROUTER_CURRENT"
router_switched=1
must web_link_stage ln -s "$WEB_NEW" "${WEB_ROOT}/.current-r119.$$"
must web_link_switch replace_link "${WEB_ROOT}/.current-r119.$$" "$WEB_CURRENT"
web_switched=1

must router_restart systemctl restart "$ROUTER_SERVICE"
must manager_restart systemctl restart "$MANAGER_SERVICE"
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 120); do
  if expect_active "$ROUTER_SERVICE" && expect_active "$MANAGER_SERVICE" && expect_active "$MANAGER_SOCKET" && \
    expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && browser_ready; then ready=1; break; fi
  sleep 0.25
done
must readiness_failed test "$ready" -eq 1

IFS='|' read -r ROUTE_AFTER READY_AFTER REQUESTS_AFTER STREAMS_AFTER <<<"$(router_state)"
must router_not_ready_after test "$READY_AFTER" -eq 1
must active_request_after test "$REQUESTS_AFTER" -eq 0
must active_stream_after test "$STREAMS_AFTER" -eq 0
must route_changed test "$ROUTE_AFTER" = "$ROUTE_BEFORE"
must app_credential_changed test "$(sha256 "$APP_CREDENTIAL")" = "$APP_CREDENTIAL_SHA256"
must app_server_pid_changed test "$(unit_value MainPID "$APP_SERVICE")" = "$APP_PID"
must app_server_start_changed test "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" = "$APP_START"
must app_server_unit_changed test "$(effective_unit_sha256 "$APP_SERVICE")" = "$APP_EFFECTIVE"
must router_not_restarted test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID"
must manager_not_restarted test "$(unit_value MainPID "$MANAGER_SERVICE")" != "$MANAGER_PID"
must web_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID"
must router_current_wrong test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_NEW"
must web_current_wrong test "$(readlink -f "$WEB_CURRENT")" = "$WEB_NEW"
must manager_unit_changed_after test "$(sha256 "$MANAGER_UNIT")" = "$MANAGER_UNIT_SHA256"
must web_unit_changed_after test "$(sha256 "$WEB_UNIT")" = "$WEB_UNIT_SHA256"
must app_unit_changed_after test "$(sha256 "$APP_UNIT")" = "$APP_UNIT_SHA256"
must manager_socket_changed_after test "$(sha256 "$MANAGER_SOCKET_UNIT")" = "$MANAGER_SOCKET_UNIT_SHA256"
must pending_daemon_reload_after verify_no_pending_reload
must standalone_changed_after verify_8215
must successor_changed verify_web_release "$WEB_NEW"

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'router_release=codex-account-router-0.2.35-linux-x64\n'
printf 'web_release=c3e92f0f-20260803-m69-router-r119-manager-framing\n'
printf 'manager_framing_installed=true\n'
printf 'route_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
printf 'semantic_output_replay_attempted=false\n'
printf 'continuity=new_backend_session\n'
