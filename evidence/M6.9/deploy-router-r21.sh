#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=/tmp/codex-account-router-0.2.4-linux-x64.tar.gz
readonly ARCHIVE_SHA256=8eef578534a56cf5778b0f0665337bfc1da5040d3118627327a8d4924428f7dd
readonly RELEASE_NAME=codex-account-router-0.2.4-linux-x64
readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_UNIT=codex-account-router.service
readonly ROUTED_APP_UNIT=codex-web-router-app-server.service
readonly ROUTED_WEB_UNIT=codex-web-router.service
readonly STANDALONE_APP_UNIT=codex-web-upstream-app-server.service
readonly STANDALONE_WEB_UNIT=codex-web-upstream.service

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
    local rollback_link="${ROUTER_ROOT}/.current-r21-rollback.$$"
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

readonly standalone_app_pid_before=$(unit_pid "$STANDALONE_APP_UNIT")
readonly standalone_app_started_before=$(unit_started_at "$STANDALONE_APP_UNIT")
readonly standalone_app_config_before=$(unit_config_sha256 "$STANDALONE_APP_UNIT")
readonly standalone_web_pid_before=$(unit_pid "$STANDALONE_WEB_UNIT")
readonly standalone_web_started_before=$(unit_started_at "$STANDALONE_WEB_UNIT")
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

[[ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" == "$ARCHIVE_SHA256" ]]
tar -tzf "$ARCHIVE" | while IFS= read -r entry; do
  case "$entry" in
    "$RELEASE_NAME"|"$RELEASE_NAME"/*) ;;
    *) exit 1 ;;
  esac
done
tar -tvzf "$ARCHIVE" | awk '$1 !~ /^[-d]/ { exit 1 }'

extract_directory=$(mktemp -d /tmp/m69-r21-deploy.XXXXXX)
tar --no-same-owner -xzf "$ARCHIVE" -C "$extract_directory"
readonly extracted_release="${extract_directory}/${RELEASE_NAME}"
[[ -f "${extracted_release}/manifest.json" ]]
[[ -x "${extracted_release}/install.sh" ]]
[[ "$(node -p "require('${extracted_release}/lib/account-router/package.json').version")" == 0.2.4 ]]

PREFIX="$ROUTER_ROOT" sh "${extracted_release}/install.sh"
current_switched=1
[[ "$(readlink -f "$ROUTER_CURRENT")" == "${ROUTER_ROOT}/releases/${RELEASE_NAME}" ]]

systemctl restart "$ROUTER_UNIT"
wait_for_url http://127.0.0.1:18318/readyz

route_probe=$(node --input-type=module -e '
  const modulePath = "file:///opt/codex-account-router/current/lib/account-router/src/proxy-routes.mjs";
  const { normalizeProxyRoute } = await import(modulePath);
  const route = normalizeProxyRoute({
    method: "POST",
    rawTarget: "/backend-api/codex/responses",
    transport: "http",
  });
  process.stdout.write(JSON.stringify(route));
')
[[ "$route_probe" == '{"route_id":"codex_responses_http","method":"POST","transport":"http","canonical_path":"/backend-api/codex/responses","upstream_target":"/backend-api/codex/responses"}' ]]
node --input-type=module -e '
  const modulePath = "file:///opt/codex-account-router/current/lib/account-router/src/proxy-routes.mjs";
  const { normalizeProxyRoute } = await import(modulePath);
  try {
    normalizeProxyRoute({
      method: "POST",
      rawTarget: "/backend-api/codex/responses?client_version=1",
      transport: "http",
    });
    process.exit(1);
  } catch (error) {
    if (error.code !== "query_not_allowed") process.exit(1);
  }
'

for unit in "$ROUTED_APP_UNIT" "$ROUTED_WEB_UNIT" "$STANDALONE_APP_UNIT" "$STANDALONE_WEB_UNIT"; do
  expect_active "$unit"
done
wait_for_url http://127.0.0.1:8215/
wait_for_url http://127.0.0.1:8216/

[[ "$(unit_pid "$STANDALONE_APP_UNIT")" == "$standalone_app_pid_before" ]]
[[ "$(unit_started_at "$STANDALONE_APP_UNIT")" == "$standalone_app_started_before" ]]
[[ "$(unit_config_sha256 "$STANDALONE_APP_UNIT")" == "$standalone_app_config_before" ]]
[[ "$(unit_pid "$STANDALONE_WEB_UNIT")" == "$standalone_web_pid_before" ]]
[[ "$(unit_started_at "$STANDALONE_WEB_UNIT")" == "$standalone_web_started_before" ]]
[[ "$(unit_config_sha256 "$STANDALONE_WEB_UNIT")" == "$standalone_web_config_before" ]]
[[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$standalone_release_before" ]]
[[ "$(unit_pid "$ROUTED_APP_UNIT")" == "$routed_app_pid_before" ]]
[[ "$(unit_started_at "$ROUTED_APP_UNIT")" == "$routed_app_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTED_APP_UNIT")" == "$routed_app_config_before" ]]
[[ "$(unit_pid "$ROUTED_WEB_UNIT")" == "$routed_web_pid_before" ]]
[[ "$(unit_started_at "$ROUTED_WEB_UNIT")" == "$routed_web_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTED_WEB_UNIT")" == "$routed_web_config_before" ]]
[[ "$(readlink -f /opt/0xcaff-codex-web-router/current)" == "$routed_release_before" ]]

success=1
trap - EXIT
rm -rf "$extract_directory"
extract_directory=
printf 'deployment_status=success\n'
printf 'router_previous_release=%s\n' "$(basename "$previous_release")"
printf 'router_release=%s\n' "$RELEASE_NAME"
printf 'route_probe=%s\n' "$route_probe"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_web_unchanged=true\n'
