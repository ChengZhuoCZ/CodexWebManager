#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260802-m69-router-r98-browser-metadata
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_RELEASES="${WEB_ROOT}/releases"
readonly EXPECTED_CURRENT="${WEB_RELEASES}/c3e92f0f-20260802-m69-router-r97-xhr-switch-repair"
readonly SUCCESSOR="${WEB_RELEASES}/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.32-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INSTALLER="${R98_INSTALLER:-/tmp/codex-m69-r98-patch-browser-session-auth.mjs}"
readonly INSTALLER_SHA256=bf62390c99c0c7228c1d39df22e8aabeabc2ca2bdaf7d533802c12f80cb670af
readonly PREDECESSOR_SESSION_AUTH_SHA256=e8d447dfad97ddef264d013d67cebeb867588ff1e24bf40193012b32b528a92c
readonly SUCCESSOR_SESSION_AUTH_SHA256=7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6

readonly INDEX=scratch/asar/webview/index.html
readonly PANEL=scratch/asar/webview/assets/router-account-panel-9db9de1e.js
readonly APP=scratch/asar/webview/assets/app-initial-BTphDPeq.js
readonly PRELOAD=scratch/asar/webview/assets/preload-65708a1c.js
readonly SERVER_MAIN=src/server/main.js
readonly SESSION_AUTH=src/server/browser-session-auth.js
readonly ROUTER_BRIDGE=src/server/router-status-bridge.js

readonly INDEX_SHA256=ea7d3df45107de1d3326643cff399b4f4d76483e4d4d771e1bed0844261f8b09
readonly INDEX_GZIP_SHA256=8bfb82eac3f03b9a39d8022777a7e4946189f2295d5e4ef21d57da528b59c46f
readonly INDEX_BROTLI_SHA256=0ffc4a81d4d705aa96a210100acbd07c832f6aa8fe3e31c509a9b5e8b7828692
readonly PANEL_SHA256=9db9de1e0f47a36888ef74fb0a30f5bad52ab31768bd96824131bfca80e21ab2
readonly PANEL_GZIP_SHA256=ed9cb5ee0004f3acd5115703c3c8cdfd09f35e3accce9b4b3ee6ef89ea35eb60
readonly PANEL_BROTLI_SHA256=1b58020be50da485f88be7a8592a4f5b967f588fccce7c3ecde210cab55e1d74
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SERVER_MAIN_SHA256=ea69e94c622db32c8d7cc6156d9ffabd5be77ba608b3709eae4928b28c829e67
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
current_before=
workdir=
snapshot_complete=0

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

verify_release() {
  local root=$1
  local session_hash=$2
  [[ "$(sha256 "${root}/${INDEX}")" == "$INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${INDEX}.gz")" == "$INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${INDEX}.br")" == "$INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${PANEL}")" == "$PANEL_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${PANEL}.gz")" == "$PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${PANEL}.br")" == "$PANEL_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${APP}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${PRELOAD}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${SERVER_MAIN}")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${SESSION_AUTH}")" == "$session_hash" ]] || return 1
  [[ "$(sha256 "${root}/${ROUTER_BRIDGE}")" == "$ROUTER_BRIDGE_SHA256" ]] || return 1
  [[ -z "$(find "$root" -type l -print -quit)" ]]
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

validate_session() {
  /usr/bin/node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(0,"utf8"));
    if (typeof value?.csrfToken!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) process.exit(1);
    process.stdout.write(value.csrfToken);
  '
}

browser_compat_ready() {
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >/dev/null || return 1
  csrf=$(curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/session | validate_session) || return 1
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status | /usr/bin/node -e '
      const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); const router=value?.router;
      if (!router || router.accounts?.length!==2 || router.active_streams!==0 ||
          router.current_route?.continuity!=="new_backend_session") process.exit(1);
    ' || return 1
  http_code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    -H 'Host: 100.95.50.98:8216' -H 'Origin: http://100.95.50.98:8216' \
    -H 'Content-Type: application/json' -H "x-codex-csrf: $csrf" -b "$workdir/cookies" \
    --data '{"code":"probe_loaded"}' http://127.0.0.1:8216/__backend/startup-diagnostic) || return 1
  [[ "$http_code" == 204 ]] || return 1
  http_code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    -H 'Host: 100.95.50.98:8216' -H 'Sec-Fetch-Site: same-origin' \
    -H 'Content-Type: application/json' -H "x-codex-csrf: $csrf" -b "$workdir/cookies" \
    --data '{"code":"probe_loaded"}' http://127.0.0.1:8216/__backend/startup-diagnostic) || return 1
  [[ "$http_code" == 204 ]] || return 1
  http_code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    -H 'Host: 100.95.50.98:8216' -H 'Origin: http://100.95.50.98:8216' -H 'Sec-Fetch-Site: cross-site' \
    -H 'Content-Type: application/json' -H "x-codex-csrf: $csrf" -b "$workdir/cookies" \
    --data '{"code":"probe_loaded"}' http://127.0.0.1:8216/__backend/startup-diagnostic) || return 1
  [[ "$http_code" == 403 ]]
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r98-rollback.$$"
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
workdir=$(mktemp -d /tmp/m69-r98-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must units_changed verify_units
must pending_daemon_reload verify_no_pending_reload
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must current_changed verify_release "$EXPECTED_CURRENT" "$PREDECESSOR_SESSION_AUTH_SHA256"
must installer_changed test "$(sha256 "$INSTALLER")" = "$INSTALLER_SHA256"
must successor_exists test ! -e "$SUCCESSOR"
snapshot_protected
must protected_changed verify_protected

must successor_create mkdir "$SUCCESSOR"
successor_created=1
must successor_copy cp -a --reflink=auto "$EXPECTED_CURRENT/." "$SUCCESSOR/"
must session_auth_patch /usr/bin/node "$INSTALLER" --candidate "$SUCCESSOR"
must successor_changed verify_release "$SUCCESSOR" "$SUCCESSOR_SESSION_AUTH_SHA256"
must protected_changed verify_protected

current_before=$(readlink -f "$WEB_CURRENT")
next_link="${WEB_ROOT}/.current-r98.$$"
must current_link ln -s "$SUCCESSOR" "$next_link"
must current_switch replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && expect_active "$ROUTER_SERVICE" && browser_compat_ready; then
    ready=1
    break
  fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_unchanged test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must protected_changed verify_protected
must units_changed verify_units
must pending_daemon_reload verify_no_pending_reload
must current_not_successor test "$(readlink -f "$WEB_CURRENT")" = "$SUCCESSOR"
must successor_changed verify_release "$SUCCESSOR" "$SUCCESSOR_SESSION_AUTH_SHA256"

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'account_router_process_unchanged=true\n'
printf 'explicit_cross_site_rejection_preserved=true\n'
printf 'csrf_required=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
