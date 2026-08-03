#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260803-m69-router-r110-compact-auto-failover
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r109-safari-profile-menu"
readonly SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.33-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INPUT_ROOT="${R110_INPUT_ROOT:-/tmp/codex-r110-deploy-inputs}"
readonly INSTALLER="${INPUT_ROOT}/replace-r110-compact-auto-failover.mjs"
readonly GENERIC_INSTALLER="${INPUT_ROOT}/replace-standalone-router-panel.mjs"
readonly PANEL_SOURCE="${INPUT_ROOT}/router-account-panel-standalone.js"
readonly FAILOVER_DROPIN_SOURCE="${INPUT_ROOT}/multi-account-failover.conf"
readonly INSTALLER_SHA256=17f5ec65afa3a63cbe849e6af1dbd302efd123c989c9955d637c3f823ac369bc
readonly GENERIC_INSTALLER_SHA256=e41ef09d15848c2f32e4142558b459ccb1501036ebddd454c91e2b0f4f78ef27
readonly PANEL_SOURCE_SHA256=23e5003262db751be029f0a1b32c8945601d1536d8beda8d7457a83367c1d4fe
readonly FAILOVER_DROPIN_SHA256=af2788d525d72d32a16496aaf28245dcbe26946d73cd1f06740990f1afe8210e

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly SOURCE_PANEL_ASSET=router-account-panel-9dc6748b.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-23e50032.js
readonly SOURCE_INDEX_SHA256=e177f8f37a19c3a6a803b9b89f41784bb0e8fa2f89147b4ea156cd58a9fa037e
readonly SOURCE_INDEX_GZIP_SHA256=dd54e96697e220defe31b5d832c5795c92c32e9e46dec7017b332b95d6d5dc69
readonly SOURCE_INDEX_BROTLI_SHA256=b7968aecac5ce0fe796efdc36ab26dcc56e10556bfd63ef64ea6674a9d45bb8d
readonly SOURCE_PANEL_SHA256=9dc6748baa2a059dd1e4655ef25e2b1ef5fa106e6e1db753e04f0752ecd295f5
readonly SOURCE_PANEL_GZIP_SHA256=4fc63d2469b0b6f48c5ac485ca66e41c34a64929dcbac1b3e23047676f4ae5e5
readonly SOURCE_PANEL_BROTLI_SHA256=fa973ea03eccd0d420971381c8fbe8ac7a6c431eb0a29f939e33822ecabbb4af
readonly SUCCESSOR_INDEX_SHA256=5c74320da619209813e0883a90ab7744864ad2aff886dde44ac7ac5ccfbf9e7f
readonly SUCCESSOR_INDEX_GZIP_SHA256=2dd1d5045902822391875afcf218478e6ff447ae8487051703e33492637bdbbf
readonly SUCCESSOR_INDEX_BROTLI_SHA256=34c0a7c35ad382fbddd56a0c9f16f989f3cc1a3924fb052a8267a7eb5067df54
readonly SUCCESSOR_PANEL_GZIP_SHA256=c37b0580cff540ea875443f7f0ac6a71b262c76557f8046538945d129a1365e8
readonly SUCCESSOR_PANEL_BROTLI_SHA256=b62b36bc76c462f285277b349de10433718de45cc355800d8453d9365a2666cf

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
readonly WEB_UNIT_SHA256=f2b1e3850ff70ce52ed0b2ffe21ad893ed3f152b2d2cb11b1c0b9b75310cb925
readonly APP_UNIT_SHA256=97f011bce6a11823db6e6faf19aa97998dbaafe36485698250e703319434665c
readonly MANAGER_SERVICE_UNIT_SHA256=2d3d7d86e84ee12bd2807c01f8650e4feb50798dad4ee8d6ee9cc9ad6c3f8e8a
readonly MANAGER_SOCKET_UNIT_SHA256=73e7c827dbaf0a5e4bafc8d29d48fead8d515c45fac015ac9166698d9ba55dba
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_UNIT_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3

success=0
successor_created=0
current_switched=0
dropin_installed=0
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
  [[ "$(sha256 "$ROUTER_DROPIN")" == "$FAILOVER_DROPIN_SHA256" ]] || return 1
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
  MANAGER_PID_BEFORE=$(unit_value MainPID "$MANAGER_SERVICE")
  MANAGER_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")
  MANAGER_SOCKET_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SOCKET")
  WEB_PID_BEFORE=$(unit_value MainPID "$WEB_SERVICE")
  ROUTER_PID_BEFORE=$(unit_value MainPID "$ROUTER_SERVICE")
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
    if [[ "$dropin_installed" -eq 1 ]]; then
      rm -f -- "$ROUTER_DROPIN"
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl restart "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r110-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      replace_link "$rollback_link" "$WEB_CURRENT"
      systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then rm -rf -- "$SUCCESSOR"; fi
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r110-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must static_units_changed verify_static_units
must router_fragment_changed test "$(sha256 "$ROUTER_FRAGMENT")" = "$ROUTER_FRAGMENT_SHA256"
must failover_dropin_exists test ! -e "$ROUTER_DROPIN"
must pending_daemon_reload verify_no_pending_reload
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must source_changed verify_source
must installer_changed test "$(sha256 "$INSTALLER")" = "$INSTALLER_SHA256"
must generic_installer_changed test "$(sha256 "$GENERIC_INSTALLER")" = "$GENERIC_INSTALLER_SHA256"
must panel_changed test "$(sha256 "$PANEL_SOURCE")" = "$PANEL_SOURCE_SHA256"
must failover_dropin_changed test "$(sha256 "$FAILOVER_DROPIN_SOURCE")" = "$FAILOVER_DROPIN_SHA256"
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

must dropin_directory install -d -o root -g root -m 0755 "$(dirname "$ROUTER_DROPIN")"
must dropin_install install -o root -g root -m 0644 "$FAILOVER_DROPIN_SOURCE" "$ROUTER_DROPIN"
dropin_installed=1
must daemon_reload systemctl daemon-reload
must router_policy verify_router_policy
must router_restart systemctl restart "$ROUTER_SERVICE"

current_before=$(readlink -f "$WEB_CURRENT")
next_link="${WEB_ROOT}/.current-r110.$$"
must current_link ln -s "$SUCCESSOR" "$next_link"
must current_switch replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$ROUTER_SERVICE" && expect_active "$WEB_SERVICE" && browser_ready; then ready=1; break; fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must router_pid_not_restarted test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID_BEFORE"
must protected_changed verify_protected
must static_units_changed verify_static_units
must router_policy verify_router_policy
must pending_daemon_reload verify_no_pending_reload
must current_not_successor test "$(readlink -f "$WEB_CURRENT")" = "$SUCCESSOR"
must successor_changed verify_successor

rm -rf -- /tmp/codex-r110-linux.*
success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'account_manager_process_unchanged=true\n'
printf 'only_8216_web_and_account_router_restarted=true\n'
printf 'failover_max_attempts=16\n'
printf 'semantic_output_replay_forbidden=true\n'
printf 'safari_language_neutral_profile_menu=true\n'
printf 'compact_left_bottom_account_menu=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
