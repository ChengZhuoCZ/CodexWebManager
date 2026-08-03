#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260803-m69-router-r115-owned-account-surface
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r112-visible-bootstrap-launcher"
readonly SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.33-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INPUT_ROOT="${R115_INPUT_ROOT:-/tmp/codex-r115-deploy-inputs}"
readonly INSTALLER="${INPUT_ROOT}/replace-r115-owned-account-surface.mjs"
readonly GENERIC_INSTALLER="${INPUT_ROOT}/replace-standalone-router-panel.mjs"
readonly PANEL_SOURCE="${INPUT_ROOT}/router-account-panel-standalone.js"
readonly LIFECYCLE_SOURCE="${INPUT_ROOT}/router-account-surface-lifecycle.js"
readonly INSTALLER_SHA256=1405b28a34c70232213f802dd0a8b792d6c1521dfd291c898f2d3a2370005720
readonly GENERIC_INSTALLER_SHA256=e41ef09d15848c2f32e4142558b459ccb1501036ebddd454c91e2b0f4f78ef27
readonly PANEL_SOURCE_SHA256=270c1de071c9f8af11938114fc7e102f2e8005762f1940c7730bc12c094f0fb2
readonly LIFECYCLE_SOURCE_SHA256=1a4ffdf16ab912adc5d9c2960a0a0ce50db87e434d956da8613c35b243ee1fcd

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly SOURCE_PANEL_ASSET=router-account-panel-8a5b3659.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-270c1de0.js
readonly SUCCESSOR_LIFECYCLE_ASSET=router-account-surface-lifecycle.js
readonly SOURCE_INDEX_SHA256=2791f3ad2fa2d761a0484cdb6ae595965dd7d3dc4c222b6b01d76509e86656bf
readonly SOURCE_INDEX_GZIP_SHA256=874f5421e97598a46b25c5fd124dd8a503167a5a1c20c07468bf0b8b04d1d685
readonly SOURCE_INDEX_BROTLI_SHA256=4dd379af19ec81936a1878fc25919ed3bbae4982f289b1a55af71b7b7084b451
readonly SOURCE_PANEL_SHA256=8a5b36594e6fd0c1dce9601d02ddefaa2ba0dc52a14babc2e3d9bd90fee1487d
readonly SOURCE_PANEL_GZIP_SHA256=0074a67bfbcf1fcd1df5c45f63aa5f6241a4a60d0eee68cc1ea4e48e4d8ba6e9
readonly SOURCE_PANEL_BROTLI_SHA256=cdfaeb6df693cc0229866ac55dbdae0f301ee0b9fa73ffd70a63743413da996a
readonly SUCCESSOR_INDEX_SHA256=16f9bbe52966d139140d58fb2c5f90099d116da20657c71dbe85f0e2bbbe5368
readonly SUCCESSOR_INDEX_GZIP_SHA256=a128303c54f6e3da33c666de9865985d8a29757f10402fed6da47f6db4fae89c
readonly SUCCESSOR_INDEX_BROTLI_SHA256=5012949885adb2d96d112a1df18f0b02cd5243ddb3751dab196104663baed539
readonly SUCCESSOR_PANEL_GZIP_SHA256=69f9b37a9126a9c4bcd80226df9dbad1cea64d22d1955498b5d3d977ce280c98
readonly SUCCESSOR_PANEL_BROTLI_SHA256=c65ba301ad09be3ce09c15197ca8fe10aeb8b19c4b7648569b9e8a14fcc91654
readonly SUCCESSOR_LIFECYCLE_GZIP_SHA256=0571505b141255008138df471b23f3e2e5cd9b9a9a4b55b71aff8a91b7b32227
readonly SUCCESSOR_LIFECYCLE_BROTLI_SHA256=ecb3883d179712ce60277e56f0ba811672ed7ce54f01d9b2cea7b84f673a3042

readonly APP_ASSET=app-initial-BTphDPeq.js
readonly PRELOAD_ASSET=preload-65708a1c.js
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SERVER_MAIN_SHA256=b9f1d11db2145b5a03b77ca8a662d88d2811fb9bba1d23f4be3634eab3ff9292
readonly UPLOAD_STORE_SHA256=dc4b24079c008dd8517f2715d804fd298d1ab181beea2ae7ebf5a196fa5177fc
readonly SESSION_AUTH_SHA256=7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6
readonly ROUTER_BRIDGE_SHA256=cec53389f8893f9ac2cf821dc2ac3a51b0d7fdd1537a3b32aba137e429515e62
readonly ACCOUNT_MANAGEMENT_SHA256=a676d6fb4a80cc3faa839bd39f72831fe2d862225e6afa1fa6676a3225cc3dec

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly ROUTER_FRAGMENT=/etc/systemd/system/codex-account-router.service
readonly ROUTER_FRAGMENT_SHA256=5c7aba18c5c658aa3c7e2d48b555a7404aa6d826d35c93b860011ec93b42a4f3
readonly ROUTER_DROPIN=/etc/systemd/system/codex-account-router.service.d/multi-account-failover.conf
readonly ROUTER_DROPIN_SHA256=af2788d525d72d32a16496aaf28245dcbe26946d73cd1f06740990f1afe8210e
readonly WEB_UNIT_SHA256=f2b1e3850ff70ce52ed0b2ffe21ad893ed3f152b2d2cb11b1c0b9b75310cb925
readonly APP_UNIT_SHA256=97f011bce6a11823db6e6faf19aa97998dbaafe36485698250e703319434665c
readonly MANAGER_SERVICE_UNIT_SHA256=2d3d7d86e84ee12bd2807c01f8650e4feb50798dad4ee8d6ee9cc9ad6c3f8e8a
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

verify_static_units() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_SERVICE_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

verify_router_policy() {
  [[ "$(sha256 "$ROUTER_FRAGMENT")" == "$ROUTER_FRAGMENT_SHA256" ]] || return 1
  [[ "$(sha256 "$ROUTER_DROPIN")" == "$ROUTER_DROPIN_SHA256" ]] || return 1
  systemctl show -p Environment --value "$ROUTER_SERVICE" |
    tr ' ' '\n' | grep -Fxq 'CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS=16'
}

verify_no_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_common_assets() {
  local root=$1
  [[ "$(sha256 "${root}/${ASSETS}/${APP_ASSET}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${PRELOAD_ASSET}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-upload-store.js")" == "$UPLOAD_STORE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$ROUTER_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-account-management.js")" == "$ACCOUNT_MANAGEMENT_SHA256" ]]
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
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}.gz")" == "$SUCCESSOR_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}.br")" == "$SUCCESSOR_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}")" == "$PANEL_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.gz")" == "$SUCCESSOR_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.br")" == "$SUCCESSOR_PANEL_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_LIFECYCLE_ASSET}")" == "$LIFECYCLE_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_LIFECYCLE_ASSET}.gz")" == "$SUCCESSOR_LIFECYCLE_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_LIFECYCLE_ASSET}.br")" == "$SUCCESSOR_LIFECYCLE_BROTLI_SHA256" ]] || return 1
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
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$ROUTED_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$ROUTED_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$ROUTER_SERVICE")" == "$ROUTER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")" == "$ROUTER_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$MANAGER_SERVICE")" == "$MANAGER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")" == "$MANAGER_START_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_START_BEFORE" ]]
}

browser_ready() {
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >"$workdir/index.html" || return 1
  grep -Fq "./assets/${SUCCESSOR_PANEL_ASSET}" "$workdir/index.html" || return 1
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status | /usr/bin/node -e '
      const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); const router=value?.router;
      if (!router || router.accounts?.length<2 || router.active_streams!==0 ||
          router.current_route?.continuity!=="new_backend_session") process.exit(1);
    '
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r115-rollback.$$"
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
workdir=$(mktemp -d /tmp/m69-r115-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must static_units_changed verify_static_units
must router_policy_changed verify_router_policy
must pending_daemon_reload verify_no_pending_reload
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must source_changed verify_source
must installer_changed test "$(sha256 "$INSTALLER")" = "$INSTALLER_SHA256"
must generic_installer_changed test "$(sha256 "$GENERIC_INSTALLER")" = "$GENERIC_INSTALLER_SHA256"
must panel_changed test "$(sha256 "$PANEL_SOURCE")" = "$PANEL_SOURCE_SHA256"
must lifecycle_changed test "$(sha256 "$LIFECYCLE_SOURCE")" = "$LIFECYCLE_SOURCE_SHA256"
must successor_exists test ! -e "$SUCCESSOR"
snapshot_protected
must protected_changed verify_protected

must successor_create mkdir "$SUCCESSOR"
successor_created=1
must successor_copy cp -a --reflink=auto "$EXPECTED_CURRENT/." "$SUCCESSOR/"
must panel_replace /usr/bin/node "$INSTALLER" --candidate "$SUCCESSOR" --panel-module "$PANEL_SOURCE" \
  --surface-lifecycle "$LIFECYCLE_SOURCE"
must successor_symlinks test -z "$(find "$SUCCESSOR" -type l -print -quit)"
must successor_changed verify_successor
must protected_changed verify_protected

current_before=$(readlink -f "$WEB_CURRENT")
next_link="${WEB_ROOT}/.current-r115.$$"
must current_link ln -s "$SUCCESSOR" "$next_link"
must current_switch replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$WEB_SERVICE" && browser_ready; then ready=1; break; fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must protected_changed verify_protected
must static_units_changed verify_static_units
must router_policy_changed verify_router_policy
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
printf 'account_manager_process_unchanged=true\n'
printf 'only_8216_web_restarted=true\n'
printf 'owned_shadow_surface=true\n'
printf 'native_react_tree_mutation=false\n'
printf 'settings_teardown_closes_account_dialog=false\n'
printf 'bounded_native_menu_inspection_attempts=5\n'
printf 'pre_status_launcher_visible=true\n'
printf 'initial_status_failure_visible=true\n'
printf 'bounded_status_retry_retained=true\n'
printf 'semantic_output_replay_forbidden=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
