#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=/tmp/codex-account-router-0.2.5-linux-x64.tar.gz
readonly ARCHIVE_SHA256=4b2df22e926fb02324fcc547efe66f5eb6e1160e7492d7ed1f52439bc2d8465e
readonly RELEASE_NAME=codex-account-router-0.2.5-linux-x64
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
probe_directory=
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
    local rollback_link="${ROUTER_ROOT}/.current-r22-rollback.$$"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$ROUTER_CURRENT"
    systemctl restart "$ROUTER_UNIT" >/dev/null 2>&1 || true
    printf 'deployment_status=rolled_back\n'
  fi
  if [[ -n "$extract_directory" ]]; then
    rm -rf "$extract_directory"
  fi
  if [[ -n "$probe_directory" ]]; then
    rm -rf "$probe_directory"
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

extract_directory=$(mktemp -d /tmp/m69-r22-deploy.XXXXXX)
tar --no-same-owner -xzf "$ARCHIVE" -C "$extract_directory"
readonly extracted_release="${extract_directory}/${RELEASE_NAME}"
[[ -f "${extracted_release}/manifest.json" ]]
[[ -x "${extracted_release}/install.sh" ]]
[[ "$(node -p "require('${extracted_release}/lib/account-router/package.json').version")" == 0.2.5 ]]

PREFIX="$ROUTER_ROOT" sh "${extracted_release}/install.sh"
current_switched=1
[[ "$(readlink -f "$ROUTER_CURRENT")" == "${ROUTER_ROOT}/releases/${RELEASE_NAME}" ]]

systemctl restart "$ROUTER_UNIT"
wait_for_url http://127.0.0.1:18318/readyz

node --input-type=module -e '
  const modulePath =
    "file:///opt/codex-account-router/current/lib/account-router/src/model-catalog-cache.mjs";
  const { createModelCatalogCache } = await import(modulePath);
  let now = 1000;
  const cache = createModelCatalogCache({ ttlMs: 5000, now: () => now });
  const route = {
    route_id: "codex_models",
    upstream_target: "/backend-api/codex/models?client_version=fixture",
  };
  const body = Buffer.from("{\"models\":[]}");
  if (!cache.write({
    accountId: "A",
    route,
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "x-oai-request-id": "fixture-private-request",
    },
    body,
  })) process.exit(1);
  const hit = cache.read({ accountId: "A", route });
  if (hit === null || hit.body.toString("utf8") !== "{\"models\":[]}") process.exit(1);
  if (hit.headers["x-oai-request-id"] !== undefined) process.exit(1);
  if (cache.read({ accountId: "B", route }) !== null) process.exit(1);
  now += 5000;
  if (cache.read({ accountId: "A", route }) !== null) process.exit(1);
'

probe_directory=$(mktemp -d /tmp/m69-r22-models.XXXXXX)
chmod 700 "$probe_directory"
for attempt in 1 2; do
  curl -sS --max-time 30 \
    -D "${probe_directory}/headers.${attempt}" \
    -o "${probe_directory}/body.${attempt}" \
    -w "%{http_code} %{time_starttransfer} %{time_total} %{size_download}\n" \
    -H "accept: application/json" \
    -H "originator: codex_cli_rs" \
    -H "user-agent: codex-cli/0.145.0" \
    -H "version: 0.145.0" \
    "http://127.0.0.1:18317/backend-api/codex/models?client_version=0.145.0" \
    >"${probe_directory}/metrics.${attempt}"
  [[ "$(awk '{print $1}' "${probe_directory}/metrics.${attempt}")" == 200 ]]
  node -e '
    const fs = require("node:fs");
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(parsed.models) || parsed.models.length < 1) process.exit(1);
  ' "${probe_directory}/body.${attempt}"
done
readonly first_model_sha=$(sha256sum "${probe_directory}/body.1" | awk '{print $1}')
readonly second_model_sha=$(sha256sum "${probe_directory}/body.2" | awk '{print $1}')
[[ "$first_model_sha" == "$second_model_sha" ]]
readonly first_model_metrics=$(cat "${probe_directory}/metrics.1")
readonly second_model_metrics=$(cat "${probe_directory}/metrics.2")
readonly first_request_id_header=$(
  if grep -Eiq '^x-oai-request-id:' "${probe_directory}/headers.1"; then
    printf present
  else
    printf absent
  fi
)
readonly second_request_id_header=$(
  if grep -Eiq '^x-oai-request-id:' "${probe_directory}/headers.2"; then
    printf present
  else
    printf absent
  fi
)
[[ "$second_request_id_header" == absent ]]

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
rm -rf "$extract_directory" "$probe_directory"
extract_directory=
probe_directory=
printf 'deployment_status=success\n'
printf 'router_previous_release=%s\n' "$(basename "$previous_release")"
printf 'router_release=%s\n' "$RELEASE_NAME"
printf 'router_pid_before=%s\n' "$router_pid_before"
printf 'router_pid_after=%s\n' "$router_pid_after"
printf 'model_probe_1=%s\n' "$first_model_metrics"
printf 'model_probe_2=%s\n' "$second_model_metrics"
printf 'model_probe_sha256_equal=true\n'
printf 'model_probe_1_request_id_header=%s\n' "$first_request_id_header"
printf 'model_probe_2_request_id_header=%s\n' "$second_request_id_header"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_web_unchanged=true\n'
