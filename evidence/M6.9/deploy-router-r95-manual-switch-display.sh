#!/usr/bin/env bash
set -euo pipefail

readonly WEB_RELEASE_NAME=c3e92f0f-20260802-m69-router-r95-manual-switch-display
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_RELEASES="${WEB_ROOT}/releases"
readonly WEB_SOURCE="${WEB_RELEASES}/c3e92f0f-20260802-m69-router-r92-server-bridge"
readonly WEB_EXPECTED_CURRENT="${WEB_RELEASES}/c3e92f0f-20260802-m69-router-r94-manual-switch-recovery"
readonly WEB_SUCCESSOR="${WEB_RELEASES}/${WEB_RELEASE_NAME}"

readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_EXPECTED_CURRENT="${ROUTER_ROOT}/releases/codex-account-router-0.2.6-linux-x64"
readonly ROUTER_RELEASE_NAME=codex-account-router-0.2.32-linux-x64
readonly ROUTER_SUCCESSOR="${ROUTER_ROOT}/releases/${ROUTER_RELEASE_NAME}"

readonly ROUTER_ARCHIVE="${R95_ROUTER_ARCHIVE:-/tmp/codex-account-router-0.2.32-linux-x64.tar.gz}"
readonly PANEL_INSTALLER="${R95_PANEL_INSTALLER:-/tmp/codex-m69-r95-replace-standalone-router-panel.mjs}"
readonly PANEL_SOURCE="${R95_PANEL_SOURCE:-/tmp/codex-m69-r95-router-account-panel.js}"

readonly ROUTER_ARCHIVE_SHA256=84f9cf065d7ef1f72cd12fc9fb0d4f1f8a7cb9a27a86b895a8118ee45d78f449
readonly PANEL_INSTALLER_SHA256=b5f1fafec60af13fab408200939fe7bb4dc40be0876fcee2c1c26bec4efe1631
readonly PANEL_SOURCE_SHA256=8a0772e986abc68ffa48fe98356f43d27cb8916676ee1fb43664c29ba4626aeb

readonly SOURCE_INDEX_SHA256=f9116342677d6d51fc033fe87779f63b07ea5aca4f30a9e545b262e8a42d28da
readonly CURRENT_INDEX_SHA256=fc7b9819483e7728a2e212de450ab5a85db311acb1ce7b236e2127add8129433
readonly SUCCESSOR_INDEX_SHA256=2d93f1a077cad2abceefdf43590029ae419c44d623bcb3a337dde702f080f1c1
readonly SUCCESSOR_INDEX_GZIP_SHA256=14aa4e5b6f7f20baf6ba4d9f2ad7d9a1ecac64f5f9060f59ec9a30fb268264c2
readonly SUCCESSOR_INDEX_BROTLI_SHA256=8405c0437c501a5da59cf26fc8bb99d44b77c45b2542e5b2ffb0e504707ddfe4
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SOURCE_PANEL_SHA256=c4f3be1f8122da4f8a2f9da61054c325126af412d5cf09d4ca037e4163e058f9
readonly CURRENT_PANEL_SHA256=ff0f95b4f85fe9174661ca47431222af007047facbf2e5e992eb4040f88aef3d
readonly SUCCESSOR_PANEL_GZIP_SHA256=fcb396304207ada14742776dbe97a6e9b691049f8c7d5bc2d7cb05bf680c44cf
readonly SUCCESSOR_PANEL_BROTLI_SHA256=8f10b8c841b68b46e975f7051ea21ebe83dd8c1e994817b6c13fec916e08ba96
readonly SERVER_MAIN_SHA256=ea69e94c622db32c8d7cc6156d9ffabd5be77ba608b3709eae4928b28c829e67
readonly SESSION_AUTH_SHA256=e8d447dfad97ddef264d013d67cebeb867588ff1e24bf40193012b32b528a92c
readonly ROUTER_BRIDGE_SHA256=185cf83adf11510e2b5c69d3c0652f5c146aa87a56ed97c6028ea2dc62bf3757

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly APP_ASSET=app-initial-BTphDPeq.js
readonly PRELOAD_ASSET=preload-65708a1c.js
readonly SOURCE_PANEL_ASSET=router-account-panel-c4f3be1f.js
readonly CURRENT_PANEL_ASSET=router-account-panel-ff0f95b4.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-8a0772e9.js

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly WEB_UNIT_SHA256=b9da9a0e095d90cf1e80335e1a6928c5621f22cd85a5fe75d5f65c02c35ce9ee
readonly APP_UNIT_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef
readonly ROUTER_UNIT_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_UNIT_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3

working_directory=
web_current_before=
router_current_before=
web_successor_created=0
web_current_switched=0
router_current_switched=0
router_restarted=0
success=0

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

replace_link() {
  local staged=$1
  local target=$2
  if mv --help 2>&1 | grep -q -- '-T'; then
    mv -Tf "$staged" "$target"
  else
    mv -hf "$staged" "$target"
  fi
}

expect_active() {
  [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]
}

snapshot_protected_services() {
  readonly STANDALONE_WEB_PID_BEFORE="$(unit_value MainPID "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_WEB_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_APP_PID_BEFORE="$(unit_value MainPID "$STANDALONE_APP_SERVICE")"
  readonly STANDALONE_APP_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")"
  readonly ROUTED_APP_PID_BEFORE="$(unit_value MainPID "$APP_SERVICE")"
  readonly ROUTED_APP_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")"
}

expect_protected_services_unchanged() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$ROUTED_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$ROUTED_APP_START_BEFORE" ]]
}

expect_units_unchanged() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

expect_no_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
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

verify_web_inputs() {
  verify_server_assets "$WEB_SOURCE" || return 1
  verify_server_assets "$WEB_EXPECTED_CURRENT" || return 1
  [[ "$(sha256 "${WEB_SOURCE}/${INDEX}")" == "$SOURCE_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_SOURCE}/${ASSETS}/${SOURCE_PANEL_ASSET}")" == "$SOURCE_PANEL_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_EXPECTED_CURRENT}/${INDEX}")" == "$CURRENT_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_EXPECTED_CURRENT}/${ASSETS}/${CURRENT_PANEL_ASSET}")" == "$CURRENT_PANEL_SHA256" ]]
}

verify_web_successor() {
  verify_server_assets "$WEB_SUCCESSOR" || return 1
  [[ "$(sha256 "${WEB_SUCCESSOR}/${INDEX}")" == "$SUCCESSOR_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_SUCCESSOR}/${INDEX}.gz")" == "$SUCCESSOR_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_SUCCESSOR}/${INDEX}.br")" == "$SUCCESSOR_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}")" == "$PANEL_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.gz")" == "$SUCCESSOR_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_SUCCESSOR}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.br")" == "$SUCCESSOR_PANEL_BROTLI_SHA256" ]] || return 1
  [[ ! -e "${WEB_SUCCESSOR}/${ASSETS}/${SOURCE_PANEL_ASSET}" ]] || return 1
  [[ ! -e "${WEB_SUCCESSOR}/${ASSETS}/${CURRENT_PANEL_ASSET}" ]] || return 1
  grep -Fq "./assets/${SUCCESSOR_PANEL_ASSET}" "${WEB_SUCCESSOR}/${INDEX}"
}

ready_router() {
  curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:18318/readyz 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
      const value = JSON.parse(input);
      if (value?.status !== "ready" || !Number.isSafeInteger(value.usable_accounts) ||
          value.usable_accounts < 1) process.exit(1);
    });
  ' 2>/dev/null
}

start_browser_session() {
  : >"${working_directory}/cookies"
  curl --noproxy '*' -fsS --max-time 3 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "${working_directory}/cookies" http://127.0.0.1:8216/ >/dev/null
  curl --noproxy '*' -fsS --max-time 3 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "${working_directory}/cookies" -c "${working_directory}/cookies" \
    http://127.0.0.1:8216/__backend/session >"${working_directory}/session.json"
  INPUT_SESSION="${working_directory}/session.json" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_SESSION, "utf8"));
    if (typeof value?.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) process.exit(1);
  '
}

browser_status() {
  local output=$1
  curl --noproxy '*' -fsS --max-time 5 \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "${working_directory}/cookies" \
    http://127.0.0.1:8216/__backend/codex-router/status >"$output"
}

assert_status() {
  local input=$1
  local expected_route=$2
  INPUT_STATUS="$input" EXPECTED_ROUTE="$expected_route" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_STATUS, "utf8"));
    const router = value?.router;
    if (!router || router.active_streams !== 0 || router.accounts?.length !== 2 ||
        router.current_route?.account_alias !== process.env.EXPECTED_ROUTE ||
        router.current_route?.continuity !== "new_backend_session") process.exit(1);
  '
}

switch_alias() {
  local alias=$1
  local slug=$2
  local csrf
  csrf=$(INPUT_SESSION="${working_directory}/session.json" node -e '
    const fs = require("node:fs");
    process.stdout.write(JSON.parse(fs.readFileSync(process.env.INPUT_SESSION, "utf8")).csrfToken);
  ')
  printf '{"account_alias":"%s","reason":"manual"}' "$alias" >"${working_directory}/request-${slug}.json"
  curl --noproxy '*' -fsS --max-time 8 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -H 'Origin: http://100.95.50.98:8216' -H 'Sec-Fetch-Site: same-origin' \
    -H "x-codex-csrf: ${csrf}" -b "${working_directory}/cookies" \
    --data-binary "@${working_directory}/request-${slug}.json" \
    http://127.0.0.1:8216/__backend/codex-router/switch >"${working_directory}/switch-${slug}.json"
  INPUT_SWITCH="${working_directory}/switch-${slug}.json" EXPECTED_ALIAS="$alias" node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.env.INPUT_SWITCH, "utf8"));
    if (value?.accepted !== true || value.account_alias !== process.env.EXPECTED_ALIAS ||
        value.continuity !== "new_backend_session") process.exit(1);
  '
}

manual_switch_roundtrip() {
  local status_file="${working_directory}/status.json"
  start_browser_session || return 1
  browser_status "$status_file" || return 1
  INPUT_STATUS="$status_file" node -e '
    const fs = require("node:fs");
    const router = JSON.parse(fs.readFileSync(process.env.INPUT_STATUS, "utf8"))?.router;
    if (!router || router.active_streams !== 0 || router.accounts?.length !== 2) process.exit(1);
  ' || return 1
  switch_alias Primary primary || return 1
  browser_status "$status_file" || return 1
  assert_status "$status_file" Primary || return 1
  switch_alias Secondary secondary || return 1
  browser_status "$status_file" || return 1
  assert_status "$status_file" Secondary
}

emit_readiness_diagnostic() {
  local router_http
  local web_http
  router_http=$(curl --noproxy '*' -sS --max-time 3 -o "${working_directory}/readyz.json" \
    -w '%{http_code}' http://127.0.0.1:18318/readyz 2>/dev/null || true)
  web_http=$(curl --noproxy '*' -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    -H 'Host: 100.95.50.98:8216' http://127.0.0.1:8216/ 2>/dev/null || true)
  printf 'diagnostic_router_unit=%s\n' "$(systemctl is-active "$ROUTER_SERVICE" 2>/dev/null || true)"
  printf 'diagnostic_web_unit=%s\n' "$(systemctl is-active "$WEB_SERVICE" 2>/dev/null || true)"
  printf 'diagnostic_app_unit=%s\n' "$(systemctl is-active "$APP_SERVICE" 2>/dev/null || true)"
  printf 'diagnostic_web_http=%s\n' "${web_http:-000}"
  if [[ -s "${working_directory}/readyz.json" ]]; then
    INPUT_READY="${working_directory}/readyz.json" ROUTER_HTTP="${router_http:-000}" node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.env.INPUT_READY, "utf8"));
      console.log(`diagnostic_router_http=${process.env.ROUTER_HTTP}`);
      console.log(`diagnostic_router_status=${value?.status ?? "unknown"}`);
      console.log(`diagnostic_router_reason=${value?.reason ?? "none"}`);
      console.log(`diagnostic_router_usable_accounts=${Number.isSafeInteger(value?.usable_accounts) ? value.usable_accounts : "unknown"}`);
    ' || true
  else
    printf 'diagnostic_router_http=%s\n' "${router_http:-000}"
  fi
}

restore_router_state() {
  systemctl stop "$ROUTER_SERVICE" >/dev/null 2>&1 || true
  if [[ -f "${working_directory}/circuit-state.json" ]]; then
    cp -a "${working_directory}/circuit-state.json" /var/lib/codex-account-router/circuit-state.json
  fi
  if [[ -f "${working_directory}/routing-state.json" ]]; then
    cp -a "${working_directory}/routing-state.json" /var/lib/codex-account-router/routing-state.json
  else
    rm -f -- /var/lib/codex-account-router/routing-state.json
  fi
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$web_current_switched" -eq 1 && -n "$web_current_before" ]]; then
      local web_link="${WEB_ROOT}/.current-r95-rollback.$$"
      ln -s "$web_current_before" "$web_link"
      replace_link "$web_link" "$WEB_CURRENT"
      systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$router_current_switched" -eq 1 && -n "$router_current_before" ]]; then
      restore_router_state
      local router_link="${ROUTER_ROOT}/.current-r95-rollback.$$"
      ln -s "$router_current_before" "$router_link"
      replace_link "$router_link" "$ROUTER_CURRENT"
      systemctl start "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$web_successor_created" -eq 1 ]]; then
      rm -rf -- "$WEB_SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  if [[ -n "$working_directory" ]]; then rm -rf -- "$working_directory"; fi
  expect_protected_services_unchanged || exit_code=1
  exit "$exit_code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
working_directory=$(mktemp -d /tmp/m69-r95-deploy.XXXXXX)

for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must units_changed expect_units_unchanged
must pending_daemon_reload expect_no_pending_reload
must standalone_current_changed test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must web_current_changed test "$(readlink -f "$WEB_CURRENT")" = "$WEB_EXPECTED_CURRENT"
must router_current_changed test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_EXPECTED_CURRENT"
must web_inputs_changed verify_web_inputs
must router_archive_changed test "$(sha256 "$ROUTER_ARCHIVE")" = "$ROUTER_ARCHIVE_SHA256"
must panel_installer_changed test "$(sha256 "$PANEL_INSTALLER")" = "$PANEL_INSTALLER_SHA256"
must panel_source_changed test "$(sha256 "$PANEL_SOURCE")" = "$PANEL_SOURCE_SHA256"
must web_successor_exists test ! -e "$WEB_SUCCESSOR"

snapshot_protected_services
must protected_service_changed expect_protected_services_unchanged
web_current_before=$(readlink -f "$WEB_CURRENT")
router_current_before=$(readlink -f "$ROUTER_CURRENT")
cp -a /var/lib/codex-account-router/circuit-state.json "${working_directory}/circuit-state.json"
if [[ -f /var/lib/codex-account-router/routing-state.json ]]; then
  cp -a /var/lib/codex-account-router/routing-state.json "${working_directory}/routing-state.json"
fi

must web_successor_create mkdir "$WEB_SUCCESSOR"
web_successor_created=1
must web_successor_copy cp -a --reflink=auto "$WEB_SOURCE/." "$WEB_SUCCESSOR/"
must panel_replace node "$PANEL_INSTALLER" --candidate "$WEB_SUCCESSOR" --panel-module "$PANEL_SOURCE"
must web_successor_symlink test -z "$(find "$WEB_SUCCESSOR" -type l -print -quit)"
must web_successor_changed verify_web_successor

must router_archive_layout bash -c '
  set -o pipefail
  tar -tzf "$1" | while IFS= read -r entry; do
    case "$entry" in
      codex-account-router-0.2.32-linux-x64|codex-account-router-0.2.32-linux-x64/*) ;;
      *) exit 1 ;;
    esac
  done
' _ "$ROUTER_ARCHIVE"
must router_archive_type bash -c 'tar -tvzf "$1" | awk '\''$1 !~ /^[-d]/ { exit 1 }'\''' _ "$ROUTER_ARCHIVE"
must router_extract tar --no-same-owner -xzf "$ROUTER_ARCHIVE" -C "$working_directory"
must router_manifest_version test "$(node -p "require('${working_directory}/${ROUTER_RELEASE_NAME}/lib/account-router/package.json').version")" = 0.2.32

web_link="${WEB_ROOT}/.current-r95.$$"
must web_link_stage ln -s "$WEB_SUCCESSOR" "$web_link"
must web_link_switch replace_link "$web_link" "$WEB_CURRENT"
web_current_switched=1

must router_install env PREFIX="$ROUTER_ROOT" sh "${working_directory}/${ROUTER_RELEASE_NAME}/install.sh"
router_current_switched=1
must router_link_changed test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_SUCCESSOR"

must router_restart systemctl restart "$ROUTER_SERVICE"
router_restarted=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$ROUTER_SERVICE" && expect_active "$WEB_SERVICE" && \
    expect_active "$APP_SERVICE" && ready_router && \
    start_browser_session >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then emit_readiness_diagnostic; fi
must readiness_failed test "$ready" -eq 1
must manual_switch_roundtrip_failed manual_switch_roundtrip
must route_not_restored_secondary browser_status "${working_directory}/final-status.json"
must route_not_restored_secondary assert_status "${working_directory}/final-status.json" Secondary
must protected_service_changed expect_protected_services_unchanged
must units_changed expect_units_unchanged
must pending_daemon_reload expect_no_pending_reload
must web_current_not_successor test "$(readlink -f "$WEB_CURRENT")" = "$WEB_SUCCESSOR"
must router_current_not_successor test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_SUCCESSOR"
must web_successor_changed verify_web_successor

success=1
trap - EXIT
rm -rf -- "$working_directory"
printf 'deployment_status=success\n'
printf 'web_release=%s\n' "$WEB_RELEASE_NAME"
printf 'router_release=%s\n' "$ROUTER_RELEASE_NAME"
printf 'manual_switch_primary_accepted=true\n'
printf 'manual_switch_secondary_restored=true\n'
printf 'continuity=new_backend_session\n'
printf 'model_request_sent=false\n'
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
