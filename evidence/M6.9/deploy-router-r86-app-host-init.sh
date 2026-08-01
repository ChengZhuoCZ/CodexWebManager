#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260801-m69-router-r86
readonly ARCHIVE=/tmp/codex-m69-r86-static-overlay.tar.gz
readonly ARCHIVE_SHA256=6b5b1b03e7f7c1c0904700c971a603f963805230a5e0bb30df45a55d6751639d
readonly WEB_PREFIX=/opt/0xcaff-codex-web-router
readonly CURRENT="${WEB_PREFIX}/current"
readonly RELEASES="${WEB_PREFIX}/releases"
readonly SUCCESSOR="${RELEASES}/${RELEASE_NAME}"
readonly EXPECTED_PREDECESSOR="${RELEASES}/c3e92f0f-20260801-m69-router-r85"
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
readonly PREDECESSOR_INDEX_SHA256=58065cc870f6280a2d7c91ce2ae0d87df2bad9e303b0fc9ce30ced431195b2c4
readonly PREDECESSOR_APP_SHA256=80c20671f32cdc918592883e4235c1857cdbc939d906ed69cc25f18d509cd199

success=0
successor_created=0
current_switched=0
current_before=

sha256() {
  sha256sum "$1" | awk '{print $1}'
}

unit_value() {
  systemctl show -p "$1" --value "$2"
}

unit_sha256() {
  systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | awk '{print $1}'
}

must() {
  local label=$1
  shift
  "$@" || { printf 'deployment_error=%s\n' "$label" >&2; exit 1; }
}

copy_release_tree() {
  if cp --help 2>&1 | grep -q reflink; then
    cp -a --reflink=auto "$1" "$2"
  else
    cp -a "$1" "$2"
  fi
}

replace_current_link() {
  if mv --help 2>&1 | grep -q -- '-T'; then
    mv -Tf "$1" "$2"
  else
    mv -hf "$1" "$2"
  fi
}

expect_8215_unchanged() {
  [[ "$(unit_value MainPID codex-web-upstream.service)" == "$STANDALONE_WEB_PID" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic codex-web-upstream.service)" == "$STANDALONE_WEB_START" ]]
  [[ "$(unit_sha256 codex-web-upstream.service)" == "$STANDALONE_WEB_UNIT_SHA256" ]]
  [[ "$(unit_value MainPID codex-web-upstream-app-server.service)" == "$STANDALONE_APP_PID" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic codex-web-upstream-app-server.service)" == "$STANDALONE_APP_START" ]]
  [[ "$(unit_sha256 codex-web-upstream-app-server.service)" == "$STANDALONE_APP_UNIT_SHA256" ]]
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

expect_active() {
  [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]
}

probe_ready() {
  curl -fsS --max-time 1 http://127.0.0.1:18318/readyz >/dev/null &&
    curl -fsS --max-time 1 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' http://127.0.0.1:8216/ >/dev/null
}

restart_8216() {
  systemctl restart "$ACCOUNT_SERVICE"
  systemctl restart "$APP_SERVICE"
  systemctl restart "$WEB_SERVICE"
}

verify_successor_assets() {
  [[ "$(sha256 "${SUCCESSOR}/scratch/asar/webview/index.html")" == 4c2a7f7ed127570385e44bb9b44a91b63714e15d24906c4756ea3463bfe246dd ]]
  [[ "$(sha256 "${SUCCESSOR}/scratch/asar/webview/index.html.gz")" == 45b3454d9081d603a79db2e3c97706606b1778e7a6dcf8c9f7815e6b72c3d9a7 ]]
  [[ "$(sha256 "${SUCCESSOR}/scratch/asar/webview/index.html.br")" == a7b600f2b8fe59a3ccad0ed9cdd2815bcc862b0abb60c0232f5d619c99e1f5ad ]]
  [[ "$(sha256 "${SUCCESSOR}/scratch/asar/webview/assets/app-initial-BTphDPeq.js")" == ff9095a7653d588eb6892b20de079c703dbb5cc01e63663ca7e4e56f4bdfc9a8 ]]
  [[ "$(sha256 "${SUCCESSOR}/scratch/asar/webview/assets/app-initial-BTphDPeq.js.gz")" == 5c2ebff5edbb46b68e640669434677f9d5a0586bd3015397268c53f821ec9886 ]]
  [[ "$(sha256 "${SUCCESSOR}/scratch/asar/webview/assets/app-initial-BTphDPeq.js.br")" == 89da014d001bb830fa86ddeeda3f93cd8651fa292bd9a792a81c839b09776132 ]]
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${WEB_PREFIX}/.current-r86-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      replace_current_link "$rollback_link" "$CURRENT"
      restart_8216 >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then
      rm -rf -- "$SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  expect_8215_unchanged || exit_code=1
  exit "$exit_code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
must standalone_8215_changed expect_8215_unchanged
must pending_daemon_reload expect_no_pending_reload
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must archive_hash_mismatch test "$(sha256 "$ARCHIVE")" = "$ARCHIVE_SHA256"
must current_link_invalid test -L "$CURRENT"
must successor_already_exists test ! -e "$SUCCESSOR"
current_before=$(readlink -f "$CURRENT") || { printf 'deployment_error=current_link_unresolvable\n' >&2; exit 1; }
must unexpected_web_predecessor test "$current_before" = "$EXPECTED_PREDECESSOR"
must predecessor_index_changed test "$(sha256 "${current_before}/scratch/asar/webview/index.html")" = "$PREDECESSOR_INDEX_SHA256"
must predecessor_app_changed test "$(sha256 "${current_before}/scratch/asar/webview/assets/app-initial-BTphDPeq.js")" = "$PREDECESSOR_APP_SHA256"
must router_release_changed test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"

expected_entries=(
  scratch/asar/webview/index.html
  scratch/asar/webview/index.html.gz
  scratch/asar/webview/index.html.br
  scratch/asar/webview/assets/app-initial-BTphDPeq.js
  scratch/asar/webview/assets/app-initial-BTphDPeq.js.gz
  scratch/asar/webview/assets/app-initial-BTphDPeq.js.br
)
mapfile -t archive_entries < <(tar -tzf "$ARCHIVE")
must archive_entry_count_mismatch test "${#archive_entries[@]}" -eq "${#expected_entries[@]}"
for index in "${!expected_entries[@]}"; do
  must "archive_entry_mismatch_${index}" test "${archive_entries[$index]}" = "${expected_entries[$index]}"
done
must archive_permissions_invalid bash -c "tar -tvzf '$ARCHIVE' | awk '\$1 !~ /^-/ { exit 1 }'"

must successor_copy_failed copy_release_tree "$current_before" "$SUCCESSOR"
successor_created=1
must successor_extract_failed tar --no-same-owner -xzf "$ARCHIVE" -C "$SUCCESSOR"
must successor_assets_invalid verify_successor_assets

next_link="${WEB_PREFIX}/.current-r86.$$"
must current_link_stage_failed ln -s "$SUCCESSOR" "$next_link"
must current_link_replace_failed replace_current_link "$next_link" "$CURRENT"
current_switched=1
must service_restart_failed restart_8216

ready=0
for attempt in $(seq 1 "${R86_READY_ATTEMPTS:-30}"); do
  if expect_active "$ACCOUNT_SERVICE" && expect_active "$APP_SERVICE" && expect_active "$WEB_SERVICE" && probe_ready; then
    ready=1
    break
  fi
  sleep "${R86_READY_SLEEP_SECONDS:-0.2}"
done
must readiness_probe_failed test "$ready" -eq 1
must standalone_8215_changed expect_8215_unchanged
must pending_daemon_reload expect_no_pending_reload
must current_link_not_successor test "$(readlink -f "$CURRENT")" = "$(readlink -f "$SUCCESSOR")"
must router_release_changed test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"

success=1
trap - EXIT
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'account_router_release_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
