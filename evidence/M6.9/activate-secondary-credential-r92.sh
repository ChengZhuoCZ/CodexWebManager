#!/usr/bin/env bash
set -euo pipefail

readonly SOURCE_DIRECTORY=/var/lib/codex-account-router/reauth-secondary-r92-20260802d
readonly SOURCE="${SOURCE_DIRECTORY}/auth.json"
readonly TARGET=/etc/credstore/codex-account-router.auth.secondary
readonly PRIMARY=/etc/credstore/codex-account-router.auth.primary
readonly ACCOUNTS=/etc/codex-account-router/accounts.json
readonly ROUTER_SERVICE=codex-account-router.service
readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly EXPECTED_ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.6-linux-x64
readonly EXPECTED_WEB_CURRENT=/opt/0xcaff-codex-web-router/releases/c3e92f0f-20260802-m69-router-r92-server-bridge
readonly EXPECTED_STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

backup_directory=
replacement_installed=0
success=0

unit_value() {
  systemctl show -p "$1" --value "$2"
}

unit_sha256() {
  systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1
}

must() {
  local label=$1
  shift
  "$@" || { printf 'activation_error=%s\n' "$label" >&2; exit 1; }
}

private_regular() {
  local path=$1
  local expected_uid=$2
  local mode uid size type
  type=$(stat -Lc '%F' "$path")
  mode=$(stat -Lc '%a' "$path")
  uid=$(stat -Lc '%u' "$path")
  size=$(stat -Lc '%s' "$path")
  [[ "$type" == 'regular file' ]]
  [[ "$uid" == "$expected_uid" ]]
  (( (8#$mode & 8#077) == 0 ))
  (( size >= 1 && size <= 1048576 ))
  [[ ! -L "$path" ]]
}

validate_credentials() {
  INPUT_SOURCE="$SOURCE" INPUT_PRIMARY="$PRIMARY" INPUT_TARGET="$TARGET" \
    INPUT_ACCOUNTS="$ACCOUNTS" \
    node --input-type=module <<'NODE'
import fs from "node:fs";
import { parseCodexAuthCredential } from "/opt/codex-account-router/current/lib/account-router/src/codex-credentials.mjs";
const paths = {
  source: process.env.INPUT_SOURCE,
  primary: process.env.INPUT_PRIMARY,
  target: process.env.INPUT_TARGET,
};
const documents = {};
for (const [name, file] of Object.entries(paths)) {
  documents[name] = parseCodexAuthCredential(fs.readFileSync(file));
}
if (documents.source.account_id === documents.primary.account_id) process.exit(3);
const accounts = JSON.parse(fs.readFileSync(process.env.INPUT_ACCOUNTS, "utf8"));
if (
  !accounts || accounts.version !== 1 || !Array.isArray(accounts.accounts) ||
  accounts.accounts.length !== 2
) process.exit(4);
const primary = accounts.accounts.find((account) => account.id === "primary");
const secondary = accounts.accounts.find((account) => account.id === "secondary");
if (
  !primary || primary.alias !== "Primary" ||
  primary.credential_ref !== "codex-account-router.auth.primary" ||
  !secondary || secondary.alias !== "Secondary" ||
  secondary.credential_ref !== "codex-account-router.auth.secondary"
) process.exit(5);
NODE
}

ready_with_two_accounts() {
  curl -fsS --max-time 2 http://127.0.0.1:18318/readyz 2>/dev/null | node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (
      !value || value.status !== "ready" ||
      !Number.isSafeInteger(value.usable_accounts) || value.usable_accounts < 2
    ) process.exit(1);
  ' 2>/dev/null
}

capture_protected_state() {
  readonly WEB_PID_BEFORE="$(unit_value MainPID "$WEB_SERVICE")"
  readonly WEB_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$WEB_SERVICE")"
  readonly WEB_UNIT_BEFORE="$(unit_sha256 "$WEB_SERVICE")"
  readonly APP_PID_BEFORE="$(unit_value MainPID "$APP_SERVICE")"
  readonly APP_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")"
  readonly APP_UNIT_BEFORE="$(unit_sha256 "$APP_SERVICE")"
  readonly STANDALONE_WEB_PID_BEFORE="$(unit_value MainPID "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_WEB_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_WEB_UNIT_BEFORE="$(unit_sha256 "$STANDALONE_WEB_SERVICE")"
  readonly STANDALONE_APP_PID_BEFORE="$(unit_value MainPID "$STANDALONE_APP_SERVICE")"
  readonly STANDALONE_APP_START_BEFORE="$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")"
  readonly STANDALONE_APP_UNIT_BEFORE="$(unit_sha256 "$STANDALONE_APP_SERVICE")"
  readonly ROUTER_UNIT_BEFORE="$(unit_sha256 "$ROUTER_SERVICE")"
  readonly ROUTER_PID_BEFORE="$(unit_value MainPID "$ROUTER_SERVICE")"
}

expect_protected_unchanged() {
  [[ "$(readlink -f /opt/0xcaff-codex-web-router/current)" == "$EXPECTED_WEB_CURRENT" ]]
  [[ "$(unit_value MainPID "$WEB_SERVICE")" == "$WEB_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$WEB_SERVICE")" == "$WEB_START_BEFORE" ]]
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_BEFORE" ]]
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$APP_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$APP_START_BEFORE" ]]
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_BEFORE" ]]
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$EXPECTED_STANDALONE_CURRENT" ]]
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]]
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_BEFORE" ]]
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]]
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]]
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_BEFORE" ]]
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_BEFORE" ]]
}

restore_secondary() {
  local restored="${TARGET}.rollback.$$"
  install -o root -g root -m 0600 "${backup_directory}/secondary.auth" "$restored"
  mv -fT "$restored" "$TARGET"
  systemctl restart "$ROUTER_SERVICE"
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$replacement_installed" -eq 1 ]]; then
    restore_secondary >/dev/null 2>&1 || exit_code=1
    printf 'activation_status=rolled_back\n'
  fi
  [[ -z "$backup_directory" ]] || rm -rf -- "$backup_directory"
  if declare -p WEB_PID_BEFORE >/dev/null 2>&1; then
    expect_protected_unchanged || exit_code=1
  fi
  exit "$exit_code"
}
trap rollback EXIT

printf 'activation_status=preflight\n'
must root_required test "$EUID" -eq 0
must router_release_changed test "$(readlink -f /opt/codex-account-router/current)" = "$EXPECTED_ROUTER_CURRENT"
for unit in \
  "$ROUTER_SERVICE" "$WEB_SERVICE" "$APP_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" test "$(systemctl is-active "$unit")" = active
  must "pending_reload_${unit}" test "$(unit_value NeedDaemonReload "$unit")" = no
done
capture_protected_state
must fresh_source_boundary_failed private_regular "$SOURCE" "$(id -u codex8216)"
must primary_boundary_failed private_regular "$PRIMARY" 0
must secondary_boundary_failed private_regular "$TARGET" 0
must credential_validation_failed validate_credentials

if ! backup_directory=$(mktemp -d /run/m69-secondary-activation.XXXXXX); then
  printf 'activation_error=backup_directory_create_failed\n' >&2
  exit 1
fi
chmod 0700 "$backup_directory"
must backup_failed cp --preserve=mode,ownership,timestamps "$TARGET" "${backup_directory}/secondary.auth"
replacement="${TARGET}.activate.$$"
must replacement_stage_failed install -o root -g root -m 0600 "$SOURCE" "$replacement"
must replacement_failed mv -fT "$replacement" "$TARGET"
replacement_installed=1
must replacement_content_changed cmp -s "$SOURCE" "$TARGET"
must protected_service_changed expect_protected_unchanged
must router_restart_failed systemctl restart "$ROUTER_SERVICE"

ready=0
for attempt in $(seq 1 150); do
  if test "$(systemctl is-active "$ROUTER_SERVICE" 2>/dev/null || true)" = active &&
    ready_with_two_accounts; then
    ready=1
    break
  fi
  sleep 0.2
done
must router_readiness_failed test "$ready" -eq 1
must router_pid_unchanged test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID_BEFORE"
must protected_service_changed expect_protected_unchanged
must replacement_content_changed cmp -s "$SOURCE" "$TARGET"

rm -rf -- "$SOURCE_DIRECTORY"
rm -rf -- "$backup_directory"
backup_directory=
success=1
trap - EXIT
printf 'activation_status=success\n'
printf 'secondary_credential_replaced=true\n'
printf 'secondary_distinct_from_primary=true\n'
printf 'router_ready_with_two_accounts=true\n'
printf 'r92_web_app_unchanged=true\n'
printf 'standalone_8215_unchanged=true\n'
