#!/usr/bin/env bash
set -euo pipefail

readonly PREFIX=/opt/0xcaff-codex-web-router
readonly CURRENT="${PREFIX}/current"
readonly FAILED="${PREFIX}/releases/c3e92f0f-20260802-m69-router-r90-standalone-panel"
readonly QUALIFIED="${PREFIX}/releases/c3e92f0f-20260802-m69-router-r87-materialized-r23"
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ACCOUNT_SERVICE=codex-account-router.service
readonly STANDALONE_WEB_PID=3664557
readonly STANDALONE_APP_PID=3664550
readonly ACCOUNT_PID=3693211

verify_unchanged() {
  [[ "$(systemctl show -p MainPID --value codex-web-upstream.service)" == "$STANDALONE_WEB_PID" ]]
  [[ "$(systemctl show -p MainPID --value codex-web-upstream-app-server.service)" == "$STANDALONE_APP_PID" ]]
  [[ "$(systemctl show -p MainPID --value "$ACCOUNT_SERVICE")" == "$ACCOUNT_PID" ]]
}

switch_to() {
  local target=$1
  local next="${PREFIX}/.current-r90-browser-rollback.$$"
  ln -s "$target" "$next"
  mv -Tf "$next" "$CURRENT"
}

restart_8216() {
  systemctl restart "$APP_SERVICE"
  systemctl restart "$WEB_SERVICE"
}

probe() {
  curl -fsS --max-time 1 \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Accept: text/html' \
    http://127.0.0.1:8216/ >/dev/null
}

[[ "$EUID" -eq 0 ]]
[[ "$(readlink -f "$CURRENT")" == "$FAILED" ]]
[[ -d "$QUALIFIED" ]]
verify_unchanged

switch_to "$QUALIFIED"
if ! restart_8216; then
  switch_to "$FAILED"
  restart_8216 || true
  exit 1
fi

ready=0
for attempt in $(seq 1 50); do
  if [[ "$(systemctl is-active "$WEB_SERVICE" 2>/dev/null || true)" == active ]] &&
    [[ "$(systemctl is-active "$APP_SERVICE" 2>/dev/null || true)" == active ]] && probe; then
    ready=1
    break
  fi
  sleep 0.2
done

if [[ "$ready" -ne 1 ]]; then
  switch_to "$FAILED"
  restart_8216 || true
  exit 1
fi

verify_unchanged
printf 'rollback_status=success\n'
printf 'release=%s\n' "$(readlink -f "$CURRENT")"
printf 'standalone_8215_unchanged=true\n'
printf 'account_router_unchanged=true\n'
