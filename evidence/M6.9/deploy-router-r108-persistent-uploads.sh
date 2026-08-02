#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260803-m69-router-r108-persistent-uploads
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r107-device-code-copy"
readonly SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_CURRENT=/opt/codex-account-router/releases/codex-account-router-0.2.33-linux-x64
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INPUT_ROOT="${R108_INPUT_ROOT:-/tmp/codex-r108-deploy-inputs}"
readonly PATCHER_SOURCE="${INPUT_ROOT}/replace-r108-persistent-uploads.mjs"
readonly STORE_SOURCE="${INPUT_ROOT}/browser-upload-store-standalone.cjs"
readonly WEB_DROPIN_SOURCE="${INPUT_ROOT}/web-upload-persistence.conf"
readonly APP_DROPIN_SOURCE="${INPUT_ROOT}/app-upload-persistence.conf"
readonly WEB_DROPIN=/etc/systemd/system/codex-web-router.service.d/upload-persistence.conf
readonly APP_DROPIN=/etc/systemd/system/codex-web-router-app-server.service.d/upload-persistence.conf
readonly UPLOAD_ROOT=/var/lib/codex-web-router/uploads

readonly PATCHER_SHA256=dd8589083a0185012584d5a5d2fdd8720941f56553aa513e9c1c94fe5356eb16
readonly STORE_SHA256=dc4b24079c008dd8517f2715d804fd298d1ab181beea2ae7ebf5a196fa5177fc
readonly WEB_DROPIN_SHA256=cd93a89c323a49b4d80a9a3bfcdc9acd2c96c034a0211cb8b55a123912190eec
readonly APP_DROPIN_SHA256=da8aa6d1246d8e07daca6cdf3ce27defc110a36df390c85b5187f385a048864b
readonly SOURCE_MAIN_SHA256=e6e932f951b3c3aca875775c1e70984e54af707e368e54bb709e143db0970dfc
readonly SUCCESSOR_MAIN_SHA256=b9f1d11db2145b5a03b77ca8a662d88d2811fb9bba1d23f4be3634eab3ff9292

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly WEB_UNIT_SHA256=d69e1316de1411ffed0bbfa60f2a58da83b017f91f25ea856e10e9324e571b61
readonly APP_UNIT_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef
readonly ROUTER_UNIT_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
readonly MANAGER_SERVICE_UNIT_SHA256=2d3d7d86e84ee12bd2807c01f8650e4feb50798dad4ee8d6ee9cc9ad6c3f8e8a
readonly MANAGER_SOCKET_UNIT_SHA256=73e7c827dbaf0a5e4bafc8d29d48fead8d515c45fac015ac9166698d9ba55dba
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_UNIT_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3

success=0
successor_created=0
current_switched=0
dropins_installed=0
snapshot_complete=0
current_before=
uploaded_path=
workdir=

sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_value() { systemctl show -p "$1" --value "$2"; }
unit_sha256() { systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1; }
must() { local label=$1; shift; "$@" || { printf 'deployment_error=%s\n' "$label" >&2; exit 1; }; }
expect_active() { [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]; }

replace_link() {
  if mv --help 2>&1 | grep -q -- '-T'; then mv -Tf "$1" "$2"; else mv -hf "$1" "$2"; fi
}

private_inventory_hash() {
  INVENTORY_ROOT="$1" /usr/bin/node -e '
    const fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto");
    const root=process.env.INVENTORY_ROOT, aggregate=crypto.createHash("sha256");
    for (const name of fs.readdirSync(root).sort()) {
      const target=path.join(root,name), stat=fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
      aggregate.update(name); aggregate.update("\0"); aggregate.update(fs.readFileSync(target));
      aggregate.update("\0"); aggregate.update(String(stat.mode & 0o777)); aggregate.update("\0");
    }
    process.stdout.write(aggregate.digest("hex"));
  '
}

verify_units_pre() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_SERVICE_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

verify_no_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

snapshot_protected() {
  STANDALONE_WEB_PID_BEFORE=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
  STANDALONE_WEB_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
  STANDALONE_APP_PID_BEFORE=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
  STANDALONE_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
  ROUTED_APP_PID_BEFORE=$(unit_value MainPID "$APP_SERVICE")
  ROUTED_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
  ROUTER_PID_BEFORE=$(unit_value MainPID "$ROUTER_SERVICE")
  ROUTER_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")
  MANAGER_PID_BEFORE=$(unit_value MainPID "$MANAGER_SERVICE")
  MANAGER_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")
  MANAGER_SOCKET_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SOCKET")
  WEB_PID_BEFORE=$(unit_value MainPID "$WEB_SERVICE")
  ACCOUNTS_SHA_BEFORE=$(sha256 /etc/codex-account-router/accounts.json)
  CREDENTIALS_SHA_BEFORE=$(private_inventory_hash /etc/credstore)
  ADMIN_CREDENTIALS_SHA_BEFORE=$(private_inventory_hash /etc/codex-account-router/credentials)
  snapshot_complete=1
}

verify_protected() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(readlink -f /opt/codex-account-router/current)" == "$ROUTER_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$ROUTED_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$ROUTED_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$ROUTER_SERVICE")" == "$ROUTER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")" == "$ROUTER_START_BEFORE" ]] || return 1
  [[ "$(unit_value MainPID "$MANAGER_SERVICE")" == "$MANAGER_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")" == "$MANAGER_START_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_START_BEFORE" ]] || return 1
  [[ "$(sha256 /etc/codex-account-router/accounts.json)" == "$ACCOUNTS_SHA_BEFORE" ]] || return 1
  [[ "$(private_inventory_hash /etc/credstore)" == "$CREDENTIALS_SHA_BEFORE" ]] || return 1
  [[ "$(private_inventory_hash /etc/codex-account-router/credentials)" == "$ADMIN_CREDENTIALS_SHA_BEFORE" ]]
}

verify_dropins() {
  [[ -f "$WEB_DROPIN" && ! -L "$WEB_DROPIN" && "$(sha256 "$WEB_DROPIN")" == "$WEB_DROPIN_SHA256" ]] || return 1
  [[ -f "$APP_DROPIN" && ! -L "$APP_DROPIN" && "$(sha256 "$APP_DROPIN")" == "$APP_DROPIN_SHA256" ]] || return 1
  systemctl show -p Environment --value "$WEB_SERVICE" | grep -Fq 'CODEX_WEB_UPLOAD_ROOT=/var/lib/codex-web-router/uploads' || return 1
  systemctl show -p Environment --value "$WEB_SERVICE" | grep -Fq 'CODEX_WEB_UPLOAD_PERSIST=1' || return 1
  systemctl show -p ReadWritePaths --value "$WEB_SERVICE" | grep -Fq '/var/lib/codex-web-router/uploads' || return 1
  systemctl show -p ReadOnlyPaths --value "$APP_SERVICE" | grep -Fq '/var/lib/codex-web-router/uploads'
}

browser_ready() {
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >/dev/null || return 1
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/session >"$workdir/session.json" || return 1
  /usr/bin/node -e '
    const fs=require("node:fs"), value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if (typeof value?.csrfToken!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) process.exit(1);
  ' "$workdir/session.json"
}

upload_fixture() {
  local csrf
  printf 'r108 persistent upload fixture\n' >"$workdir/fixture.txt"
  csrf=$(/usr/bin/node -e '
    const fs=require("node:fs"), value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    process.stdout.write(value.csrfToken);
  ' "$workdir/session.json")
  curl --noproxy '*' -fsS --max-time 10 -X POST \
    -H 'Host: 100.95.50.98:8216' \
    -H 'Origin: http://100.95.50.98:8216' \
    -H 'Sec-Fetch-Site: same-origin' \
    -H 'Accept: application/json' \
    -H "x-codex-csrf: $csrf" \
    -b "$workdir/cookies" \
    -F 'file=@'"$workdir/fixture.txt"';type=text/plain;filename=r108-persistence-fixture.txt' \
    http://127.0.0.1:8216/__backend/upload >"$workdir/upload.json"
  uploaded_path=$(/usr/bin/node -e '
    const fs=require("node:fs"), value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const file=value?.files?.[0], expected=/^\/var\/lib\/codex-web-router\/uploads\/[0-9a-f-]{36}$/;
    if (value.files?.length!==1 || file?.label!=="r108-persistence-fixture.txt" ||
        file.path!==file.fsPath || !expected.test(file.path)) process.exit(1);
    process.stdout.write(file.path);
  ' "$workdir/upload.json")
  [[ "$(stat -c '%U:%G:%a' "$uploaded_path")" == codex8216:codex8216:600 ]] || return 1
  cmp -s "$workdir/fixture.txt" "$uploaded_path" || return 1
  nsenter -t "$ROUTED_APP_PID_BEFORE" -m -- /usr/sbin/runuser -u codex8216 -- test -r "$uploaded_path"
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ -n "$uploaded_path" && "$uploaded_path" =~ ^/var/lib/codex-web-router/uploads/[0-9a-f-]{36}$ ]]; then
    rm -f -- "$uploaded_path"
  fi
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 && -n "$current_before" ]]; then
      local rollback_link="${WEB_ROOT}/.current-r108-rollback.$$"
      ln -s "$current_before" "$rollback_link"
      replace_link "$rollback_link" "$WEB_CURRENT"
    fi
    if [[ "$dropins_installed" -eq 1 ]]; then
      rm -f -- "$WEB_DROPIN" "$APP_DROPIN"
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if [[ "$current_switched" -eq 1 ]]; then systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true; fi
    if [[ "$successor_created" -eq 1 ]]; then rm -rf -- "$SUCCESSOR"; fi
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  if [[ "$snapshot_complete" -eq 1 ]]; then verify_protected || code=1; fi
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r108-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must units_changed verify_units_pre
must pending_daemon_reload verify_no_pending_reload
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f /opt/codex-account-router/current)" = "$ROUTER_CURRENT"
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must source_main_changed test "$(sha256 "$EXPECTED_CURRENT/src/server/main.js")" = "$SOURCE_MAIN_SHA256"
must source_store_unexpected test ! -e "$EXPECTED_CURRENT/src/server/browser-upload-store.js"
must patcher_changed test "$(sha256 "$PATCHER_SOURCE")" = "$PATCHER_SHA256"
must store_changed test "$(sha256 "$STORE_SOURCE")" = "$STORE_SHA256"
must web_dropin_source_changed test "$(sha256 "$WEB_DROPIN_SOURCE")" = "$WEB_DROPIN_SHA256"
must app_dropin_source_changed test "$(sha256 "$APP_DROPIN_SOURCE")" = "$APP_DROPIN_SHA256"
must web_dropin_exists test ! -e "$WEB_DROPIN"
must app_dropin_exists test ! -e "$APP_DROPIN"
must successor_exists test ! -e "$SUCCESSOR"
snapshot_protected
must protected_changed verify_protected

must successor_create mkdir "$SUCCESSOR"
successor_created=1
must successor_copy cp -a --reflink=auto "$EXPECTED_CURRENT/." "$SUCCESSOR/"
must persistent_patch /usr/bin/node "$PATCHER_SOURCE" --candidate "$SUCCESSOR" --upload-store "$STORE_SOURCE"
must successor_main_changed test "$(sha256 "$SUCCESSOR/src/server/main.js")" = "$SUCCESSOR_MAIN_SHA256"
must successor_store_changed test "$(sha256 "$SUCCESSOR/src/server/browser-upload-store.js")" = "$STORE_SHA256"
must successor_main_syntax /usr/bin/node --check "$SUCCESSOR/src/server/main.js"
must successor_store_syntax /usr/bin/node --check "$SUCCESSOR/src/server/browser-upload-store.js"
must successor_temp_marker_removed test -z "$(grep -E 'codex-web-uploads-|toBuffer\(\)|root: "/"' "$SUCCESSOR/src/server/main.js" || true)"
must successor_symlinks test -z "$(find "$SUCCESSOR" -type l -print -quit)"
must protected_changed verify_protected

must upload_root_create install -d -o codex8216 -g codex8216 -m 0700 "$UPLOAD_ROOT"
must web_dropin_install install -o root -g root -m 0644 "$WEB_DROPIN_SOURCE" "$WEB_DROPIN"
must app_dropin_install install -o root -g root -m 0644 "$APP_DROPIN_SOURCE" "$APP_DROPIN"
dropins_installed=1
must daemon_reload systemctl daemon-reload
must dropins_invalid verify_dropins
must pending_daemon_reload verify_no_pending_reload

current_before=$(readlink -f "$WEB_CURRENT")
next_link="${WEB_ROOT}/.current-r108.$$"
must current_link ln -s "$SUCCESSOR" "$next_link"
must current_switch replace_link "$next_link" "$WEB_CURRENT"
current_switched=1
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$WEB_SERVICE" && browser_ready; then ready=1; break; fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must upload_failed upload_fixture
uploaded_sha_before=$(sha256 "$uploaded_path")

web_pid_after_first=$(unit_value MainPID "$WEB_SERVICE")
must persistence_restart systemctl restart "$WEB_SERVICE"
ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$WEB_SERVICE" && browser_ready; then ready=1; break; fi
  sleep 0.2
done
must persistence_readiness_failed test "$ready" -eq 1
must second_web_pid_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$web_pid_after_first"
must persistent_file_missing test -f "$uploaded_path"
must persistent_file_hash_changed test "$(sha256 "$uploaded_path")" = "$uploaded_sha_before"
must app_server_cannot_read nsenter -t "$ROUTED_APP_PID_BEFORE" -m -- /usr/sbin/runuser -u codex8216 -- test -r "$uploaded_path"
must protected_changed verify_protected
must dropins_invalid verify_dropins
must pending_daemon_reload verify_no_pending_reload
must current_not_successor test "$(readlink -f "$WEB_CURRENT")" = "$SUCCESSOR"

rm -f -- "$uploaded_path"
uploaded_path=
success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'release=%s\n' "$RELEASE_NAME"
printf 'upload_root=%s\n' "$UPLOAD_ROOT"
printf 'persistent_across_web_restart=true\n'
printf 'streaming_upload_limits=true\n'
printf 'arbitrary_filesystem_route_removed=true\n'
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'account_router_process_unchanged=true\n'
printf 'account_manager_process_unchanged=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
