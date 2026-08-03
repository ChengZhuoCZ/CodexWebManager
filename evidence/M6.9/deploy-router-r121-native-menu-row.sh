#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260803-m69-router-r121-native-menu-row
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r120-catalog-owner-boundary"
readonly SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.36-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INPUT_ROOT="${R121_INPUT_ROOT:-/tmp/codex-r121-deploy-inputs}"
readonly TRANSFORMER="${INPUT_ROOT}/replace-r121-native-menu-row.mjs"
readonly PRELOAD="${INPUT_ROOT}/preload-r121.js"
readonly TRANSFORMER_SHA256=dc4245942d9c0ddba69232edc1e7f7551ca4dd0d02a96354dd9e8dad6147dee8
readonly PRELOAD_SHA256=e9339fb81b42e829904b96e06374d4d04c56be32ada333659935ed0c051db3f2

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly OLD_PRELOAD=preload-e102b9bc.js
readonly NEW_PRELOAD=preload-e9339fb8.js
readonly CONTROLLER=router-account-controller-041ab79a.js
readonly APP=app-initial-BTphDPeq.js
readonly OLD_INDEX_SHA256=f51092f7915326b14a55cb0fdfaac018ef78aad54939d9384c5287486e17855e
readonly OLD_INDEX_GZIP_SHA256=8cac8aebbc3b8f5643ae4c38a8123c123a9603ee2577e6b5e5df3ce09de73647
readonly OLD_INDEX_BROTLI_SHA256=573b781544795077d4929ae65895d1cf8a9037036ed132fa9d4b5f7c948d6041
readonly NEW_INDEX_SHA256=731d8f71bc1dca7ccd359c21d391530f8da4d53955fecaf5bbf8575045f37441
readonly OLD_PRELOAD_SHA256=e102b9bc5a877847b51df6e45a65c9e262412e26015227306a8f2b190cacdc4c
readonly OLD_PRELOAD_GZIP_SHA256=e8f6b487bee479a45444ab3ee9457ab73cadd8a12261bf033b9b73d5def2530d
readonly OLD_PRELOAD_BROTLI_SHA256=d18e7a95c576e570df71f44250195c1a6ee49c6857671e33357a3155412a067b
readonly CONTROLLER_SHA256=041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly SERVER_MAIN_SHA256=b9f1d11db2145b5a03b77ca8a662d88d2811fb9bba1d23f4be3634eab3ff9292
readonly UPLOAD_STORE_SHA256=dc4b24079c008dd8517f2715d804fd298d1ab181beea2ae7ebf5a196fa5177fc
readonly SESSION_AUTH_SHA256=7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6
readonly STATUS_BRIDGE_SHA256=ea4fdbf76505c7d8dc330fcbd415ccb8ac59c27493b62e171f5a7905952e9bdd
readonly ACCOUNT_MANAGEMENT_SHA256=d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly WEB_UNIT_SHA256=8a0abeb472d04caed6fbd0a7fac11918b0bd4c3c4e2cba920633ad041a3cf4d6
readonly APP_UNIT_SHA256=97f011bce6a11823db6e6faf19aa97998dbaafe36485698250e703319434665c
readonly ROUTER_UNIT_SHA256=7d9ff054181a94775d784182bdc17591e6eb8c8dccb4b034c82e6492373e84d7
readonly MANAGER_UNIT_SHA256=5bc481350f24ae3e338861f5afa57a844736a54d5da50618f9f3e8a764dae6f4
readonly MANAGER_SOCKET_UNIT_SHA256=73e7c827dbaf0a5e4bafc8d29d48fead8d515c45fac015ac9166698d9ba55dba
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_UNIT_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3

success=0
successor_created=0
current_switched=0
snapshot_complete=0
current_before=
workdir=

sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_value() { systemctl show -p "$1" --value "$2"; }
unit_sha256() { systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1; }
must() { local label=$1; shift; "$@" || { printf 'deployment_error=%s\n' "$label" >&2; exit 1; }; }
expect_active() { [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]; }
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
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, timeout: 3000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) process.exit(2);
        const status = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const alias = status.current_route?.account_alias;
        if (status.status !== "ready" || typeof alias !== "string" ||
            !/^[A-Za-z0-9._-]{1,64}$/u.test(alias)) process.exit(3);
        process.stdout.write(`${alias}|${status.active_requests}|${status.active_streams}\n`);
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => process.exit(4));
    request.end();
  '
}

verify_units() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

verify_no_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" \
    "$MANAGER_SOCKET" "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_common_assets() {
  local root=$1
  [[ "$(sha256 "${root}/${ASSETS}/${CONTROLLER}")" == "$CONTROLLER_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${APP}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-upload-store.js")" == "$UPLOAD_STORE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$STATUS_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-account-management.js")" == "$ACCOUNT_MANAGEMENT_SHA256" ]]
}

verify_source() {
  verify_common_assets "$EXPECTED_CURRENT" || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}")" == "$OLD_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}.gz")" == "$OLD_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}.br")" == "$OLD_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${OLD_PRELOAD}")" == "$OLD_PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${OLD_PRELOAD}.gz")" == "$OLD_PRELOAD_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${OLD_PRELOAD}.br")" == "$OLD_PRELOAD_BROTLI_SHA256" ]]
}

verify_compressed_triplet() {
  /usr/bin/node -e '
    const fs=require("node:fs"), z=require("node:zlib"), p=process.argv[1];
    const raw=fs.readFileSync(p);
    if (!raw.equals(z.gunzipSync(fs.readFileSync(`${p}.gz`)))) process.exit(1);
    if (!raw.equals(z.brotliDecompressSync(fs.readFileSync(`${p}.br`)))) process.exit(1);
  ' "$1"
}

verify_successor() {
  verify_common_assets "$SUCCESSOR" || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}")" == "$NEW_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${NEW_PRELOAD}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${OLD_PRELOAD}" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${OLD_PRELOAD}.gz" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${OLD_PRELOAD}.br" ]] || return 1
  [[ "$(grep -Foc "./assets/${NEW_PRELOAD}" "${SUCCESSOR}/${INDEX}")" == 1 ]] || return 1
  [[ "$(grep -Foc "./assets/${CONTROLLER}" "${SUCCESSOR}/${INDEX}")" == 1 ]] || return 1
  grep -Fq 'data-router-account-menu-layout' "${SUCCESSOR}/${ASSETS}/${NEW_PRELOAD}" || return 1
  ! grep -Fq 'attachShadow' "${SUCCESSOR}/${ASSETS}/${NEW_PRELOAD}" || return 1
  verify_compressed_triplet "${SUCCESSOR}/${INDEX}" || return 1
  verify_compressed_triplet "${SUCCESSOR}/${ASSETS}/${NEW_PRELOAD}"
}

snapshot_protected() {
  STANDALONE_WEB_PID_BEFORE=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
  STANDALONE_WEB_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
  STANDALONE_APP_PID_BEFORE=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
  STANDALONE_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
  APP_PID_BEFORE=$(unit_value MainPID "$APP_SERVICE")
  APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
  ROUTER_PID_BEFORE=$(unit_value MainPID "$ROUTER_SERVICE")
  ROUTER_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")
  MANAGER_PID_BEFORE=$(unit_value MainPID "$MANAGER_SERVICE")
  MANAGER_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")
  MANAGER_SOCKET_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SOCKET")
  WEB_PID_BEFORE=$(unit_value MainPID "$WEB_SERVICE")
  snapshot_complete=1
}

verify_protected() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(readlink -f /opt/codex-account-router/current)" == "$ROUTER_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$ROUTER_SERVICE")" == "$ROUTER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")" == "$ROUTER_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$MANAGER_SERVICE")" == "$MANAGER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")" == "$MANAGER_START_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_START_BEFORE" ]] || return 1
  verify_units
}

browser_ready() {
  local attempt code
  for attempt in $(seq 1 40); do
    code=$(curl --noproxy '*' -sS --max-time 2 -H 'Host: 100.95.50.98:8216' \
      -H 'Accept: text/html' -o "$workdir/index.html" -w '%{http_code}' http://127.0.0.1:8216/ || true)
    if [[ "$code" == 200 ]] && grep -Fq "./assets/${NEW_PRELOAD}" "$workdir/index.html"; then return 0; fi
    sleep 0.25
  done
  return 1
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r121-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      replace_link "$rollback_link" "$WEB_CURRENT"
      systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then rm -rf -- "$SUCCESSOR"; fi
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  if [[ "$snapshot_complete" -eq 1 ]]; then verify_protected || code=1; fi
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r121-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" \
  "$MANAGER_SOCKET" "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must pending_reload verify_no_pending_reload
must unit_boundary_changed verify_units
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_8215_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must successor_exists test ! -e "$SUCCESSOR"
must transformer_changed test "$(sha256 "$TRANSFORMER")" = "$TRANSFORMER_SHA256"
must preload_changed test "$(sha256 "$PRELOAD")" = "$PRELOAD_SHA256"
must source_changed verify_source
state_before=$(router_state)
IFS='|' read -r route_before requests_before streams_before <<<"$state_before"
must active_requests_nonzero test "$requests_before" = 0
must active_streams_nonzero test "$streams_before" = 0
snapshot_protected

must successor_create mkdir -m 0755 "$SUCCESSOR"
successor_created=1
must successor_copy cp -a --reflink=auto "$EXPECTED_CURRENT/." "$SUCCESSOR/"
must transform /usr/bin/node "$TRANSFORMER" --candidate "$SUCCESSOR" --react-preload "$PRELOAD"
must successor_changed verify_successor

current_before=$(readlink -f "$WEB_CURRENT")
next_link="${WEB_ROOT}/.current-r121-next.$$"
must next_link ln -s "$SUCCESSOR" "$next_link"
must activate replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must restart_8216_web systemctl restart "$WEB_SERVICE"
must web_active expect_active "$WEB_SERVICE"
must browser_ready browser_ready
must successor_not_active test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must protected_changed verify_protected
state_after=$(router_state)
IFS='|' read -r route_after requests_after streams_after <<<"$state_after"
must route_changed test "$route_after" = "$route_before"
must active_requests_changed test "$requests_after" = 0
must active_streams_changed test "$streams_after" = 0

success=1
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'native_menu_layout=native-row\n'
printf 'route_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'account_router_unchanged=true\n'
printf 'account_manager_unchanged=true\n'
printf 'only_8216_web_restarted=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
printf 'semantic_output_replayed=false\n'
