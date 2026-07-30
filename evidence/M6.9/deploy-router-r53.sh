#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=/tmp/codex-account-router-0.2.29-linux-x64.tar.gz
readonly ARCHIVE_SHA256=471bbacf24c78fe41ae81cff3b30da4cf7666cbcf190b76c3dd8fec53a7ca615
readonly RELEASE_NAME=codex-account-router-0.2.29-linux-x64
readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_UNIT=codex-account-router.service
readonly ROUTED_APP_UNIT=codex-web-router-app-server.service
readonly ROUTED_WEB_UNIT=codex-web-router.service
readonly STANDALONE_APP_UNIT=codex-web-upstream-app-server.service
readonly STANDALONE_WEB_UNIT=codex-web-upstream.service
readonly STANDALONE_APP_EXPECTED_PID=508396
readonly STANDALONE_APP_EXPECTED_ACTIVE_ENTER=194490256399
readonly STANDALONE_WEB_EXPECTED_PID=510876
readonly STANDALONE_WEB_EXPECTED_ACTIVE_ENTER=196497166178

success=0
current_switched=0
extract_directory=
previous_release=

unit_pid() {
  systemctl show -p MainPID --value "$1"
}

unit_started_at() {
  systemctl show -p ExecMainStartTimestampMonotonic --value "$1"
}

unit_active_enter() {
  systemctl show -p ActiveEnterTimestampMonotonic --value "$1"
}

unit_config_sha256() {
  systemctl cat "$1" --no-pager | sha256sum | awk '{print $1}'
}

expect_active() {
  [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]
}

wait_for_url() {
  local url=$1
  local attempt
  for attempt in $(seq 1 150); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$current_switched" -eq 1 && -n "$previous_release" ]]; then
    local rollback_link="${ROUTER_ROOT}/.current-r53-rollback.$$"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$ROUTER_CURRENT"
    systemctl restart "$ROUTER_UNIT" >/dev/null 2>&1 || true
    printf 'deployment_status=rolled_back\n'
  fi
  if [[ -n "$extract_directory" ]]; then
    rm -rf "$extract_directory"
  fi
  exit "$exit_code"
}
trap rollback EXIT

for unit in \
  "$ROUTER_UNIT" \
  "$ROUTED_APP_UNIT" \
  "$ROUTED_WEB_UNIT" \
  "$STANDALONE_APP_UNIT" \
  "$STANDALONE_WEB_UNIT"; do
  expect_active "$unit"
done
wait_for_url http://127.0.0.1:18318/readyz
wait_for_url http://127.0.0.1:8215/
wait_for_url http://127.0.0.1:8216/

readonly router_pid_before=$(unit_pid "$ROUTER_UNIT")
readonly router_started_before=$(unit_started_at "$ROUTER_UNIT")
readonly router_config_before=$(unit_config_sha256 "$ROUTER_UNIT")
readonly standalone_app_pid_before=$(unit_pid "$STANDALONE_APP_UNIT")
readonly standalone_app_started_before=$(unit_started_at "$STANDALONE_APP_UNIT")
readonly standalone_app_active_enter_before=$(unit_active_enter "$STANDALONE_APP_UNIT")
readonly standalone_app_config_before=$(unit_config_sha256 "$STANDALONE_APP_UNIT")
readonly standalone_web_pid_before=$(unit_pid "$STANDALONE_WEB_UNIT")
readonly standalone_web_started_before=$(unit_started_at "$STANDALONE_WEB_UNIT")
readonly standalone_web_active_enter_before=$(unit_active_enter "$STANDALONE_WEB_UNIT")
readonly standalone_web_config_before=$(unit_config_sha256 "$STANDALONE_WEB_UNIT")
readonly standalone_release_before=$(readlink -f /opt/0xcaff-codex-web/current)
readonly routed_app_pid_before=$(unit_pid "$ROUTED_APP_UNIT")
readonly routed_app_started_before=$(unit_started_at "$ROUTED_APP_UNIT")
readonly routed_app_config_before=$(unit_config_sha256 "$ROUTED_APP_UNIT")
readonly routed_web_pid_before=$(unit_pid "$ROUTED_WEB_UNIT")
readonly routed_web_started_before=$(unit_started_at "$ROUTED_WEB_UNIT")
readonly routed_web_config_before=$(unit_config_sha256 "$ROUTED_WEB_UNIT")
readonly routed_release_before=$(readlink -f /opt/0xcaff-codex-web-router/current)
previous_release=$(readlink -f "$ROUTER_CURRENT")

[[ "$standalone_app_pid_before" == "$STANDALONE_APP_EXPECTED_PID" ]]
[[ "$standalone_app_active_enter_before" == "$STANDALONE_APP_EXPECTED_ACTIVE_ENTER" ]]
[[ "$standalone_web_pid_before" == "$STANDALONE_WEB_EXPECTED_PID" ]]
[[ "$standalone_web_active_enter_before" == "$STANDALONE_WEB_EXPECTED_ACTIVE_ENTER" ]]
[[ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" == "$ARCHIVE_SHA256" ]]
tar -tzf "$ARCHIVE" | while IFS= read -r entry; do
  case "$entry" in
    "$RELEASE_NAME"|"$RELEASE_NAME"/*) ;;
    *) exit 1 ;;
  esac
done
tar -tvzf "$ARCHIVE" | awk '$1 !~ /^[-d]/ { exit 1 }'

extract_directory=$(mktemp -d /tmp/m69-r53-deploy.XXXXXX)
tar --no-same-owner -xzf "$ARCHIVE" -C "$extract_directory"
readonly extracted_release="${extract_directory}/${RELEASE_NAME}"
[[ -f "${extracted_release}/manifest.json" ]]
[[ -x "${extracted_release}/install.sh" ]]
[[ "$(node -p "require('${extracted_release}/lib/account-router/package.json').version")" == 0.2.29 ]]

PREFIX="$ROUTER_ROOT" sh "${extracted_release}/install.sh"
current_switched=1
[[ "$(readlink -f "$ROUTER_CURRENT")" == "${ROUTER_ROOT}/releases/${RELEASE_NAME}" ]]

systemctl restart "$ROUTER_UNIT"
wait_for_url http://127.0.0.1:18318/readyz

for unit in "$ROUTED_APP_UNIT" "$ROUTED_WEB_UNIT" "$STANDALONE_APP_UNIT" "$STANDALONE_WEB_UNIT"; do
  expect_active "$unit"
done
wait_for_url http://127.0.0.1:8215/
wait_for_url http://127.0.0.1:8216/

readonly router_pid_after=$(unit_pid "$ROUTER_UNIT")
readonly router_started_after=$(unit_started_at "$ROUTER_UNIT")
[[ "$router_pid_after" != "$router_pid_before" ]]
[[ "$router_started_after" != "$router_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTER_UNIT")" == "$router_config_before" ]]
[[ "$(unit_pid "$STANDALONE_APP_UNIT")" == "$standalone_app_pid_before" ]]
[[ "$(unit_started_at "$STANDALONE_APP_UNIT")" == "$standalone_app_started_before" ]]
[[ "$(unit_active_enter "$STANDALONE_APP_UNIT")" == "$standalone_app_active_enter_before" ]]
[[ "$(unit_config_sha256 "$STANDALONE_APP_UNIT")" == "$standalone_app_config_before" ]]
[[ "$(unit_pid "$STANDALONE_WEB_UNIT")" == "$standalone_web_pid_before" ]]
[[ "$(unit_started_at "$STANDALONE_WEB_UNIT")" == "$standalone_web_started_before" ]]
[[ "$(unit_active_enter "$STANDALONE_WEB_UNIT")" == "$standalone_web_active_enter_before" ]]
[[ "$(unit_config_sha256 "$STANDALONE_WEB_UNIT")" == "$standalone_web_config_before" ]]
[[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$standalone_release_before" ]]
[[ "$(unit_pid "$ROUTED_APP_UNIT")" == "$routed_app_pid_before" ]]
[[ "$(unit_started_at "$ROUTED_APP_UNIT")" == "$routed_app_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTED_APP_UNIT")" == "$routed_app_config_before" ]]
[[ "$(unit_pid "$ROUTED_WEB_UNIT")" == "$routed_web_pid_before" ]]
[[ "$(unit_started_at "$ROUTED_WEB_UNIT")" == "$routed_web_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTED_WEB_UNIT")" == "$routed_web_config_before" ]]
[[ "$(readlink -f /opt/0xcaff-codex-web-router/current)" == "$routed_release_before" ]]

readiness_200=0
for sample in $(seq 1 20); do
  if [[ "$(curl -sS -o /dev/null --max-time 2 -w '%{http_code}' \
    http://127.0.0.1:18318/readyz)" == 200 ]]; then
    readiness_200=$((readiness_200 + 1))
  fi
  sleep 0.2
done
[[ "$readiness_200" -eq 20 ]]

printf 'deployment_status=passed\n'
printf 'previous_router_release=%s\n' "$previous_release"
printf 'active_router_release=%s\n' "$(readlink -f "$ROUTER_CURRENT")"
printf 'router_pid_before=%s\n' "$router_pid_before"
printf 'router_pid_after=%s\n' "$router_pid_after"
printf 'router_started_before=%s\n' "$router_started_before"
printf 'router_started_after=%s\n' "$router_started_after"
printf 'router_effective_unit_sha256=%s\n' "$router_config_before"
printf 'standalone_app_pid=%s\n' "$standalone_app_pid_before"
printf 'standalone_app_active_enter=%s\n' "$standalone_app_active_enter_before"
printf 'standalone_web_pid=%s\n' "$standalone_web_pid_before"
printf 'standalone_web_active_enter=%s\n' "$standalone_web_active_enter_before"
printf 'standalone_release=%s\n' "$standalone_release_before"
printf 'routed_app_pid=%s\n' "$routed_app_pid_before"
printf 'routed_web_pid=%s\n' "$routed_web_pid_before"
printf 'routed_release=%s\n' "$routed_release_before"
printf 'readiness_samples_200=%s\n' "$readiness_200"
printf 'real_account_request_sent=false\n'
printf 'account_switch_tested=false\n'

success=1
trap - EXIT
rm -rf "$extract_directory"
