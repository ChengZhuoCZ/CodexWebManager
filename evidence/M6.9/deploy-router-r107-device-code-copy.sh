#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260803-m69-router-r107-device-code-copy
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r106-account-management"
readonly SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.33-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INSTALLER="${R107_INSTALLER:-/tmp/replace-r107-device-code-copy.mjs}"
readonly GENERIC_INSTALLER="${R107_GENERIC_INSTALLER:-/tmp/replace-standalone-router-panel.mjs}"
readonly PANEL_SOURCE="${R107_PANEL_SOURCE:-/tmp/router-account-panel-standalone.js}"
readonly QUOTA_DROPIN=/etc/systemd/system/codex-web-router.service.d/quota-refresh.conf
readonly MANAGER_SERVICE_FRAGMENT=/etc/systemd/system/codex-router-account-manager.service
readonly MANAGER_SOCKET_FRAGMENT=/etc/systemd/system/codex-router-account-manager.socket
readonly INSTALLER_SHA256=16bc2789d902e51e6728942253becce1dd49358106ad7040accc98bbd7a44b6c
readonly GENERIC_INSTALLER_SHA256=e41ef09d15848c2f32e4142558b459ccb1501036ebddd454c91e2b0f4f78ef27
readonly PANEL_SOURCE_SHA256=8324c7accea08eda67fb023abef04ba100093a88f62755e8f0231f1e89f569b8
readonly QUOTA_DROPIN_SHA256=10682643f454b414fb8e51b489b3f87f27ef9a94908e2b659a884d600a7f4c57

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly APP_ASSET=app-initial-BTphDPeq.js
readonly PRELOAD_ASSET=preload-65708a1c.js
readonly SOURCE_PANEL_ASSET=router-account-panel-6c92b532.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-8324c7ac.js
readonly SOURCE_INDEX_SHA256=a3109809feaad204f764b98034657ff336438723526402b182a1940c48a0d45a
readonly SOURCE_INDEX_GZIP_SHA256=f86ec8723cc3f130cc9f0b8f40311df3f6a49e7ea1f32ee3a5fcef8f5512af8b
readonly SOURCE_INDEX_BROTLI_SHA256=a41e0676f0c22643b65ef945d0e3e78235156e58a7a4965732cb8e548a955012
readonly SOURCE_PANEL_SHA256=6c92b5320a91dcd76508552bb93ab75b1a57cb7dfd98503a5740166ec6cc7b4a
readonly SOURCE_PANEL_GZIP_SHA256=93dc2e128dd6f46e956f281a4ddc01a816168ca58f58e32a6c27df0e3233ea88
readonly SOURCE_PANEL_BROTLI_SHA256=96467b6caeb84211c4b1482083e2a659250e1754861ba4e50ed246053a817759
readonly SUCCESSOR_INDEX_SHA256=9e1c07a125878072ea1112c1401d2541295fe8595e2ae0f21ce041365eba11ef
readonly SUCCESSOR_INDEX_GZIP_SHA256=1b63c03a2bf7825279a619705881dad8c43a069f099bc1370483428eec3c89fd
readonly SUCCESSOR_INDEX_BROTLI_SHA256=914993ea31fca561270900fd35baea82a72106fc37ebdc57cf662c00014f6281
readonly SUCCESSOR_PANEL_GZIP_SHA256=350550a45c2d0bd691936d3250922e6207ee0186aac6340de280d53f5be24baf
readonly SUCCESSOR_PANEL_BROTLI_SHA256=75217d57bf187fe4d6c4fc34b6287915717394a0966bcc630a1d10571cc88ede
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SERVER_MAIN_SHA256=e6e932f951b3c3aca875775c1e70984e54af707e368e54bb709e143db0970dfc
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
readonly WEB_UNIT_SHA256=d69e1316de1411ffed0bbfa60f2a58da83b017f91f25ea856e10e9324e571b61
readonly APP_UNIT_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef
readonly ROUTER_UNIT_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
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

verify_units_pre() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_SERVICE_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

verify_units_post() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_SERVICE_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]] || return 1
  [[ -f "$QUOTA_DROPIN" && ! -L "$QUOTA_DROPIN" ]] || return 1
  [[ "$(sha256 "$QUOTA_DROPIN")" == "$QUOTA_DROPIN_SHA256" ]] || return 1
  systemctl show -p Environment --value "$WEB_SERVICE" |
    grep -Fq 'CODEX_ROUTER_QUOTA_ACCOUNT_ALIAS=Primary'
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
  local bridge_sha256=$2
  [[ "$(sha256 "${root}/${ASSETS}/${APP_ASSET}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${PRELOAD_ASSET}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$bridge_sha256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-account-management.js")" == "$ACCOUNT_MANAGEMENT_SHA256" ]]
}

verify_source() {
  verify_common_assets "$EXPECTED_CURRENT" "$ROUTER_BRIDGE_SHA256" || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}")" == "$SOURCE_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}.gz")" == "$SOURCE_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${INDEX}.br")" == "$SOURCE_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${SOURCE_PANEL_ASSET}")" == "$SOURCE_PANEL_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${SOURCE_PANEL_ASSET}.gz")" == "$SOURCE_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${EXPECTED_CURRENT}/${ASSETS}/${SOURCE_PANEL_ASSET}.br")" == "$SOURCE_PANEL_BROTLI_SHA256" ]]
}

verify_successor() {
  verify_common_assets "$SUCCESSOR" "$ROUTER_BRIDGE_SHA256" || return 1
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
    -c "$workdir/cookies" http://127.0.0.1:8216/ >/dev/null || return 1
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status | /usr/bin/node -e '
      const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); const router=value?.router;
      if (!router || router.accounts?.length!==2 || router.active_streams!==0 ||
          router.current_route?.continuity!=="new_backend_session" ||
          !router.accounts.some(account=>account.alias===router.current_route?.account_alias)) process.exit(1);
    '
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r107-rollback.$$"
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
workdir=$(mktemp -d /tmp/m69-r107-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must units_changed verify_units_pre
must pending_daemon_reload verify_no_pending_reload
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must source_changed verify_source
must installer_changed test "$(sha256 "$INSTALLER")" = "$INSTALLER_SHA256"
must generic_installer_changed test "$(sha256 "$GENERIC_INSTALLER")" = "$GENERIC_INSTALLER_SHA256"
must panel_changed test "$(sha256 "$PANEL_SOURCE")" = "$PANEL_SOURCE_SHA256"
must quota_dropin_changed test "$(sha256 "$QUOTA_DROPIN")" = "$QUOTA_DROPIN_SHA256"
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
next_link="${WEB_ROOT}/.current-r107.$$"
must current_link ln -s "$SUCCESSOR" "$next_link"
must current_switch replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && expect_active "$ROUTER_SERVICE" && \
    expect_active "$MANAGER_SERVICE" && expect_active "$MANAGER_SOCKET" && browser_ready; then
    ready=1
    break
  fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must protected_changed verify_protected
must units_changed verify_units_post
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
printf 'copy_device_code_fallback=true\n'
printf 'clipboard_secure_context_not_required=true\n'
printf 'fixed_app_host_identity_unchanged=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
