#!/usr/bin/env bash
set -euo pipefail

readonly INPUT_ROOT="${R118_INPUT_ROOT:-/tmp/codex-r118-deploy-inputs}"
readonly ROUTER_ARCHIVE="${INPUT_ROOT}/codex-account-router-0.2.34-linux-x64.tar.gz"
readonly ROUTER_ARCHIVE_SHA256=819b716adc608e53be57fd45a56bedbb6befbfd8a0b5f0055baa55cda95eb45a
readonly TRANSFORMER="${INPUT_ROOT}/replace-r118-native-identity-sync.mjs"
readonly TRANSFORMER_SHA256=8eacac1163e922097a67568519f891355a6376127facc9324b1be384fc81b1b5
readonly ROUTER_BRIDGE="${INPUT_ROOT}/router-status-bridge-standalone.js"
readonly ROUTER_BRIDGE_SHA256=54d170bfaa484d936149e9ea130052d63a6533e49a4f437b6c338fc55de1ecb1
readonly MANAGER_UNIT_INPUT="${INPUT_ROOT}/codex-router-account-manager.service"
readonly MANAGER_UNIT_INPUT_SHA256=15c1f8bdc57df11b74ed3b90eb52d422e3960017dd41eccf8dd0c99102d41259
readonly WEB_UNIT_INPUT="${INPUT_ROOT}/codex-web-router.service"
readonly WEB_UNIT_INPUT_SHA256=32df27d024a2f24800e82981768ded9153e8c4dcc3f544406f6e503550c8b95d

readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_OLD="${ROUTER_ROOT}/releases/codex-account-router-0.2.33-linux-x64"
readonly ROUTER_NEW="${ROUTER_ROOT}/releases/codex-account-router-0.2.34-linux-x64"
readonly ROUTER_ARCHIVE_ROOT=codex-account-router-0.2.34-linux-x64
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_OLD="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r116-react-account-settings"
readonly WEB_NEW="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r118-native-identity-sync"
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
readonly ADMIN_TOKEN=/etc/codex-account-router/credentials/admin-token

readonly OLD_MANAGER_UNIT_SHA256=9da7880a383eaa5f4057eb523a267fda4b6aafa0a0de0361745a608ac7a1671b
readonly OLD_WEB_UNIT_SHA256=1daaa9b821875713d72dd61eedf6639258aa1ed9e362df058e7ca1ee1fc8e328
readonly APP_UNIT_SHA256=983b71a39bec32bdb1c9c74f0cd203f4c70e4f08ca4c8549df87fe8e29b141ad
readonly MANAGER_SOCKET_UNIT_SHA256=29aecb37ec655eb4c3499f400f48bc80944ccfd02ef317cf4832e449046fd53e
readonly NEW_CONTROLLER=router-account-controller-041ab79a.js
readonly NEW_CONTROLLER_SHA256=041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429
readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets

success=0
mutation_started=0
router_release_created=0
web_release_created=0
router_link_switched=0
web_link_switched=0
units_replaced=0
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
    const fs = require("node:fs");
    const http = require("node:http");
    const token = fs.readFileSync("/etc/codex-account-router/credentials/admin-token", "utf8").trim();
    const request = http.request({
      host: "127.0.0.1", port: 18318, path: "/v1/status", method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      timeout: 3000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) process.exit(2);
        const status = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const alias = status.current_route?.account_alias;
        const ready = status.status === "ready" ? 1 : 0;
        const requests = Number.isInteger(status.active_requests) ? status.active_requests : -1;
        const streams = Number.isInteger(status.active_streams) ? status.active_streams : -1;
        if (typeof alias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(alias)) process.exit(3);
        process.stdout.write(`${alias}|${ready}|${requests}|${streams}\n`);
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => process.exit(4));
    request.end();
  '
}

verify_no_pending_reload() {
  local unit
  for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$WEB_SERVICE" "$APP_SERVICE" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_8215_unchanged() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]] || return 1
  [[ "$(effective_unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_EFFECTIVE_BEFORE" ]] || return 1
  [[ "$(effective_unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_EFFECTIVE_BEFORE" ]]
}

verify_r118_web_release() {
  local root=$1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$ROUTER_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${NEW_CONTROLLER}")" == "$NEW_CONTROLLER_SHA256" ]] || return 1
  [[ "$(grep -Foc "./assets/${NEW_CONTROLLER}" "${root}/${INDEX}")" == 1 ]] || return 1
  [[ ! -e "${root}/${ASSETS}/router-account-controller-e506d62f.js" ]] || return 1
  /usr/bin/node -e '
    const fs=require("node:fs"), z=require("node:zlib"), p=process.argv[1];
    const raw=fs.readFileSync(p);
    if (!raw.equals(z.gunzipSync(fs.readFileSync(`${p}.gz`)))) process.exit(1);
    if (!raw.equals(z.brotliDecompressSync(fs.readFileSync(`${p}.br`)))) process.exit(1);
  ' "${root}/${INDEX}" || return 1
  /usr/bin/node -e '
    const fs=require("node:fs"), z=require("node:zlib"), p=process.argv[1];
    const raw=fs.readFileSync(p);
    if (!raw.equals(z.gunzipSync(fs.readFileSync(`${p}.gz`)))) process.exit(1);
    if (!raw.equals(z.brotliDecompressSync(fs.readFileSync(`${p}.br`)))) process.exit(1);
  ' "${root}/${ASSETS}/${NEW_CONTROLLER}"
}

browser_ready() {
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >"$workdir/index.html" || return 1
  grep -Fq "./assets/${NEW_CONTROLLER}" "$workdir/index.html" || return 1
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status | /usr/bin/node -e '
      const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); const router=value?.router;
      if (!router || router.status!=="ready" || router.accounts?.length<2 ||
          router.active_streams!==0 || router.current_route?.continuity!=="new_backend_session") process.exit(1);
    '
}

restore_regular_file() {
  local backup=$1
  local target=$2
  local mode=$3
  local temporary="${target}.r118-rollback.$$"
  install -o root -g root -m "$mode" "$backup" "$temporary"
  mv -f "$temporary" "$target"
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$mutation_started" -eq 1 ]]; then
    systemctl stop "$MANAGER_SERVICE" >/dev/null 2>&1 || true
    if [[ -n "$workdir" && -f "$workdir/manager.service.before" && -f "$workdir/web.service.before" ]]; then
      restore_regular_file "$workdir/manager.service.before" "$MANAGER_UNIT" 0644 || true
      restore_regular_file "$workdir/web.service.before" "$WEB_UNIT" 0644 || true
    fi
    if [[ "$router_link_switched" -eq 1 ]]; then
      local old_router_link="${ROUTER_ROOT}/.current-r118-rollback.$$"
      ln -s "$ROUTER_OLD" "$old_router_link" && replace_link "$old_router_link" "$ROUTER_CURRENT" || true
    fi
    if [[ "$web_link_switched" -eq 1 ]]; then
      local old_web_link="${WEB_ROOT}/.current-r118-rollback.$$"
      ln -s "$WEB_OLD" "$old_web_link" && replace_link "$old_web_link" "$WEB_CURRENT" || true
    fi
    if [[ -n "$workdir" && -f "$workdir/app-server-auth.before" && \
      "$(sha256 "$APP_CREDENTIAL" 2>/dev/null || true)" != "$APP_CREDENTIAL_SHA256_BEFORE" ]]; then
      systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
      restore_regular_file "$workdir/app-server-auth.before" "$APP_CREDENTIAL" 0600 || true
      systemctl start "$APP_SERVICE" >/dev/null 2>&1 || true
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    systemctl start "$MANAGER_SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    [[ "$web_release_created" -eq 0 ]] || rm -rf -- "$WEB_NEW"
    [[ "$router_release_created" -eq 0 ]] || rm -rf -- "$ROUTER_NEW"
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r118-deploy.XXXXXX)
for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$WEB_SERVICE" "$APP_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must pending_daemon_reload verify_no_pending_reload
must unexpected_router_current test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_OLD"
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$WEB_OLD"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must old_manager_unit_changed test "$(sha256 "$MANAGER_UNIT")" = "$OLD_MANAGER_UNIT_SHA256"
must old_web_unit_changed test "$(sha256 "$WEB_UNIT")" = "$OLD_WEB_UNIT_SHA256"
must app_unit_changed test "$(sha256 "$APP_UNIT")" = "$APP_UNIT_SHA256"
must manager_socket_unit_changed test "$(sha256 "$MANAGER_SOCKET_UNIT")" = "$MANAGER_SOCKET_UNIT_SHA256"
must router_archive_changed test "$(sha256 "$ROUTER_ARCHIVE")" = "$ROUTER_ARCHIVE_SHA256"
must transformer_changed test "$(sha256 "$TRANSFORMER")" = "$TRANSFORMER_SHA256"
must router_bridge_changed test "$(sha256 "$ROUTER_BRIDGE")" = "$ROUTER_BRIDGE_SHA256"
must manager_unit_input_changed test "$(sha256 "$MANAGER_UNIT_INPUT")" = "$MANAGER_UNIT_INPUT_SHA256"
must web_unit_input_changed test "$(sha256 "$WEB_UNIT_INPUT")" = "$WEB_UNIT_INPUT_SHA256"
must router_successor_exists test ! -e "$ROUTER_NEW"
must web_successor_exists test ! -e "$WEB_NEW"

STANDALONE_WEB_PID_BEFORE=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID_BEFORE=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
STANDALONE_WEB_EFFECTIVE_BEFORE=$(effective_unit_sha256 "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_EFFECTIVE_BEFORE=$(effective_unit_sha256 "$STANDALONE_APP_SERVICE")
APP_PID_BEFORE=$(unit_value MainPID "$APP_SERVICE")
APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
APP_EFFECTIVE_BEFORE=$(effective_unit_sha256 "$APP_SERVICE")
APP_CREDENTIAL_SHA256_BEFORE=$(sha256 "$APP_CREDENTIAL")
ROUTER_PID_BEFORE=$(unit_value MainPID "$ROUTER_SERVICE")
MANAGER_PID_BEFORE=$(unit_value MainPID "$MANAGER_SERVICE")
WEB_PID_BEFORE=$(unit_value MainPID "$WEB_SERVICE")
ROUTER_STATE_BEFORE=$(router_state)
IFS='|' read -r ROUTE_BEFORE READY_BEFORE REQUESTS_BEFORE STREAMS_BEFORE <<<"$ROUTER_STATE_BEFORE"
must router_not_ready test "$READY_BEFORE" -eq 1
must active_stream_present test "$STREAMS_BEFORE" -eq 0
must active_router_connections test -z "$(ss -Hnt state established '( sport = :18317 or dport = :18317 )' 2>/dev/null)"
must standalone_changed verify_8215_unchanged

cp -p "$MANAGER_UNIT" "$workdir/manager.service.before"
cp -p "$WEB_UNIT" "$workdir/web.service.before"
cp -p "$APP_CREDENTIAL" "$workdir/app-server-auth.before"
mkdir "$workdir/router"
tar -xzf "$ROUTER_ARCHIVE" --no-same-owner -C "$workdir/router"
must extracted_router_missing test -f "$workdir/router/${ROUTER_ARCHIVE_ROOT}/manifest.json"
must extracted_router_version /usr/bin/node -e '
  const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if (m?.version!=="0.2.34" || m?.target?.os!=="linux" || m?.target?.architecture!=="x64") process.exit(1);
' "$workdir/router/${ROUTER_ARCHIVE_ROOT}/manifest.json"

must web_successor_create mkdir "$WEB_NEW"
web_release_created=1
must web_successor_copy cp -a --reflink=auto "$WEB_OLD/." "$WEB_NEW/"
must web_successor_symlinks test -z "$(find "$WEB_NEW" -type l -print -quit)"
must web_transform /usr/bin/node "$TRANSFORMER" --candidate "$WEB_NEW" --router-bridge "$ROUTER_BRIDGE"
must web_successor_verify verify_r118_web_release "$WEB_NEW"
must standalone_changed verify_8215_unchanged

mutation_started=1
router_staging="${ROUTER_ROOT}/releases/.codex-account-router-0.2.34-linux-x64.r118.$$"
must router_staging_create mkdir "$router_staging"
must router_release_copy cp -a "$workdir/router/${ROUTER_ARCHIVE_ROOT}/." "$router_staging/"
must router_release_activate mv "$router_staging" "$ROUTER_NEW"
router_release_created=1
router_next_link="${ROUTER_ROOT}/.current-r118.$$"
must router_next_link ln -s "releases/codex-account-router-0.2.34-linux-x64" "$router_next_link"
must router_link_switch replace_link "$router_next_link" "$ROUTER_CURRENT"
router_link_switched=1

manager_unit_next="${MANAGER_UNIT}.r118.$$"
web_unit_next="${WEB_UNIT}.r118.$$"
must manager_unit_stage install -o root -g root -m 0644 "$MANAGER_UNIT_INPUT" "$manager_unit_next"
must web_unit_stage install -o root -g root -m 0644 "$WEB_UNIT_INPUT" "$web_unit_next"
must manager_unit_replace mv -f "$manager_unit_next" "$MANAGER_UNIT"
must web_unit_replace mv -f "$web_unit_next" "$WEB_UNIT"
units_replaced=1

web_next_link="${WEB_ROOT}/.current-r118.$$"
must web_next_link ln -s "$WEB_NEW" "$web_next_link"
must web_link_switch replace_link "$web_next_link" "$WEB_CURRENT"
web_link_switched=1

must daemon_reload systemctl daemon-reload
must router_restart systemctl restart "$ROUTER_SERVICE"
must manager_restart systemctl restart "$MANAGER_SERVICE"
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 120); do
  if expect_active "$ROUTER_SERVICE" && expect_active "$MANAGER_SERVICE" && \
    expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && browser_ready; then
    ready=1
    break
  fi
  sleep 0.25
done
must readiness_failed test "$ready" -eq 1

ROUTER_STATE_AFTER=$(router_state)
IFS='|' read -r ROUTE_AFTER READY_AFTER REQUESTS_AFTER STREAMS_AFTER <<<"$ROUTER_STATE_AFTER"
must router_not_ready_after test "$READY_AFTER" -eq 1
must active_request_after test "$REQUESTS_AFTER" -eq 0
must active_stream_after test "$STREAMS_AFTER" -eq 0
must route_changed test "$ROUTE_AFTER" = "$ROUTE_BEFORE"
must app_credential_changed test "$(sha256 "$APP_CREDENTIAL")" = "$APP_CREDENTIAL_SHA256_BEFORE"
must app_server_restarted test "$(unit_value MainPID "$APP_SERVICE")" = "$APP_PID_BEFORE"
must app_server_start_changed test "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" = "$APP_START_BEFORE"
must app_server_unit_changed test "$(effective_unit_sha256 "$APP_SERVICE")" = "$APP_EFFECTIVE_BEFORE"
must router_not_restarted test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID_BEFORE"
must manager_not_restarted test "$(unit_value MainPID "$MANAGER_SERVICE")" != "$MANAGER_PID_BEFORE"
must web_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must router_current_wrong test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_NEW"
must web_current_wrong test "$(readlink -f "$WEB_CURRENT")" = "$WEB_NEW"
must manager_unit_wrong test "$(sha256 "$MANAGER_UNIT")" = "$MANAGER_UNIT_INPUT_SHA256"
must web_unit_wrong test "$(sha256 "$WEB_UNIT")" = "$WEB_UNIT_INPUT_SHA256"
must app_unit_changed_after test "$(sha256 "$APP_UNIT")" = "$APP_UNIT_SHA256"
must manager_socket_unit_changed_after test "$(sha256 "$MANAGER_SOCKET_UNIT")" = "$MANAGER_SOCKET_UNIT_SHA256"
must pending_daemon_reload_after verify_no_pending_reload
must standalone_changed_after verify_8215_unchanged
must r118_release_changed verify_r118_web_release "$WEB_NEW"

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'router_release=codex-account-router-0.2.34-linux-x64\n'
printf 'web_release=c3e92f0f-20260803-m69-router-r118-native-identity-sync\n'
printf 'native_identity_sync_installed=true\n'
printf 'route_unchanged=true\n'
printf 'app_server_credential_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
printf 'semantic_output_replay_attempted=false\n'
printf 'continuity=new_backend_session\n'
