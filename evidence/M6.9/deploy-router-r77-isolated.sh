#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY=/srv/codex-workspaces/CodexWebManager-8216-fixture
readonly RELEASE_NAME=c3e92f0f-20260801-m69-router-r77
readonly PRODUCTION_ARCHIVE=/tmp/codex-m69-r72-web-overlay.tar.gz
readonly PRODUCTION_ARCHIVE_SHA256=6a8060aaf32c67190412d0f97e9b57da9e89638143ec76484da9927dc00744b9
readonly WEB_UNIT_SHA256=5aa4a2bf9951c90a871963b7a683d6922e5906967fa0de698ae199bf1f5b0159
readonly APP_UNIT_SHA256=983b71a39bec32bdb1c9c74f0cd203f4c70e4f08ca4c8549df87fe8e29b141ad
readonly OLD_WEB_UNIT_SHA256=10100946bc7a6fbe1ffab7b60092179d3547b48dd4343f13aecd13371d423693
readonly OLD_APP_UNIT_SHA256=dd439dece450f99fb8d1ecd2731fbe8d21ea40661c8144e8edf7992045367160
readonly ACCOUNT_UNIT_SHA256=5c7aba18c5c658aa3c7e2d48b555a7404aa6d826d35c93b860011ec93b42a4f3
readonly WEB_ISOLATION_SHA256=8709f17a6a2fffacd00878f66a493d021f6507042b447f256254ef43283f54c3
readonly APP_ISOLATION_SHA256=7b62e8dacfa6c027f579428c6079166d8fbedb9cdfcb5c13d0a6529b6a92981d
readonly ACCOUNT_ISOLATION_SHA256=7ba619a29c73dff4185c7c853a4c168485a14c9574847e52a411853e510bc9d5
readonly STANDALONE_WEB_PID=3522733
readonly STANDALONE_WEB_START=451372467525
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_PID=3522725
readonly STANDALONE_APP_START=451372452251
readonly STANDALONE_APP_UNIT_SHA256=662de56df5c27359cdd6e567169f28e517727c761c46fb4b7abeb274c21d099e
readonly EXPECTED_ROUTER_RELEASE=/opt/codex-account-router/releases/codex-account-router-0.2.6-linux-x64
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ACCOUNT_SERVICE=codex-account-router.service

fixture_root=${R77_FIXTURE_ROOT:-}
if [[ -n "$fixture_root" ]]; then
  [[ $EUID -ne 0 ]]
  [[ "$fixture_root" == /tmp/* && -d "$fixture_root" && ! -L "$fixture_root" ]]
  readonly WEB_PREFIX="${fixture_root}/opt/0xcaff-codex-web-router"
  readonly ROUTER_PREFIX="${fixture_root}/opt/codex-account-router"
  readonly UNIT_ROOT="${fixture_root}/etc/systemd/system"
  readonly ARCHIVE=${R77_ARCHIVE:?}
  readonly ARCHIVE_SHA256=${R77_ARCHIVE_SHA256:?}
  readonly SYSTEMCTL=${R77_SYSTEMCTL:?}
  readonly REPO_ROOT=$PWD
  readonly EXPECTED_WEB_BASE_SHA256=${R77_OLD_WEB_UNIT_SHA256:?}
  readonly EXPECTED_APP_BASE_SHA256=${R77_OLD_APP_UNIT_SHA256:?}
  readonly EXPECTED_ACCOUNT_BASE_SHA256=${R77_ACCOUNT_UNIT_SHA256:?}
  readonly EXPECTED_WEB_ISOLATION_SHA256=${R77_WEB_ISOLATION_SHA256:?}
  readonly EXPECTED_APP_ISOLATION_SHA256=${R77_APP_ISOLATION_SHA256:?}
  readonly EXPECTED_ACCOUNT_ISOLATION_SHA256=${R77_ACCOUNT_ISOLATION_SHA256:?}
  readonly EXPECTED_ROUTER_CURRENT="${ROUTER_PREFIX}/releases/codex-account-router-0.2.6-linux-x64"
else
  [[ $EUID -eq 0 ]]
  readonly WEB_PREFIX=/opt/0xcaff-codex-web-router
  readonly ROUTER_PREFIX=/opt/codex-account-router
  readonly UNIT_ROOT=/etc/systemd/system
  readonly ARCHIVE=$PRODUCTION_ARCHIVE
  readonly ARCHIVE_SHA256=$PRODUCTION_ARCHIVE_SHA256
  readonly SYSTEMCTL=/usr/bin/systemctl
  readonly REPO_ROOT=$REPOSITORY
  readonly EXPECTED_WEB_BASE_SHA256=$OLD_WEB_UNIT_SHA256
  readonly EXPECTED_APP_BASE_SHA256=$OLD_APP_UNIT_SHA256
  readonly EXPECTED_ACCOUNT_BASE_SHA256=$ACCOUNT_UNIT_SHA256
  readonly EXPECTED_WEB_ISOLATION_SHA256=$WEB_ISOLATION_SHA256
  readonly EXPECTED_APP_ISOLATION_SHA256=$APP_ISOLATION_SHA256
  readonly EXPECTED_ACCOUNT_ISOLATION_SHA256=$ACCOUNT_ISOLATION_SHA256
  readonly EXPECTED_ROUTER_CURRENT=$EXPECTED_ROUTER_RELEASE
fi

readonly CURRENT="${WEB_PREFIX}/current"
readonly RELEASES="${WEB_PREFIX}/releases"
readonly SUCCESSOR="${RELEASES}/${RELEASE_NAME}"
readonly ROUTER_CURRENT="${ROUTER_PREFIX}/current"
readonly WEB_UNIT_SOURCE="${REPO_ROOT}/systemd/8216-fixture/codex-web-router.service"
readonly APP_UNIT_SOURCE="${REPO_ROOT}/systemd/8216-fixture/codex-web-router-app-server.service"
readonly WEB_UNIT_TARGET="${UNIT_ROOT}/codex-web-router.service"
readonly APP_UNIT_TARGET="${UNIT_ROOT}/codex-web-router-app-server.service"
readonly ACCOUNT_UNIT_TARGET="${UNIT_ROOT}/codex-account-router.service"
readonly WEB_ISOLATION="${UNIT_ROOT}/codex-web-router.service.d/8216-isolation.conf"
readonly APP_ISOLATION="${UNIT_ROOT}/codex-web-router-app-server.service.d/8216-isolation.conf"
readonly ACCOUNT_ISOLATION="${UNIT_ROOT}/codex-account-router.service.d/8216-isolation.conf"

success=0
successor_created=0
current_switched=0
units_installed=0
backup_directory=
current_before=
router_current_before=

sha256() {
  sha256sum "$1" | awk '{print $1}'
}

unit_value() {
  "$SYSTEMCTL" show -p "$1" --value "$2"
}

unit_sha256() {
  "$SYSTEMCTL" cat "$1" --no-pager 2>/dev/null | sha256sum | awk '{print $1}'
}

expect_8215_unchanged() {
  if [[ -n "$fixture_root" ]]; then
    return 0
  fi
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
    "$WEB_SERVICE" \
    "$APP_SERVICE" \
    "$ACCOUNT_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]]
  done
}

expect_isolation_files() {
  [[ "$(sha256 "$WEB_ISOLATION")" == "$EXPECTED_WEB_ISOLATION_SHA256" ]]
  [[ "$(sha256 "$APP_ISOLATION")" == "$EXPECTED_APP_ISOLATION_SHA256" ]]
  [[ "$(sha256 "$ACCOUNT_ISOLATION")" == "$EXPECTED_ACCOUNT_ISOLATION_SHA256" ]]
}

expect_8216_runtime_isolation() {
  if [[ -n "$fixture_root" ]]; then
    return 0
  fi
  local unit environment
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
    [[ "$(unit_value User "$unit")" == codex8216 ]]
    [[ "$(unit_value Group "$unit")" == codex8216 ]]
    [[ "$(unit_value Slice "$unit")" == codex-8216.slice ]]
  done
  [[ "$(unit_value WorkingDirectory "$WEB_SERVICE")" == "$REPOSITORY" ]]
  [[ "$(unit_value WorkingDirectory "$APP_SERVICE")" == "$REPOSITORY" ]]
  environment=$(unit_value Environment "$WEB_SERVICE")
  for unit in \
    CODEX_ROUTER_ADMIN_ORIGIN \
    CODEX_ROUTER_ADMIN_TOKEN_FILE \
    CODEX_WEB_PUBLIC_ORIGIN \
    CODEX_WEB_TRUSTED_TAILNET_ACCESS \
    CODEX_WEB_CODEX_HOME \
    CODEX_WEB_WORKSPACE_ROOTS \
    CODEX_WEB_UPLOAD_ROOT; do
    [[ "$environment" == *"${unit}="* ]]
  done
}

expect_active() {
  [[ "$($SYSTEMCTL is-active "$1" 2>/dev/null || true)" == active ]]
}

probe_ready() {
  if [[ -n "$fixture_root" ]]; then
    [[ -f "${fixture_root}/probe-ok" ]]
    return
  fi
  curl -fsS --max-time 1 http://127.0.0.1:18318/readyz >/dev/null &&
    curl -fsS --max-time 1 -H 'Host: 100.95.50.98:8216' http://127.0.0.1:8216/ >/dev/null
}

restart_8216() {
  "$SYSTEMCTL" restart "$ACCOUNT_SERVICE"
  "$SYSTEMCTL" restart "$APP_SERVICE"
  "$SYSTEMCTL" restart "$WEB_SERVICE"
}

restore_units() {
  cp -a "${backup_directory}/codex-web-router.service" "$WEB_UNIT_TARGET"
  cp -a "${backup_directory}/codex-web-router-app-server.service" "$APP_UNIT_TARGET"
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${WEB_PREFIX}/.current-r77-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      mv -Tf "$rollback_link" "$CURRENT"
    fi
    if [[ "$units_installed" -eq 1 ]]; then
      restore_units
    fi
    if [[ "$current_switched" -eq 1 || "$units_installed" -eq 1 ]]; then
      "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
      restart_8216 >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then
      rm -rf -- "$SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$backup_directory" ]] || rm -rf -- "$backup_directory"
  expect_8215_unchanged || exit_code=1
  exit "$exit_code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
expect_8215_unchanged
expect_no_pending_reload
expect_isolation_files
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ACCOUNT_SERVICE"; do
  expect_active "$unit"
done
[[ "$(sha256 "$ARCHIVE")" == "$ARCHIVE_SHA256" ]]
[[ "$(sha256 "$WEB_UNIT_SOURCE")" == "$WEB_UNIT_SHA256" ]]
[[ "$(sha256 "$APP_UNIT_SOURCE")" == "$APP_UNIT_SHA256" ]]
[[ "$(sha256 "$WEB_UNIT_TARGET")" == "$EXPECTED_WEB_BASE_SHA256" ]]
[[ "$(sha256 "$APP_UNIT_TARGET")" == "$EXPECTED_APP_BASE_SHA256" ]]
[[ "$(sha256 "$ACCOUNT_UNIT_TARGET")" == "$EXPECTED_ACCOUNT_BASE_SHA256" ]]
[[ -L "$CURRENT" && ! -e "$SUCCESSOR" ]]
current_before=$(readlink -f "$CURRENT")
router_current_before=$(readlink -f "$ROUTER_CURRENT")
if [[ -z "$fixture_root" ]]; then
  [[ "$current_before" == "${RELEASES}/c3e92f0f-20260729-m69-router-r23" ]]
fi
[[ "$router_current_before" == "$EXPECTED_ROUTER_CURRENT" ]]

mapfile -t archive_entries < <(tar -tzf "$ARCHIVE")
expected_entries=(
  src/server/main.js src/server/module.js src/server/electron/index.js
  src/server/browser-ipc-router.js src/server/browser-session-auth.js
  src/server/browser-upload-store.js src/server/router-status-bridge.js
  scratch/asar/webview/index.html scratch/asar/webview/index.html.gz
  scratch/asar/webview/index.html.br
  scratch/asar/webview/assets/preload-d153ef5a.js
  scratch/asar/webview/assets/preload-d153ef5a.js.gz
  scratch/asar/webview/assets/preload-d153ef5a.js.br
)
[[ "${#archive_entries[@]}" -eq "${#expected_entries[@]}" ]]
for index in "${!expected_entries[@]}"; do
  [[ "${archive_entries[$index]}" == "${expected_entries[$index]}" ]]
done
tar -tvzf "$ARCHIVE" | awk '$1 !~ /^-/ { exit 1 }'

backup_directory=$(mktemp -d "${fixture_root:-/tmp}/m69-r77-units.XXXXXX")
cp -a "$WEB_UNIT_TARGET" "${backup_directory}/codex-web-router.service"
cp -a "$APP_UNIT_TARGET" "${backup_directory}/codex-web-router-app-server.service"

cp -a --reflink=auto "$current_before" "$SUCCESSOR"
successor_created=1
tar --no-same-owner -xzf "$ARCHIVE" -C "$SUCCESSOR"
install -m 0644 "$WEB_UNIT_SOURCE" "$WEB_UNIT_TARGET"
install -m 0644 "$APP_UNIT_SOURCE" "$APP_UNIT_TARGET"
units_installed=1

next_link="${WEB_PREFIX}/.current-r77.$$"
ln -s "$SUCCESSOR" "$next_link"
mv -Tf "$next_link" "$CURRENT"
current_switched=1

"$SYSTEMCTL" daemon-reload
expect_no_pending_reload
expect_isolation_files
restart_8216

ready=0
for attempt in $(seq 1 "${R77_READY_ATTEMPTS:-30}"); do
  if expect_active "$ACCOUNT_SERVICE" &&
     expect_active "$APP_SERVICE" &&
     expect_active "$WEB_SERVICE" &&
     probe_ready; then
    ready=1
    break
  fi
  sleep "${R77_READY_SLEEP_SECONDS:-0.2}"
done
[[ "$ready" -eq 1 ]]

expect_8215_unchanged
expect_no_pending_reload
expect_isolation_files
expect_8216_runtime_isolation
[[ "$(sha256 "$WEB_UNIT_TARGET")" == "$WEB_UNIT_SHA256" ]]
[[ "$(sha256 "$APP_UNIT_TARGET")" == "$APP_UNIT_SHA256" ]]
[[ "$(sha256 "$ACCOUNT_UNIT_TARGET")" == "$EXPECTED_ACCOUNT_BASE_SHA256" ]]
[[ "$(readlink -f "$CURRENT")" == "$SUCCESSOR" ]]
[[ "$(readlink -f "$ROUTER_CURRENT")" == "$router_current_before" ]]

success=1
trap - EXIT
rm -rf -- "$backup_directory"
backup_directory=
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'account_router_release_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
