#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260802-m69-router-r94-manual-switch-recovery
readonly WEB_PREFIX=/opt/0xcaff-codex-web-router
readonly CURRENT="${WEB_PREFIX}/current"
readonly RELEASES="${WEB_PREFIX}/releases"
readonly SUCCESSOR="${RELEASES}/${RELEASE_NAME}"
readonly SOURCE_RELEASE="${RELEASES}/c3e92f0f-20260802-m69-router-r92-server-bridge"
readonly CURRENT_EXPECTED="${RELEASES}/c3e92f0f-20260802-m69-router-r93-manual-switch-recovery"
readonly INSTALLER="${R93_INSTALLER:-/tmp/codex-m69-r93-replace-standalone-router-panel.mjs}"
readonly PANEL_SOURCE="${R93_PANEL_SOURCE:-/tmp/codex-m69-r93-router-account-panel.js}"

readonly INSTALLER_SHA256=d34f58c2cc8a498a6c11aae859b8f74ad0916213c530137895414b095adfe3e4
readonly PREDECESSOR_INDEX_SHA256=f9116342677d6d51fc033fe87779f63b07ea5aca4f30a9e545b262e8a42d28da
readonly SUCCESSOR_INDEX_SHA256=fc7b9819483e7728a2e212de450ab5a85db311acb1ce7b236e2127add8129433
readonly SUCCESSOR_INDEX_GZIP_SHA256=593d64234eeb1c146d6b93783c7997da52f033e67f791c2ac3425b515c98b5a8
readonly SUCCESSOR_INDEX_BROTLI_SHA256=64c45dfa3f6ed21db9f952ff960e3ed32aedf146061a80f178b348868c49c15d
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly PREDECESSOR_PANEL_SHA256=c4f3be1f8122da4f8a2f9da61054c325126af412d5cf09d4ca037e4163e058f9
readonly SUCCESSOR_PANEL_SHA256=ff0f95b4f85fe9174661ca47431222af007047facbf2e5e992eb4040f88aef3d
readonly SUCCESSOR_PANEL_GZIP_SHA256=72f2a2b1c0f18269b55c8002ce5801b50da43df690211dfb98d13c37fecc1a99
readonly SUCCESSOR_PANEL_BROTLI_SHA256=bf6cf6d726e2cb1c151cf03a6691d2a8b01b1de93cce71df7f7f6e89f08714d3
readonly SERVER_MAIN_SHA256=ea69e94c622db32c8d7cc6156d9ffabd5be77ba608b3709eae4928b28c829e67
readonly SESSION_AUTH_SHA256=e8d447dfad97ddef264d013d67cebeb867588ff1e24bf40193012b32b528a92c
readonly ROUTER_BRIDGE_SHA256=185cf83adf11510e2b5c69d3c0652f5c146aa87a56ed97c6028ea2dc62bf3757

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly APP_ASSET=app-initial-BTphDPeq.js
readonly PRELOAD_ASSET=preload-65708a1c.js
readonly PREDECESSOR_PANEL_ASSET=router-account-panel-c4f3be1f.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-ff0f95b4.js

readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.6-linux-x64
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ACCOUNT_SERVICE=codex-account-router.service

readonly STANDALONE_WEB_PID=3664557
readonly STANDALONE_WEB_START=464091607256
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_PID=3664550
readonly STANDALONE_APP_START=464091596213
readonly STANDALONE_APP_UNIT_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3
readonly ROUTED_APP_PID=3791302
readonly ROUTED_APP_START=486542494833
readonly ACCOUNT_PID=3899249
readonly ACCOUNT_START=511063174328
readonly ACCOUNT_UNIT_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
readonly WEB_UNIT_SHA256=b9da9a0e095d90cf1e80335e1a6928c5621f22cd85a5fe75d5f65c02c35ce9ee
readonly APP_UNIT_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef

success=0
successor_created=0
current_switched=0
current_before=
cookie_jar=

sha256() {
  sha256sum "$1" | cut -d ' ' -f 1
}

unit_value() {
  systemctl show -p "$1" --value "$2"
}

unit_sha256() {
  systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1
}

must() {
  local label=$1
  shift
  "$@" || { printf 'deployment_error=%s\n' "$label" >&2; exit 1; }
}

replace_current_link() {
  if mv --help 2>&1 | grep -q -- '-T'; then
    mv -Tf "$1" "$2"
  else
    mv -hf "$1" "$2"
  fi
}

expect_active() {
  [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]
}

expect_8215_unchanged() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID codex-web-upstream.service)" == "$STANDALONE_WEB_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic codex-web-upstream.service)" == "$STANDALONE_WEB_START" ]] || return 1
  [[ "$(unit_sha256 codex-web-upstream.service)" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_value MainPID codex-web-upstream-app-server.service)" == "$STANDALONE_APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic codex-web-upstream-app-server.service)" == "$STANDALONE_APP_START" ]] || return 1
  [[ "$(unit_sha256 codex-web-upstream-app-server.service)" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

expect_protected_8216_processes_unchanged() {
  [[ "$(readlink -f /opt/codex-account-router/current)" == "$ROUTER_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$ROUTED_APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$ROUTED_APP_START" ]] || return 1
  [[ "$(unit_value MainPID "$ACCOUNT_SERVICE")" == "$ACCOUNT_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ACCOUNT_SERVICE")" == "$ACCOUNT_START" ]]
}

expect_units_unchanged() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ACCOUNT_SERVICE")" == "$ACCOUNT_UNIT_SHA256" ]]
}

expect_no_pending_reload() {
  local unit
  for unit in \
    codex-web-upstream.service \
    codex-web-upstream-app-server.service \
    "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_server_assets() {
  local root=$1
  [[ "$(sha256 "${root}/${ASSETS}/${APP_ASSET}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${PRELOAD_ASSET}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$ROUTER_BRIDGE_SHA256" ]]
}

verify_predecessor() {
  verify_server_assets "$SOURCE_RELEASE" || return 1
  [[ "$(sha256 "${SOURCE_RELEASE}/${INDEX}")" == "$PREDECESSOR_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${SOURCE_RELEASE}/${ASSETS}/${PREDECESSOR_PANEL_ASSET}")" == "$PREDECESSOR_PANEL_SHA256" ]] || return 1
  [[ ! -e "${SOURCE_RELEASE}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}" ]]
}

verify_successor() {
  verify_server_assets "$SUCCESSOR" || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}")" == "$SUCCESSOR_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}.gz")" == "$SUCCESSOR_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${INDEX}.br")" == "$SUCCESSOR_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}")" == "$SUCCESSOR_PANEL_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.gz")" == "$SUCCESSOR_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.br")" == "$SUCCESSOR_PANEL_BROTLI_SHA256" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${PREDECESSOR_PANEL_ASSET}" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${PREDECESSOR_PANEL_ASSET}.gz" ]] || return 1
  [[ ! -e "${SUCCESSOR}/${ASSETS}/${PREDECESSOR_PANEL_ASSET}.br" ]] || return 1
  grep -Fq "./assets/${SUCCESSOR_PANEL_ASSET}" "${SUCCESSOR}/${INDEX}" || return 1
  ! grep -Fq "$PREDECESSOR_PANEL_ASSET" "${SUCCESSOR}/${INDEX}"
}

validate_status_json() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!value || value.enabled !== true || !value.router ||
        value.router.architecture_mode !== "LIMITED_MODE" ||
        value.router.cross_account_e2e_verified !== false ||
        !Array.isArray(value.router.accounts) || value.router.accounts.length !== 2 ||
        value.router.active_streams !== 0) process.exit(1);
  '
}

validate_session_json() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!value || typeof value.csrfToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) ||
        typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))) process.exit(1);
  '
}

probe_ready() {
  : >"$cookie_jar"
  curl -fsS --max-time 2 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: text/html' \
    -c "$cookie_jar" \
    http://127.0.0.1:8216/ >/dev/null &&
    curl -fsS --max-time 2 \
      -H 'Host: 100.95.50.98:8216' \
      -H 'Accept: application/json' \
      -b "$cookie_jar" \
      http://127.0.0.1:8216/__backend/session | validate_session_json &&
    curl -fsS --max-time 4 \
      -H 'Host: 100.95.50.98:8216' \
      -H 'Accept: application/json' \
      -b "$cookie_jar" \
      http://127.0.0.1:8216/__backend/codex-router/status | validate_status_json &&
    curl -fsS --max-time 1 http://127.0.0.1:18318/readyz >/dev/null
}

restart_8216_web() {
  systemctl restart "$WEB_SERVICE"
}

rollback() {
  local exit_code=$?
  trap - EXIT
  [[ -z "$cookie_jar" ]] || rm -f -- "$cookie_jar"
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${WEB_PREFIX}/.current-r94-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      replace_current_link "$rollback_link" "$CURRENT"
      restart_8216_web >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then
      rm -rf -- "$SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  expect_8215_unchanged || exit_code=1
  expect_protected_8216_processes_unchanged || exit_code=1
  exit "$exit_code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
cookie_jar=$(mktemp /tmp/m69-r94-cookie.XXXXXX)
must standalone_8215_changed expect_8215_unchanged
must protected_8216_process_changed expect_protected_8216_processes_unchanged
must unit_definition_changed expect_units_unchanged
must pending_daemon_reload expect_no_pending_reload
for unit in \
  codex-web-upstream.service \
  codex-web-upstream-app-server.service \
  "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must current_link_invalid test -L "$CURRENT"
current_before=$(readlink -f "$CURRENT")
must unexpected_current test "$current_before" = "$CURRENT_EXPECTED"
must predecessor_changed verify_predecessor
must predecessor_contains_symlinks test -z "$(find "$SOURCE_RELEASE" -type l -print -quit)"
must installer_changed test "$(sha256 "$INSTALLER")" = "$INSTALLER_SHA256"
must panel_source_changed test "$(sha256 "$PANEL_SOURCE")" = "$SUCCESSOR_PANEL_SHA256"
must successor_already_exists test ! -e "$SUCCESSOR"

must successor_create_failed mkdir "$SUCCESSOR"
successor_created=1
must successor_copy_failed cp -a --reflink=auto "$SOURCE_RELEASE/." "$SUCCESSOR/"
must panel_replacement_failed node "$INSTALLER" \
  --candidate "$SUCCESSOR" \
  --panel-module "$PANEL_SOURCE"
must successor_contains_symlinks test -z "$(find "$SUCCESSOR" -type l -print -quit)"
must successor_changed verify_successor
must standalone_8215_changed expect_8215_unchanged
must protected_8216_process_changed expect_protected_8216_processes_unchanged

next_link="${WEB_PREFIX}/.current-r94.$$"
must current_link_stage_failed ln -s "$SUCCESSOR" "$next_link"
must current_link_replace_failed replace_current_link "$next_link" "$CURRENT"
current_switched=1
must service_restart_failed restart_8216_web

ready=0
for attempt in $(seq 1 "${R93_READY_ATTEMPTS:-50}"); do
  if expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" &&
    expect_active "$ACCOUNT_SERVICE" && probe_ready; then
    ready=1
    break
  fi
  sleep "${R93_READY_SLEEP_SECONDS:-0.2}"
done
must readiness_probe_failed test "$ready" -eq 1
must standalone_8215_changed expect_8215_unchanged
must protected_8216_process_changed expect_protected_8216_processes_unchanged
must unit_definition_changed expect_units_unchanged
must pending_daemon_reload expect_no_pending_reload
must current_link_not_successor test "$(readlink -f "$CURRENT")" = "$SUCCESSOR"
must successor_changed verify_successor

rm -f -- "$cookie_jar"
cookie_jar=
success=1
trap - EXIT
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'account_router_process_unchanged=true\n'
printf 'only_8216_web_restarted=true\n'
printf 'model_request_sent=false\n'
