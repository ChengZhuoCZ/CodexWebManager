#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-/tmp/codex-web-upstream-full-access.conf}"
DESTINATION="/etc/systemd/system/codex-web-upstream-app-server.service.d/full-access.conf"
BACKUP="$(mktemp /tmp/codex-web-upstream-full-access.backup.XXXXXX)"
HAD_EXISTING=0
ROLLED_BACK=0

units_8216=(
  codex-account-router.service
  codex-web-router-app-server.service
  codex-web-router.service
)

declare -A pid_8216
declare -A started_8216

snapshot_8216() {
  local unit
  for unit in "${units_8216[@]}"; do
    pid_8216["$unit"]="$(systemctl show "$unit" -p MainPID --value)"
    started_8216["$unit"]="$(systemctl show "$unit" -p ExecMainStartTimestampMonotonic --value)"
  done
}

assert_8216_unchanged() {
  local unit
  for unit in "${units_8216[@]}"; do
    test "$(systemctl show "$unit" -p MainPID --value)" = "${pid_8216[$unit]}"
    test "$(systemctl show "$unit" -p ExecMainStartTimestampMonotonic --value)" = "${started_8216[$unit]}"
  done
}

wait_for_8215() {
  local attempt
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet codex-web-upstream-app-server.service &&
      test -S /run/codex-web-upstream-app-server/app-server.sock &&
      curl -fsS --max-time 2 http://127.0.0.1:8215/ >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  if test "$ROLLED_BACK" = 1; then
    return
  fi
  ROLLED_BACK=1
  if test "$HAD_EXISTING" = 1; then
    install -m 0644 "$BACKUP" "$DESTINATION"
  else
    rm -f "$DESTINATION"
  fi
  systemctl daemon-reload
  systemctl restart codex-web-upstream-app-server.service
  wait_for_8215 || true
}

trap 'rollback' ERR INT TERM

test -f "$SOURCE"
snapshot_8216
if test -f "$DESTINATION"; then
  cp "$DESTINATION" "$BACKUP"
  HAD_EXISTING=1
fi

install -d -m 0755 "$(dirname "$DESTINATION")"
install -m 0644 "$SOURCE" "$DESTINATION"
systemd-analyze verify codex-web-upstream-app-server.service
systemctl daemon-reload
systemctl restart codex-web-upstream-app-server.service
wait_for_8215

printf 'stage=service-ready\n'
test "$(systemctl show codex-web-upstream-app-server.service -p ProtectSystem --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p ProtectHome --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p PrivateTmp --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p PrivateDevices --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p PrivateMounts --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p NoNewPrivileges --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p RestrictSUIDSGID --value)" = "no"
test "$(systemctl show codex-web-upstream-app-server.service -p RestrictAddressFamilies --value)" = "~"

printf 'stage=systemd-sandbox-disabled\n'
app_server_pid="$(systemctl show codex-web-upstream-app-server.service -p MainPID --value)"
mapfile -d '' -t app_server_argv <"/proc/$app_server_pid/cmdline"
printf '%s\n' "${app_server_argv[@]}" | grep -Fxq 'sandbox_mode="danger-full-access"'
printf '%s\n' "${app_server_argv[@]}" | grep -Fxq 'approval_policy="never"'
if printf '%s\n' "${app_server_argv[@]}" |
  grep -Eq 'openai_base_url|18317|codex-account-router'; then
  exit 1
fi

printf 'stage=codex-full-access-argv-verified\n'
assert_8216_unchanged
trap - ERR INT TERM
rm -f "$BACKUP"

printf '8215_full_access=verified\n'
printf '8215_app_server_pid=%s\n' \
  "$(systemctl show codex-web-upstream-app-server.service -p MainPID --value)"
for unit in "${units_8216[@]}"; do
  printf 'unchanged_%s_pid=%s\n' "$unit" "${pid_8216[$unit]}"
  printf 'unchanged_%s_started=%s\n' "$unit" "${started_8216[$unit]}"
done
