#!/usr/bin/env bash
set -euo pipefail

readonly INPUT_ROOT="${R123_INPUT_ROOT:-/tmp/codex-r123-deploy-inputs}"
readonly ROUTER_VERSION=0.2.37
readonly ROUTER_RELEASE_NAME="codex-account-router-${ROUTER_VERSION}-linux-x64"
readonly ROUTER_ARCHIVE="${INPUT_ROOT}/${ROUTER_RELEASE_NAME}.tar.gz"
readonly ROUTER_ARCHIVE_SHA256=6bcd5e9cd0582d2b5aa30861ace2c2ca979cfaa559a1030b9c79805a9e20eb23
readonly TRANSFORMER="${INPUT_ROOT}/replace-r123-current-quota-identity.mjs"
readonly TRANSFORMER_SHA256=73c9e40e88d864d04c1296290385e544de40186d9df2acfbeeacbaeb806af0ed
readonly STATUS_BRIDGE="${INPUT_ROOT}/router-status-bridge-standalone.js"
readonly STATUS_BRIDGE_SHA256=30a7a21262e168269fd9be386a091310723b12b59e2e1c546a152ad836fdfce8

readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_OLD="${ROUTER_ROOT}/releases/codex-account-router-0.2.36-linux-x64"
readonly ROUTER_NEW="${ROUTER_ROOT}/releases/${ROUTER_RELEASE_NAME}"
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_OLD="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r122-native-menu-contract"
readonly WEB_RELEASE_NAME=c3e92f0f-20260803-m69-router-r123-current-quota-identity
readonly WEB_NEW="${WEB_ROOT}/releases/${WEB_RELEASE_NAME}"
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly OLD_PRELOAD=preload-ba57f3d6.js
readonly OLD_PRELOAD_SHA256=ba57f3d68765fd06d0830c8d1bae5d01c35b02835f71624607733dd869d82dfb
readonly OLD_INDEX_SHA256=ca1bd8b371a3001ef9bdaa5764c5da1a57b27206d2c7a10121a98791f02464d0
readonly CONTROLLER=router-account-controller-041ab79a.js
readonly CONTROLLER_SHA256=041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429
readonly APP=app-initial-BTphDPeq.js
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly SERVER_MAIN_SHA256=b9f1d11db2145b5a03b77ca8a662d88d2811fb9bba1d23f4be3634eab3ff9292
readonly UPLOAD_STORE_SHA256=dc4b24079c008dd8517f2715d804fd298d1ab181beea2ae7ebf5a196fa5177fc
readonly SESSION_AUTH_SHA256=7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6
readonly OLD_STATUS_BRIDGE_SHA256=ea4fdbf76505c7d8dc330fcbd415ccb8ac59c27493b62e171f5a7905952e9bdd
readonly ACCOUNT_MANAGEMENT_SHA256=d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly WEB_UNIT_SHA256=8a0abeb472d04caed6fbd0a7fac11918b0bd4c3c4e2cba920633ad041a3cf4d6
readonly APP_UNIT_SHA256=97f011bce6a11823db6e6faf19aa97998dbaafe36485698250e703319434665c
readonly ROUTER_UNIT_SHA256=7d9ff054181a94775d784182bdc17591e6eb8c8dccb4b034c82e6492373e84d7
readonly MANAGER_UNIT_SHA256=5bc481350f24ae3e338861f5afa57a844736a54d5da50618f9f3e8a764dae6f4
readonly MANAGER_SOCKET_UNIT_SHA256=73e7c827dbaf0a5e4bafc8d29d48fead8d515c45fac015ac9166698d9ba55dba
readonly STANDALONE_WEB_UNIT_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_UNIT_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3
readonly APP_CREDENTIAL=/etc/codex-account-router/credentials/app-server-auth.json

success=0
mutation_started=0
router_created=0
web_created=0
router_switched=0
web_switched=0
workdir=

sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
unit_value() { systemctl show -p "$1" --value "$2"; }
unit_sha256() { systemctl cat "$1" --no-pager 2>/dev/null | sha256sum | cut -d ' ' -f 1; }
expect_active() { [[ "$(systemctl is-active "$1" 2>/dev/null || true)" == active ]]; }
must() { local label=$1; shift; "$@" || { printf 'deployment_error=%s\n' "$label" >&2; exit 1; }; }
replace_link() {
  if mv --help 2>&1 | grep -q -- '-T'; then mv -Tf "$1" "$2"; else mv -hf "$1" "$2"; fi
}

router_state() {
  /usr/bin/node -e '
    const fs=require("node:fs"),http=require("node:http");
    const token=fs.readFileSync("/etc/codex-account-router/credentials/admin-token","utf8").trim();
    const req=http.request({host:"127.0.0.1",port:18318,path:"/v1/status",method:"GET",
      headers:{authorization:`Bearer ${token}`,accept:"application/json"},timeout:3000},res=>{
      const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{
        if(res.statusCode!==200)process.exit(2);
        const s=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const alias=s.current_route?.account_alias;
        if(s.status!=="ready"||typeof alias!=="string"||!/^[A-Za-z0-9._-]{1,64}$/u.test(alias))process.exit(3);
        process.stdout.write(`${alias}|${s.active_requests}|${s.active_streams}\n`);
      });
    });req.on("timeout",()=>req.destroy(new Error("timeout")));req.on("error",()=>process.exit(4));req.end();
  '
}

manager_identity() {
  /usr/bin/node -e '
    const net=require("node:net");let body="",done=false;
    const fail=()=>{if(!done){done=true;process.exit(1)}};
    const socket=net.createConnection("/run/codex-router-account-manager.sock");
    socket.setTimeout(3000,fail);socket.on("error",fail);
    socket.on("connect",()=>socket.write("{\"operation\":\"observe\"}\n"));
    socket.on("data",chunk=>{body+=chunk;if(Buffer.byteLength(body)>8192)fail()});
    socket.on("end",()=>{try{const value=JSON.parse(body);const alias=value.account_alias;
      if(value.ok!==true||value.event!=="router_account_observer_ready"||value.credentials_exposed!==false||
        !Number.isInteger(value.configured_accounts)||value.configured_accounts<1||
        typeof alias!=="string"||!/^[A-Za-z0-9._-]{1,64}$/u.test(alias))fail();
      done=true;process.stdout.write(alias);}catch{fail()}});
  '
}

credential_identity() {
  /usr/bin/node -e '
    const fs=require("node:fs"),path=require("node:path");
    const config=JSON.parse(fs.readFileSync("/etc/codex-account-router/accounts.json","utf8"));
    const current=fs.readFileSync("/etc/codex-account-router/credentials/app-server-auth.json");
    const matches=[];
    for(const account of config.accounts??[]){
      const alias=account?.alias,ref=account?.credential_ref;
      if(account?.enabled!==true||typeof alias!=="string"||!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(alias)||
        alias.includes("@")||typeof ref!=="string"||path.basename(ref)!==ref)continue;
      const target=fs.readFileSync(path.join("/etc/credstore",ref));
      if(target.equals(current))matches.push(alias);
    }
    if(matches.length!==1)process.exit(1);process.stdout.write(matches[0]);
  '
}

verify_units() {
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SERVICE")" == "$MANAGER_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$MANAGER_SOCKET")" == "$MANAGER_SOCKET_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_UNIT_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_UNIT_SHA256" ]]
}

verify_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_triplet() {
  /usr/bin/node -e '
    const fs=require("node:fs"),z=require("node:zlib"),p=process.argv[1],raw=fs.readFileSync(p);
    if(!raw.equals(z.gunzipSync(fs.readFileSync(`${p}.gz`))))process.exit(1);
    if(!raw.equals(z.brotliDecompressSync(fs.readFileSync(`${p}.br`))))process.exit(1);
  ' "$1"
}

verify_r122_source() {
  [[ "$(sha256 "${WEB_OLD}/${INDEX}")" == "$OLD_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/${ASSETS}/${OLD_PRELOAD}")" == "$OLD_PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/${ASSETS}/${CONTROLLER}")" == "$CONTROLLER_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/${ASSETS}/${APP}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/src/server/main.js")" == "$SERVER_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/src/server/browser-upload-store.js")" == "$UPLOAD_STORE_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/src/server/router-status-bridge.js")" == "$OLD_STATUS_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_OLD}/src/server/router-account-management.js")" == "$ACCOUNT_MANAGEMENT_SHA256" ]] || return 1
  verify_triplet "${WEB_OLD}/${INDEX}" || return 1
  verify_triplet "${WEB_OLD}/${ASSETS}/${OLD_PRELOAD}"
}

verify_8215() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START" ]] || return 1
  verify_units
}

verify_successor() {
  local result=$1 preload index_hash preload_hash
  preload=$(/usr/bin/node -e 'const v=require(process.argv[1]);process.stdout.write(v.react_preload_name)' "$result") || return 1
  index_hash=$(/usr/bin/node -e 'const v=require(process.argv[1]);process.stdout.write(v.index_sha256)' "$result") || return 1
  preload_hash=$(/usr/bin/node -e 'const v=require(process.argv[1]);process.stdout.write(v.react_preload_sha256)' "$result") || return 1
  [[ "$preload" =~ ^preload-[a-f0-9]{8}\.js$ ]] || return 1
  [[ "$(sha256 "${WEB_NEW}/${INDEX}")" == "$index_hash" ]] || return 1
  [[ "$(sha256 "${WEB_NEW}/${ASSETS}/${preload}")" == "$preload_hash" ]] || return 1
  [[ "$(sha256 "${WEB_NEW}/${ASSETS}/${CONTROLLER}")" == "$CONTROLLER_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_NEW}/src/server/router-status-bridge.js")" == "$STATUS_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${WEB_NEW}/src/server/router-account-management.js")" == "$ACCOUNT_MANAGEMENT_SHA256" ]] || return 1
  [[ ! -e "${WEB_NEW}/${ASSETS}/${OLD_PRELOAD}" ]] || return 1
  [[ "$(grep -Foc "./assets/${preload}" "${WEB_NEW}/${INDEX}")" == 1 ]] || return 1
  [[ "$(grep -Foc "./assets/${CONTROLLER}" "${WEB_NEW}/${INDEX}")" == 1 ]] || return 1
  grep -Fq 'Refresh current account weekly quota' "${WEB_NEW}/${ASSETS}/${preload}" || return 1
  ! grep -Fq 'Refresh Primary weekly quota' "${WEB_NEW}/${ASSETS}/${preload}" || return 1
  verify_triplet "${WEB_NEW}/${INDEX}" || return 1
  verify_triplet "${WEB_NEW}/${ASSETS}/${preload}"
}

browser_quota_ready() {
  local csrf route ratio status_ratio
  route=$(router_state); route=${route%%|*}
  : >"$workdir/cookies"
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$workdir/cookies" http://127.0.0.1:8216/ >"$workdir/index.html" || return 1
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/session >"$workdir/session.json" || return 1
  csrf=$(/usr/bin/node -e 'const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(0,"utf8"));
    if(typeof v?.csrfToken!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(v.csrfToken))process.exit(1);
    process.stdout.write(v.csrfToken)' <"$workdir/session.json") || return 1
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status >"$workdir/status-before.json" || return 1
  env EXPECTED_ALIAS="$route" /usr/bin/node -e 'const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),r=v?.router;
    const a=r?.accounts?.find(x=>x.alias===process.env.EXPECTED_ALIAS);
    if(r?.status!=="ready"||r?.active_requests!==0||r?.active_streams!==0||
      r?.current_route?.account_alias!==process.env.EXPECTED_ALIAS||a?.weekly_remaining_ratio!==null)process.exit(1)' \
    "$workdir/status-before.json" || return 1
  curl --noproxy '*' -fsS --max-time 8 -X POST -H 'Host: 100.95.50.98:8216' \
    -H 'Origin: http://100.95.50.98:8216' -H 'Sec-Fetch-Site: same-origin' \
    -H 'Content-Type: application/json' -H 'Accept: application/json' -H "x-codex-csrf: $csrf" \
    -b "$workdir/cookies" --data '{}' http://127.0.0.1:8216/__backend/codex-router/quota-refresh \
    >"$workdir/quota.json" || return 1
  ratio=$(env EXPECTED_ALIAS="$route" /usr/bin/node -e 'const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(v?.enabled!==true||v?.refreshed!==true||v?.account_alias!==process.env.EXPECTED_ALIAS||
      typeof v?.weekly_remaining_ratio!=="number"||v.weekly_remaining_ratio<=0||v.weekly_remaining_ratio>=1||
      typeof v?.snapshot_observed_at!=="string"||Number.isNaN(Date.parse(v.snapshot_observed_at)))process.exit(1);
    process.stdout.write(String(v.weekly_remaining_ratio))' "$workdir/quota.json") || return 1
  curl --noproxy '*' -fsS --max-time 4 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$workdir/cookies" http://127.0.0.1:8216/__backend/codex-router/status >"$workdir/status-after.json" || return 1
  status_ratio=$(env EXPECTED_ALIAS="$route" /usr/bin/node -e 'const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const a=v?.router?.accounts?.find(x=>x.alias===process.env.EXPECTED_ALIAS);
    if(typeof a?.weekly_remaining_ratio!=="number"||typeof a?.snapshot_observed_at!=="string")process.exit(1);
    process.stdout.write(String(a.weekly_remaining_ratio))' "$workdir/status-after.json") || return 1
  [[ "$status_ratio" == "$ratio" ]] || return 1
  printf 'verified_account_alias=%s\nverified_weekly_remaining_ratio=%s\n' "$route" "$ratio"
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$mutation_started" -eq 1 ]]; then
    if [[ "$router_switched" -eq 1 ]]; then
      ln -s "$ROUTER_OLD" "${ROUTER_ROOT}/.current-r123-rollback.$$" && \
        replace_link "${ROUTER_ROOT}/.current-r123-rollback.$$" "$ROUTER_CURRENT" || true
    fi
    if [[ "$web_switched" -eq 1 ]]; then
      ln -s "$WEB_OLD" "${WEB_ROOT}/.current-r123-rollback.$$" && \
        replace_link "${WEB_ROOT}/.current-r123-rollback.$$" "$WEB_CURRENT" || true
    fi
    systemctl restart "$ROUTER_SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$MANAGER_SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    [[ "$web_created" -eq 0 ]] || rm -rf -- "$WEB_NEW"
    [[ "$router_created" -eq 0 ]] || rm -rf -- "$ROUTER_NEW"
    printf 'deployment_status=rolled_back\n'
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  if [[ -n "${STANDALONE_WEB_PID:-}" ]]; then verify_8215 || code=1; fi
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r123-deploy.XXXXXX)
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do must "service_inactive_${unit}" expect_active "$unit"; done
must pending_reload verify_pending_reload
must unit_boundary_changed verify_units
must unexpected_router_current test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_OLD"
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$WEB_OLD"
must unexpected_8215_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must router_successor_exists test ! -e "$ROUTER_NEW"
must web_successor_exists test ! -e "$WEB_NEW"
must archive_changed test "$(sha256 "$ROUTER_ARCHIVE")" = "$ROUTER_ARCHIVE_SHA256"
must transformer_changed test "$(sha256 "$TRANSFORMER")" = "$TRANSFORMER_SHA256"
must bridge_changed test "$(sha256 "$STATUS_BRIDGE")" = "$STATUS_BRIDGE_SHA256"
must r122_source_changed verify_r122_source

STANDALONE_WEB_PID=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
APP_PID=$(unit_value MainPID "$APP_SERVICE")
APP_START=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
APP_CREDENTIAL_SHA256=$(sha256 "$APP_CREDENTIAL")
ROUTER_PID=$(unit_value MainPID "$ROUTER_SERVICE")
MANAGER_PID=$(unit_value MainPID "$MANAGER_SERVICE")
WEB_PID=$(unit_value MainPID "$WEB_SERVICE")
IFS='|' read -r ROUTE_BEFORE REQUESTS_BEFORE STREAMS_BEFORE <<<"$(router_state)"
must active_requests_nonzero test "$REQUESTS_BEFORE" = 0
must active_streams_nonzero test "$STREAMS_BEFORE" = 0
must identity_mismatch test "$(credential_identity)" = "$ROUTE_BEFORE"
must standalone_changed verify_8215

mkdir "$workdir/router"
tar -xzf "$ROUTER_ARCHIVE" --no-same-owner -C "$workdir/router"
must manifest_missing test -f "$workdir/router/${ROUTER_RELEASE_NAME}/manifest.json"
must manifest_changed env EXPECTED_VERSION="$ROUTER_VERSION" /usr/bin/node -e '
  const fs=require("node:fs"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(m?.version!==process.env.EXPECTED_VERSION||m?.target?.os!=="linux"||m?.target?.architecture!=="x64")process.exit(1)
' "$workdir/router/${ROUTER_RELEASE_NAME}/manifest.json"
must archive_symlink test -z "$(find "$workdir/router/${ROUTER_RELEASE_NAME}" -type l -print -quit)"
must web_create mkdir -m 0755 "$WEB_NEW"
web_created=1
must web_copy cp -a --reflink=auto "$WEB_OLD/." "$WEB_NEW/"
must web_symlink test -z "$(find "$WEB_NEW" -type l -print -quit)"
must web_transform /usr/bin/node "$TRANSFORMER" --candidate "$WEB_NEW" --status-bridge "$STATUS_BRIDGE" \
  >"$workdir/transform.json"
must web_verify verify_successor "$workdir/transform.json"
must standalone_changed_before_mutation verify_8215

mutation_started=1
router_staging="${ROUTER_ROOT}/releases/.${ROUTER_RELEASE_NAME}.r123.$$"
must router_stage mkdir "$router_staging"
must router_copy cp -a "$workdir/router/${ROUTER_RELEASE_NAME}/." "$router_staging/"
must router_activate mv "$router_staging" "$ROUTER_NEW"
router_created=1
must router_link ln -s "releases/${ROUTER_RELEASE_NAME}" "${ROUTER_ROOT}/.current-r123.$$"
must router_switch replace_link "${ROUTER_ROOT}/.current-r123.$$" "$ROUTER_CURRENT"
router_switched=1
must web_link ln -s "$WEB_NEW" "${WEB_ROOT}/.current-r123.$$"
must web_switch replace_link "${WEB_ROOT}/.current-r123.$$" "$WEB_CURRENT"
web_switched=1
must router_restart systemctl restart "$ROUTER_SERVICE"
must manager_restart systemctl restart "$MANAGER_SERVICE"
must web_restart systemctl restart "$WEB_SERVICE"

ready=0
for _attempt in $(seq 1 120); do
  if expect_active "$ROUTER_SERVICE" && expect_active "$MANAGER_SERVICE" && expect_active "$MANAGER_SOCKET" && \
    expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE"; then ready=1; break; fi
  sleep 0.25
done
must readiness_failed test "$ready" -eq 1
IFS='|' read -r ROUTE_AFTER REQUESTS_AFTER STREAMS_AFTER <<<"$(router_state)"
must route_changed test "$ROUTE_AFTER" = "$ROUTE_BEFORE"
must active_requests_after test "$REQUESTS_AFTER" = 0
must active_streams_after test "$STREAMS_AFTER" = 0
must identity_mismatch_after test "$(manager_identity)" = "$ROUTE_AFTER"
must credential_identity_mismatch_after test "$(credential_identity)" = "$ROUTE_AFTER"
must credential_changed test "$(sha256 "$APP_CREDENTIAL")" = "$APP_CREDENTIAL_SHA256"
must app_pid_changed test "$(unit_value MainPID "$APP_SERVICE")" = "$APP_PID"
must app_start_changed test "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" = "$APP_START"
must router_not_restarted test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID"
must manager_not_restarted test "$(unit_value MainPID "$MANAGER_SERVICE")" != "$MANAGER_PID"
must web_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID"
must current_router_changed test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_NEW"
must current_web_changed test "$(readlink -f "$WEB_CURRENT")" = "$WEB_NEW"
must web_verify_after verify_successor "$workdir/transform.json"
must pending_reload_after verify_pending_reload
must standalone_changed_after verify_8215
must browser_quota_failed browser_quota_ready

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'router_release=%s\nweb_release=%s\n' "$ROUTER_RELEASE_NAME" "$WEB_RELEASE_NAME"
printf 'route_unchanged=true\nnative_identity_verified=true\nweekly_quota_refreshed_without_model=true\n'
printf 'routed_8216_app_server_unchanged=true\nstandalone_8215_unchanged=true\n'
printf 'model_request_sent=false\naccount_switch_sent=false\nsemantic_output_replayed=false\n'
