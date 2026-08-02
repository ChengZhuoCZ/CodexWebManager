#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260802-m69-router-r100-profile-menu-dom
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260802-m69-router-r99-profile-menu"
readonly SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.32-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INSTALLER="${R100_INSTALLER:-/tmp/replace-r100-router-profile-menu.mjs}"
readonly GENERIC_INSTALLER="${R100_GENERIC_INSTALLER:-/tmp/replace-standalone-router-panel.mjs}"
readonly PANEL_SOURCE="${R100_PANEL_SOURCE:-/tmp/router-account-panel-standalone.js}"
readonly INSTALLER_SHA256=90626e6c5210977a2f6df031917b0d35547ab9324e222dcebf54021f95e604e5
readonly GENERIC_INSTALLER_SHA256=e41ef09d15848c2f32e4142558b459ccb1501036ebddd454c91e2b0f4f78ef27
readonly PANEL_SOURCE_SHA256=559921aef674c12d7f84279c6153d58b8abe0635a64ae6d9ab786499159a3bcd

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly APP_ASSET=app-initial-BTphDPeq.js
readonly PRELOAD_ASSET=preload-65708a1c.js
readonly SOURCE_PANEL_ASSET=router-account-panel-d562ebb2.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-559921ae.js
readonly SOURCE_INDEX_SHA256=4d2a99f1e45f2145aea2023b8602b533b0e22093e0a51abc2c832faff2b41f59
readonly SOURCE_INDEX_GZIP_SHA256=f6b355c0c80adc05a41cb7134f434a6e3d2bd8cd9afbeb6b768b84c225d1387b
readonly SOURCE_INDEX_BROTLI_SHA256=22582389def46ff6dbf04f70af202246bdd7c103fcd1c4e7a87f0a701b7c1f91
readonly SOURCE_PANEL_SHA256=d562ebb2617c2dd5abee9dc9933275eb6f2ece54f8612b41959de725574fdfbe
readonly SOURCE_PANEL_GZIP_SHA256=2eb2af2091c7420dec9588465199d02e6fad65519a493cb0d1ba41adac093e5c
readonly SOURCE_PANEL_BROTLI_SHA256=fb6dea94b369970ab016bb26bb9e948d8564d41924320cd2acf926a762618ca6
readonly SUCCESSOR_INDEX_SHA256=3d868b8b58ef8e936e082c481305aeb77a81978623e58063c5f6816309e37ab6
readonly SUCCESSOR_INDEX_BROTLI_SHA256=e9f8d5bf3cbcffc68238e547a6af072a934b267c488dc6590be504191da28c44
readonly SUCCESSOR_PANEL_BROTLI_SHA256=1cfd96adfa75c6d62d639199ae6f776458a73041d11451a4643d804fbf1acae2
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SERVER_MAIN_SHA256=ea69e94c622db32c8d7cc6156d9ffabd5be77ba608b3709eae4928b28c829e67
readonly SESSION_AUTH_SHA256=7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6
readonly ROUTER_BRIDGE_SHA256=185cf83adf11510e2b5c69d3c0652f5c146aa87a56ed97c6028ea2dc62bf3757

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly WEB_UNIT_SHA256=b9da9a0e095d90cf1e80335e1a6928c5621f22cd85a5fe75d5f65c02c35ce9ee
readonly APP_UNIT_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef
readonly ROUTER_UNIT_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
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

verify_units() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

verify_no_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_common_assets() {
  local root=$1
  [[ "$(sha256 "${root}/${ASSETS}/${APP_ASSET}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${PRELOAD_ASSET}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$ROUTER_BRIDGE_SHA256" ]]
}

verify_source() {
  verify_common_assets "$EXPECTED_CURRENT" || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}")" == "$SOURCE_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}.gz")" == "$SOURCE_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}.br")" == "$SOURCE_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${SOURCE_PANEL_ASSET}")" == "$SOURCE_PANEL_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${SOURCE_PANEL_ASSET}.gz")" == "$SOURCE_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${SOURCE_PANEL_ASSET}.br")" == "$SOURCE_PANEL_BROTLI_SHA256" ]]
}

verify_successor() {
  verify_common_assets "$SUCCESSOR" || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}")" == "$SUCCESSOR_INDEX_SHA256" ]] || return 1
  [[ "$(gzip -cd "${SUCCESSOR}/${INDEX}.gz" | sha256sum | cut -d ' ' -f 1)" == "$SUCCESSOR_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}.br")" == "$SUCCESSOR_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}")" == "$PANEL_SOURCE_SHA256" ]] || return 1
  [[ "$(gzip -cd "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.gz" | sha256sum | cut -d ' ' -f 1)" == "$PANEL_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.br")" == "$SUCCESSOR_PANEL_BROTLI_SHA256" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${SOURCE_PANEL_ASSET}" ]] || return 1
  grep -Fq "./assets/${SUCCESSOR_PANEL_ASSET}" "${SUCCESSOR}/${INDEX}"
}

snapshot_protected() {
  STANDALONE_WEB_PID_BEFORE=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
  STANDALONE_WEB_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
  STANDALONE_APP_PID_BEFORE=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
  STANDALONE_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
  ROUTED_APP_PID_BEFORE=$(unit_value MainPID "$APP_SERVICE")
  ROUTED_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
  ROUTER_PID_BEFORE=$(unit_value MainPID "$ROUTER_SERVICE")
  ROUTER_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")
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
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$ROUTED_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$ROUTED_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$ROUTER_SERVICE")" == "$ROUTER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")" == "$ROUTER_START_BEFORE" ]]
}

browser_ready() {
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >/dev/null || return 1
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/session | /usr/bin/node -e '
      const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8"));
      if (typeof value?.csrfToken!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) process.exit(1);
    ' || return 1
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status | /usr/bin/node -e '
      const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); const router=value?.router;
      if (!router || router.accounts?.length!==2 || router.active_streams!==0 ||
          router.current_route?.continuity!=="new_backend_session") process.exit(1);
    '
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r100-rollback.$$"
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
workdir=$(mktemp -d /tmp/m69-r100-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must units_changed verify_units
must pending_daemon_reload verify_no_pending_reload
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must source_changed verify_source
must installer_changed test "$(sha256 "$INSTALLER")" = "$INSTALLER_SHA256"
must generic_installer_changed test "$(sha256 "$GENERIC_INSTALLER")" = "$GENERIC_INSTALLER_SHA256"
must panel_changed test "$(sha256 "$PANEL_SOURCE")" = "$PANEL_SOURCE_SHA256"
must successor_exists test ! -e "$SUCCESSOR"
snapshot_protected
must protected_changed verify_protected

must successor_create mkdir "$SUCCESSOR"
successor_created=1
must successor_copy cp -a --reflink=auto "$EXPECTED_CURRENT/." "$SUCCESSOR/"
must panel_replace /usr/bin/node "$INSTALLER" --candidate "$SUCCESSOR" --panel-module "$PANEL_SOURCE"
must successor_symlinks test -z "$(find "$SUCCESSOR" -type l -print -quit)"
must successor_changed verify_successor
must protected_changed verify_protected

current_before=$(readlink -f "$WEB_CURRENT")
next_link="${WEB_ROOT}/.current-r100.$$"
must current_link ln -s "$SUCCESSOR" "$next_link"
must current_switch replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && expect_active "$ROUTER_SERVICE" && browser_ready; then
    ready=1
    break
  fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must protected_changed verify_protected
must units_changed verify_units
must pending_daemon_reload verify_no_pending_reload
must current_not_successor test "$(readlink -f "$WEB_CURRENT")" = "$SUCCESSOR"
must successor_changed verify_successor

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'account_router_process_unchanged=true\n'
printf 'only_8216_web_restarted=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
