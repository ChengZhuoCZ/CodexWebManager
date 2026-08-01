#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260802-m69-router-r87-materialized-r23
readonly WEB_PREFIX=/opt/0xcaff-codex-web-router
readonly CURRENT="${WEB_PREFIX}/current"
readonly RELEASES="${WEB_PREFIX}/releases"
readonly SUCCESSOR="${RELEASES}/${RELEASE_NAME}"
readonly SOURCE="${RELEASES}/c3e92f0f-20260729-m69-router-r23"
readonly EXPECTED_CURRENT="${RELEASES}/c3e92f0f-20260801-m69-router-r86"
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
readonly ACCOUNT_PID=3693211
readonly ACCOUNT_START=469668415342
readonly ACCOUNT_UNIT_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
readonly WEB_UNIT_SHA256=b9da9a0e095d90cf1e80335e1a6928c5621f22cd85a5fe75d5f65c02c35ce9ee
readonly APP_UNIT_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef

readonly CURRENT_INDEX_SHA256=4c2a7f7ed127570385e44bb9b44a91b63714e15d24906c4756ea3463bfe246dd
readonly CURRENT_APP_SHA256=ff9095a7653d588eb6892b20de079c703dbb5cc01e63663ca7e4e56f4bdfc9a8
readonly CURRENT_PRELOAD_SHA256=d153ef5adef87db419a7499cd95c01c477d1f5919193398f27f9aed7367047c9
readonly SOURCE_INDEX_SHA256=5e89e6e9cb38ebb82fde42526a113458d0072e40bd4cd9f10393a320e793bef9
readonly SOURCE_APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly SOURCE_PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SOURCE_PRELOAD=preload-65708a1c.js
readonly EXPECTED_SOURCE_SYMLINKS=4738

success=0
successor_created=0
current_switched=0
current_before=

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
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]]
  [[ "$(unit_value MainPID codex-web-upstream.service)" == "$STANDALONE_WEB_PID" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic codex-web-upstream.service)" == "$STANDALONE_WEB_START" ]]
  [[ "$(unit_sha256 codex-web-upstream.service)" == "$STANDALONE_WEB_UNIT_SHA256" ]]
  [[ "$(unit_value MainPID codex-web-upstream-app-server.service)" == "$STANDALONE_APP_PID" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic codex-web-upstream-app-server.service)" == "$STANDALONE_APP_START" ]]
  [[ "$(unit_sha256 codex-web-upstream-app-server.service)" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

expect_account_router_unchanged() {
  [[ "$(readlink -f /opt/codex-account-router/current)" == "$ROUTER_CURRENT" ]]
  [[ "$(unit_value MainPID "$ACCOUNT_SERVICE")" == "$ACCOUNT_PID" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ACCOUNT_SERVICE")" == "$ACCOUNT_START" ]]
  [[ "$(unit_sha256 "$ACCOUNT_SERVICE")" == "$ACCOUNT_UNIT_SHA256" ]]
}

expect_units_unchanged() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]]
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]]
  expect_account_router_unchanged
}

expect_no_pending_reload() {
  local unit
  for unit in \
    codex-web-upstream.service \
    codex-web-upstream-app-server.service \
    "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]]
  done
}

verify_release_assets() {
  local root=$1
  local index_sha=$2
  local app_sha=$3
  local preload_sha=$4
  [[ "$(sha256 "${root}/scratch/asar/webview/index.html")" == "$index_sha" ]]
  [[ "$(sha256 "${root}/scratch/asar/webview/assets/app-initial-BTphDPeq.js")" == "$app_sha" ]]
  [[ "$(sha256 "${root}/scratch/asar/webview/assets/${SOURCE_PRELOAD}")" == "$preload_sha" ]]
}

verify_current_assets() {
  [[ "$(sha256 "${EXPECTED_CURRENT}/scratch/asar/webview/index.html")" == "$CURRENT_INDEX_SHA256" ]]
  [[ "$(sha256 "${EXPECTED_CURRENT}/scratch/asar/webview/assets/app-initial-BTphDPeq.js")" == "$CURRENT_APP_SHA256" ]]
  [[ "$(sha256 "${EXPECTED_CURRENT}/scratch/asar/webview/assets/preload-d153ef5a.js")" == "$CURRENT_PRELOAD_SHA256" ]]
}

verify_source_symlinks() {
  local count
  count=$(find "$SOURCE" -type l | wc -l)
  [[ "$count" -eq "$EXPECTED_SOURCE_SYMLINKS" ]]
  ! find "$SOURCE" -type l -printf '%l\n' | grep -v '^/opt/0xcaff-codex-web/current/' | grep -q .
  ! find -L "$SOURCE" -type l -print -quit | grep -q .
}

restart_8216_web_app() {
  systemctl restart "$APP_SERVICE"
  systemctl restart "$WEB_SERVICE"
}

probe_ready() {
  curl -fsS --max-time 1 http://127.0.0.1:18318/readyz >/dev/null &&
    curl -fsS --max-time 1 \
      -H 'Host: 100.95.50.98:8216' \
      -H 'Accept: text/html' \
      http://127.0.0.1:8216/ >/dev/null
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${WEB_PREFIX}/.current-r87-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      replace_current_link "$rollback_link" "$CURRENT"
      restart_8216_web_app >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then
      rm -rf -- "$SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  expect_8215_unchanged || exit_code=1
  expect_account_router_unchanged || exit_code=1
  exit "$exit_code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
must standalone_8215_changed expect_8215_unchanged
must account_router_changed expect_account_router_unchanged
must unit_definition_changed expect_units_unchanged
must pending_daemon_reload expect_no_pending_reload
for unit in \
  codex-web-upstream.service \
  codex-web-upstream-app-server.service \
  "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must current_link_invalid test -L "$CURRENT"
current_before=$(readlink -f "$CURRENT") || {
  printf 'deployment_error=current_link_unresolvable\n' >&2
  exit 1
}
must unexpected_current test "$current_before" = "$EXPECTED_CURRENT"
must current_assets_changed verify_current_assets
must source_not_directory test -d "$SOURCE"
must source_index_or_app_changed verify_release_assets \
  "$SOURCE" "$SOURCE_INDEX_SHA256" "$SOURCE_APP_SHA256" "$SOURCE_PRELOAD_SHA256"
must source_symlink_boundary_changed verify_source_symlinks
must successor_already_exists test ! -e "$SUCCESSOR"

must successor_create_failed mkdir "$SUCCESSOR"
successor_created=1
must materialization_failed cp -aL --reflink=auto "$SOURCE/." "$SUCCESSOR/"
must successor_contains_symlinks test -z "$(find "$SUCCESSOR" -type l -print -quit)"
must successor_index_or_app_changed verify_release_assets \
  "$SUCCESSOR" "$SOURCE_INDEX_SHA256" "$SOURCE_APP_SHA256" "$SOURCE_PRELOAD_SHA256"
must standalone_8215_changed expect_8215_unchanged
must account_router_changed expect_account_router_unchanged

next_link="${WEB_PREFIX}/.current-r87.$$"
must current_link_stage_failed ln -s "$SUCCESSOR" "$next_link"
must current_link_replace_failed replace_current_link "$next_link" "$CURRENT"
current_switched=1
must service_restart_failed restart_8216_web_app

ready=0
for attempt in $(seq 1 "${R87_READY_ATTEMPTS:-50}"); do
  if expect_active "$APP_SERVICE" && expect_active "$WEB_SERVICE" &&
    expect_active "$ACCOUNT_SERVICE" && probe_ready; then
    ready=1
    break
  fi
  sleep "${R87_READY_SLEEP_SECONDS:-0.2}"
done
must readiness_probe_failed test "$ready" -eq 1
must standalone_8215_changed expect_8215_unchanged
must account_router_changed expect_account_router_unchanged
must unit_definition_changed expect_units_unchanged
must pending_daemon_reload expect_no_pending_reload
must current_link_not_successor test "$(readlink -f "$CURRENT")" = "$SUCCESSOR"
must successor_contains_symlinks test -z "$(find "$SUCCESSOR" -type l -print -quit)"

success=1
trap - EXIT
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'materialized_symlinks=%s\n' "$EXPECTED_SOURCE_SYMLINKS"
printf 'account_router_release_unchanged=true\n'
printf 'account_router_process_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
