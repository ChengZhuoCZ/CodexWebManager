#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY=/srv/codex-workspaces/CodexWebManager
readonly RELEASE_NAME=c3e92f0f-20260801-m69-router-r69
readonly PRODUCTION_ARCHIVE=/tmp/codex-m69-r72-web-overlay.tar.gz
readonly PRODUCTION_ARCHIVE_SHA256=6a8060aaf32c67190412d0f97e9b57da9e89638143ec76484da9927dc00744b9
readonly WEB_UNIT_SHA256=f66b20c7f64bc258ee3752a22a7c2b1b21e3695b1f5685e4d8047ce9b3bcba3f
readonly APP_UNIT_SHA256=03de8d81201637f24e8fe136f14415b3d0f1d33853aaa641f29adc16864cee3b
readonly TMPFILES_SHA256=e657aa145e0037fcba7c50fa139b391a1396ab9b29f4c070beaeccd5f1532197
readonly STANDALONE_WEB_PID=1336830
readonly STANDALONE_WEB_START=335738476636
readonly STANDALONE_WEB_UNIT_SHA256=543ddc71409cc088522e80651955a988cc9f2229e9da29dc8a9107c3def3ea1a
readonly STANDALONE_APP_PID=1336828
readonly STANDALONE_APP_START=335738474212
readonly STANDALONE_APP_UNIT_SHA256=ae839d73cd554222d86d7dc920f7a7938eccdab9746ec993f91a47c56c3d7a40

fixture_root=${M69_FIXTURE_ROOT:-}
if [[ -n "$fixture_root" ]]; then
  [[ "$fixture_root" == /tmp/* && -d "$fixture_root" && ! -L "$fixture_root" ]]
  readonly PREFIX="${fixture_root}/opt/0xcaff-codex-web-router"
  readonly UNIT_ROOT="${fixture_root}/etc/systemd/system"
  readonly TMPFILES_TARGET="${fixture_root}/etc/tmpfiles.d/codex-stack.conf"
  readonly ARCHIVE=${M69_ARCHIVE:?}
  readonly ARCHIVE_SHA256=${M69_ARCHIVE_SHA256:?}
  readonly SYSTEMCTL=${M69_SYSTEMCTL:?}
  readonly TMPFILES=${M69_TMPFILES:?}
  readonly REPO_ROOT=$PWD
else
  [[ $EUID -eq 0 ]]
  readonly PREFIX=/opt/0xcaff-codex-web-router
  readonly UNIT_ROOT=/etc/systemd/system
  readonly TMPFILES_TARGET=/etc/tmpfiles.d/codex-stack.conf
  readonly ARCHIVE=$PRODUCTION_ARCHIVE
  readonly ARCHIVE_SHA256=$PRODUCTION_ARCHIVE_SHA256
  readonly SYSTEMCTL=systemctl
  readonly TMPFILES=systemd-tmpfiles
  readonly REPO_ROOT=$REPOSITORY
fi

readonly CURRENT="${PREFIX}/current"
readonly RELEASES="${PREFIX}/releases"
readonly SUCCESSOR="${RELEASES}/${RELEASE_NAME}"
readonly WEB_UNIT_SOURCE="${REPO_ROOT}/systemd/codex-web-router.service"
readonly APP_UNIT_SOURCE="${REPO_ROOT}/systemd/codex-web-router-app-server.service"
readonly TMPFILES_SOURCE="${REPO_ROOT}/systemd/codex-stack.tmpfiles.conf"
readonly WEB_UNIT_TARGET="${UNIT_ROOT}/codex-web-router.service"
readonly APP_UNIT_TARGET="${UNIT_ROOT}/codex-web-router-app-server.service"

success=0
successor_created=0
current_switched=0
units_installed=0
backup_directory=
current_before=

expect_sha256() {
  [[ "$(sha256sum "$2" | awk '{print $1}')" == "$1" ]]
}

expect_8215_unchanged() {
  if [[ -n "$fixture_root" ]]; then
    return 0
  fi
  [[ "$($SYSTEMCTL show -p MainPID --value codex-web-upstream.service)" == "$STANDALONE_WEB_PID" ]]
  [[ "$($SYSTEMCTL show -p ActiveEnterTimestampMonotonic --value codex-web-upstream.service)" == "$STANDALONE_WEB_START" ]]
  [[ "$($SYSTEMCTL cat codex-web-upstream.service --no-pager 2>/dev/null | sha256sum | awk '{print $1}')" == "$STANDALONE_WEB_UNIT_SHA256" ]]
  [[ "$($SYSTEMCTL show -p MainPID --value codex-web-upstream-app-server.service)" == "$STANDALONE_APP_PID" ]]
  [[ "$($SYSTEMCTL show -p ActiveEnterTimestampMonotonic --value codex-web-upstream-app-server.service)" == "$STANDALONE_APP_START" ]]
  [[ "$($SYSTEMCTL cat codex-web-upstream-app-server.service --no-pager 2>/dev/null | sha256sum | awk '{print $1}')" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

restore_units() {
  cp -a "${backup_directory}/codex-web-router.service" "$WEB_UNIT_TARGET"
  cp -a "${backup_directory}/codex-web-router-app-server.service" "$APP_UNIT_TARGET"
  cp -a "${backup_directory}/codex-stack.conf" "$TMPFILES_TARGET"
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${PREFIX}/.current-r69-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      mv -Tf "$rollback_link" "$CURRENT"
    fi
    if [[ "$units_installed" -eq 1 ]]; then
      restore_units
      "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
    fi
    if [[ "$current_switched" -eq 1 || "$units_installed" -eq 1 ]]; then
      "$SYSTEMCTL" restart codex-web-router-app-server.service >/dev/null 2>&1 || true
      "$SYSTEMCTL" restart codex-web-router.service >/dev/null 2>&1 || true
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
expect_sha256 "$ARCHIVE_SHA256" "$ARCHIVE"
expect_sha256 "$WEB_UNIT_SHA256" "$WEB_UNIT_SOURCE"
expect_sha256 "$APP_UNIT_SHA256" "$APP_UNIT_SOURCE"
expect_sha256 "$TMPFILES_SHA256" "$TMPFILES_SOURCE"
[[ -L "$CURRENT" && ! -e "$SUCCESSOR" ]]
current_before=$(readlink "$CURRENT")
if [[ -z "$fixture_root" ]]; then
  [[ "$(readlink -f "$CURRENT")" == "${RELEASES}/c3e92f0f-20260729-m69-router-r23" ]]
fi

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

backup_directory=$(mktemp -d "${fixture_root:-/tmp}/m69-r69-units.XXXXXX")
cp -a "$WEB_UNIT_TARGET" "${backup_directory}/codex-web-router.service"
cp -a "$APP_UNIT_TARGET" "${backup_directory}/codex-web-router-app-server.service"
cp -a "$TMPFILES_TARGET" "${backup_directory}/codex-stack.conf"

cp -a --reflink=auto "$(readlink -f "$CURRENT")" "$SUCCESSOR"
successor_created=1
tar --no-same-owner -xzf "$ARCHIVE" -C "$SUCCESSOR"

install -m 0644 "$WEB_UNIT_SOURCE" "$WEB_UNIT_TARGET"
install -m 0644 "$APP_UNIT_SOURCE" "$APP_UNIT_TARGET"
install -m 0644 "$TMPFILES_SOURCE" "$TMPFILES_TARGET"
units_installed=1
"$SYSTEMCTL" daemon-reload
"$TMPFILES" --create "$TMPFILES_TARGET"

next_link="${PREFIX}/.current-r69.$$"
ln -s "$SUCCESSOR" "$next_link"
mv -Tf "$next_link" "$CURRENT"
current_switched=1
"$SYSTEMCTL" restart codex-web-router-app-server.service
"$SYSTEMCTL" restart codex-web-router.service

ready=0
for attempt in $(seq 1 "${M69_READY_ATTEMPTS:-50}"); do
  if [[ -n "$fixture_root" ]]; then
    [[ -f "${fixture_root}/probe-ok" ]] && ready=1 && break
  elif "$SYSTEMCTL" is-active --quiet codex-web-router-app-server.service &&
       "$SYSTEMCTL" is-active --quiet codex-web-router.service &&
       curl -fsS --max-time 2 -H 'Host: 100.95.50.98:8216' http://127.0.0.1:8216/ >/dev/null; then
    ready=1
    break
  fi
  sleep "${M69_READY_SLEEP_SECONDS:-0.2}"
done
[[ "$ready" -eq 1 ]]
expect_8215_unchanged
[[ "$(readlink -f "$CURRENT")" == "$SUCCESSOR" ]]

success=1
trap - EXIT
rm -rf -- "$backup_directory"
backup_directory=
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'standalone_8215_unchanged=true\n'
