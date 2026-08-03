#!/usr/bin/env bash
set -euo pipefail

readonly INPUT_ROOT="${R127_INPUT_ROOT:-/tmp/codex-r127-deploy-inputs}"
readonly ROUTER_VERSION=0.2.38
readonly ROUTER_RELEASE_NAME="codex-account-router-${ROUTER_VERSION}-linux-x64"
readonly ROUTER_ARCHIVE="${INPUT_ROOT}/${ROUTER_RELEASE_NAME}.tar.gz"
readonly ROUTER_ARCHIVE_SHA256=c27b292494dba853b922cdf3a3c0dff9d83f3a9ad40400122f43829d32e7bbc4
readonly TRANSFORMER="${INPUT_ROOT}/replace-r127-startup-split.mjs"
readonly TRANSFORMER_SHA256=3378acf1ba54486e87589465ce4ff21c0a720e352d1fc42275bca7d92cbc265b
readonly BROWSER_ASSETS="${INPUT_ROOT}/browser-assets"
readonly SERVER_ASSETS="${INPUT_ROOT}/server-assets"

readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_OLD="${ROUTER_ROOT}/releases/codex-account-router-0.2.37-linux-x64"
readonly ROUTER_NEW="${ROUTER_ROOT}/releases/${ROUTER_RELEASE_NAME}"
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_OLD="${WEB_ROOT}/releases/c3e92f0f-20260803-m69-router-r123-current-quota-identity"
readonly WEB_RELEASE_NAME=c3e92f0f-20260804-m69-router-r127-event-split
readonly WEB_NEW="${WEB_ROOT}/releases/${WEB_RELEASE_NAME}"
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly APP_SERVICE=codex-web-router-app-server.service
readonly WEB_SERVICE=codex-web-router.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly APP_CREDENTIAL=/etc/codex-account-router/credentials/app-server-auth.json
readonly UPLOAD_ROOT=/var/lib/codex-web-router/uploads

success=0
mutation_started=0
router_created=0
web_created=0
router_switched=0
web_switched=0
workdir=
declare -A UNIT_HASH_BEFORE=()

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
        if(s.status!=="ready"||typeof alias!=="string"||!/^[A-Za-z0-9._-]{1,64}$/u.test(alias)||
          !Array.isArray(s.accounts))process.exit(3);
        process.stdout.write(`${alias}|${s.active_requests}|${s.active_streams}|${s.accounts.length}\n`);
      });
    });req.on("timeout",()=>req.destroy(new Error("timeout")));req.on("error",()=>process.exit(4));req.end();
  '
}

switch_router() {
  local alias=$1
  env EXPECTED_ALIAS="$alias" /usr/bin/node -e '
    const fs=require("node:fs"),http=require("node:http"),alias=process.env.EXPECTED_ALIAS;
    if(!/^(?:Primary|Secondary)$/u.test(alias))process.exit(1);
    const token=fs.readFileSync("/etc/codex-account-router/credentials/admin-token","utf8").trim();
    const body=JSON.stringify({account_alias:alias,reason:"manual"});
    const req=http.request({host:"127.0.0.1",port:18318,path:"/v1/switch",method:"POST",timeout:5000,
      headers:{authorization:`Bearer ${token}`,accept:"application/json","content-type":"application/json",
        "content-length":Buffer.byteLength(body)}},res=>{const chunks=[];res.on("data",c=>chunks.push(c));
      res.on("end",()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if(res.statusCode!==200||value?.account_alias!==alias||value?.continuity!=="new_backend_session")process.exit(2);
      }catch{process.exit(3)}})});req.on("timeout",()=>req.destroy());req.on("error",()=>process.exit(4));req.end(body);
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
    socket.on("end",()=>{try{const value=JSON.parse(body),alias=value.account_alias;
      if(value.ok!==true||value.event!=="router_account_observer_ready"||value.credentials_exposed!==false||
        value.configured_accounts!==2||typeof alias!=="string"||!/^(?:Primary|Secondary)$/u.test(alias))fail();
      done=true;process.stdout.write(alias);}catch{fail()}});
  '
}

credential_identity() {
  /usr/bin/node -e '
    const fs=require("node:fs"),path=require("node:path");
    const config=JSON.parse(fs.readFileSync("/etc/codex-account-router/accounts.json","utf8"));
    const current=fs.readFileSync("/etc/codex-account-router/credentials/app-server-auth.json");
    const matches=[];
    for(const account of config.accounts??[]){const alias=account?.alias,ref=account?.credential_ref;
      if(account?.enabled!==true||!/^(?:Primary|Secondary)$/u.test(alias)||typeof ref!=="string"||path.basename(ref)!==ref)continue;
      if(fs.readFileSync(path.join("/etc/credstore",ref)).equals(current))matches.push(alias);
    }
    if(matches.length!==1)process.exit(1);process.stdout.write(matches[0]);
  '
}

wait_stack_ready() {
  local ready=0
  for _attempt in $(seq 1 160); do
    if expect_active "$ROUTER_SERVICE" && expect_active "$MANAGER_SERVICE" && expect_active "$MANAGER_SOCKET" &&
       expect_active "$APP_SERVICE" && expect_active "$WEB_SERVICE" &&
       test -S /run/codex-web-router-app-server/app-server.sock &&
       curl --noproxy '*' -fsS --max-time 2 -H 'Host: 100.95.50.98:8216' http://127.0.0.1:8216/__backend/healthz >/dev/null; then
      ready=1; break
    fi
    sleep 0.25
  done
  [[ "$ready" -eq 1 ]]
}

wait_identity() {
  local expected=$1 ready=0
  for _attempt in $(seq 1 160); do
    local state alias requests streams accounts
    state=$(router_state 2>/dev/null || true)
    IFS='|' read -r alias requests streams accounts <<<"$state"
    if [[ "$alias" == "$expected" && "$requests" == 0 && "$streams" == 0 && "$accounts" == 2 ]] &&
       [[ "$(manager_identity 2>/dev/null || true)" == "$expected" ]] &&
       [[ "$(credential_identity 2>/dev/null || true)" == "$expected" ]] &&
       expect_active "$APP_SERVICE" && expect_active "$WEB_SERVICE"; then ready=1; break; fi
    sleep 0.25
  done
  [[ "$ready" -eq 1 ]]
}

app_account_ready() {
  /usr/bin/node -e '
    const net=require("node:net");
    const WebSocket=require("/opt/0xcaff-codex-web-router/current/node_modules/ws");
    let initialized=false,settled=false;
    const socket=new WebSocket("ws://localhost/",{createConnection:()=>net.createConnection("/run/codex-web-router-app-server/app-server.sock"),maxPayload:1_048_576,perMessageDeflate:false});
    const finish=code=>{if(settled)return;settled=true;clearTimeout(timer);process.exitCode=code;
      if(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING)socket.close()};
    const timer=setTimeout(()=>finish(1),5000);
    socket.once("error",()=>finish(1));socket.once("close",()=>{if(!settled)finish(1)});
    socket.once("open",()=>socket.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"m69_r127_recovery",title:"M6.9 R127 recovery",version:"0.1.0"},capabilities:{experimentalApi:true}}})));
    socket.on("message",data=>{let value;try{value=JSON.parse(data.toString())}catch{return}
      if(value.id===1&&!value.error&&!initialized){initialized=true;socket.send(JSON.stringify({method:"initialized",params:{}}));socket.send(JSON.stringify({id:2,method:"account/read",params:{refreshToken:false}}));return}
      if(value.id===2)finish(value.error||value.result?.account==null?1:0)});
  '
}

verify_browser() {
  local cookies="$workdir/cookies" headers="$workdir/headers" body="$workdir/preload.br"
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "$cookies" http://127.0.0.1:8216/ >"$workdir/index.html" || return 1
  grep -Fq './assets/preload-96037be1.js' "$workdir/index.html" || return 1
  ! grep -Fq 'account-settings-window-C1CW0Ui2.mjs' "$workdir/index.html" || return 1
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "$cookies" http://127.0.0.1:8216/__backend/session >"$workdir/session.json" || return 1
  /usr/bin/node -e 'const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(typeof v?.csrfToken!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(v.csrfToken)||Number.isNaN(Date.parse(v.expiresAt)))process.exit(1)' \
    "$workdir/session.json" || return 1
  curl --noproxy '*' -fsS --max-time 8 -D "$headers" -o "$body" -H 'Host: 100.95.50.98:8216' \
    -H 'Accept-Encoding: gzip, deflate, br' http://127.0.0.1:8216/assets/preload-96037be1.js || return 1
  grep -Eiq '^content-encoding:[[:space:]]*br' "$headers" || return 1
  /usr/bin/node -e 'const fs=require("node:fs"),z=require("node:zlib"),c=require("node:crypto");
    const raw=z.brotliDecompressSync(fs.readFileSync(process.argv[1]));
    if(c.createHash("sha256").update(raw).digest("hex")!=="96037be170c5c6f8f87024de9085c7f7dc80171d4711c015960ff14b1b438647")process.exit(1)' "$body" || return 1
  for asset in account-settings-window-C1CW0Ui2.mjs workspace-root-dialog-CTNvLaH0.mjs \
    jsx-runtime-BhZVp74s.mjs rolldown-runtime-7_rZTKki.mjs; do
    curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' \
      "http://127.0.0.1:8216/assets/$asset" >/dev/null || return 1
  done
}

verify_unit_hashes() {
  local unit
  for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$APP_SERVICE" "$WEB_SERVICE" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_sha256 "$unit")" == "${UNIT_HASH_BEFORE[$unit]}" ]] || return 1
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_8215() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START" ]] || return 1
  verify_unit_hashes
}

verify_event_telemetry() {
  local since=$1
  journalctl -u "$MANAGER_SERVICE" --since "@$since" --no-pager -o cat | /usr/bin/node -e '
    const fs=require("node:fs"),lines=fs.readFileSync(0,"utf8").split("\n");const records=[];
    for(const line of lines){if(!line.startsWith("{\"event\":\"native_identity_sync\""))continue;
      let value;try{value=JSON.parse(line)}catch{process.exit(1)}
      const keys=Object.keys(value).sort().join(",");
      if(keys!=="credentials_exposed,elapsed_ms,event,route_attempts,stage,switch_reason,sync_attempts,trigger"||
        value.trigger!=="router_switch_event"||value.stage!=="completed"||value.switch_reason!=="manual"||
        value.credentials_exposed!==false||!Number.isSafeInteger(value.elapsed_ms)||!Number.isSafeInteger(value.sync_attempts))continue;
      records.push(value);
    }
    if(records.length<2)process.exit(2);
    const last=records.slice(-2);
    process.stdout.write(`event_sync_records=${last.length}\nevent_sync_max_elapsed_ms=${Math.max(...last.map(v=>v.elapsed_ms))}\nevent_sync_max_attempts=${Math.max(...last.map(v=>v.sync_attempts))}\n`);
  '
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$mutation_started" -eq 1 ]]; then
      if [[ "$router_switched" -eq 1 ]]; then
        ln -s "$ROUTER_OLD" "${ROUTER_ROOT}/.current-r127-rollback.$$" &&
          replace_link "${ROUTER_ROOT}/.current-r127-rollback.$$" "$ROUTER_CURRENT" || true
      fi
      if [[ "$web_switched" -eq 1 ]]; then
        ln -s "$WEB_OLD" "${WEB_ROOT}/.current-r127-rollback.$$" &&
          replace_link "${WEB_ROOT}/.current-r127-rollback.$$" "$WEB_CURRENT" || true
      fi
      systemctl restart "$ROUTER_SERVICE" >/dev/null 2>&1 || true
      systemctl restart "$MANAGER_SERVICE" >/dev/null 2>&1 || true
      systemctl restart "$APP_SERVICE" >/dev/null 2>&1 || true
      systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
      sleep 1
      [[ -z "${ROUTE_BEFORE:-}" ]] || switch_router "$ROUTE_BEFORE" >/dev/null 2>&1 || true
      printf 'deployment_status=rolled_back\n'
    fi
    [[ "$web_created" -eq 0 ]] || rm -rf -- "$WEB_NEW"
    [[ "$router_created" -eq 0 ]] || rm -rf -- "$ROUTER_NEW"
  fi
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  if [[ -n "${STANDALONE_WEB_PID:-}" ]]; then verify_8215 || code=1; fi
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r127-deploy.XXXXXX)
for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$APP_SERVICE" "$WEB_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
  UNIT_HASH_BEFORE[$unit]=$(unit_sha256 "$unit")
  must "pending_reload_${unit}" test "$(unit_value NeedDaemonReload "$unit")" = no
done
must unexpected_router_current test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_OLD"
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$WEB_OLD"
must unexpected_8215_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must router_successor_exists test ! -e "$ROUTER_NEW"
must web_successor_exists test ! -e "$WEB_NEW"
must archive_changed test "$(sha256 "$ROUTER_ARCHIVE")" = "$ROUTER_ARCHIVE_SHA256"
must transformer_changed test "$(sha256 "$TRANSFORMER")" = "$TRANSFORMER_SHA256"

STANDALONE_WEB_PID=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
ROUTER_PID=$(unit_value MainPID "$ROUTER_SERVICE")
MANAGER_PID=$(unit_value MainPID "$MANAGER_SERVICE")
APP_PID=$(unit_value MainPID "$APP_SERVICE")
WEB_PID=$(unit_value MainPID "$WEB_SERVICE")
APP_CREDENTIAL_SHA256=$(sha256 "$APP_CREDENTIAL")
UPLOAD_IDENTITY=$(stat -Lc '%d:%i:%a:%u:%g' "$UPLOAD_ROOT")
IFS='|' read -r ROUTE_BEFORE REQUESTS_BEFORE STREAMS_BEFORE ACCOUNTS_BEFORE <<<"$(router_state)"
must route_not_secondary test "$ROUTE_BEFORE" = Secondary
must active_requests_nonzero test "$REQUESTS_BEFORE" = 0
must active_streams_nonzero test "$STREAMS_BEFORE" = 0
must configured_accounts_changed test "$ACCOUNTS_BEFORE" = 2
must manager_identity_mismatch test "$(manager_identity)" = Secondary
must credential_identity_mismatch test "$(credential_identity)" = Secondary
must upload_root_changed test "$UPLOAD_IDENTITY" = "$(stat -Lc '%d:%i:700:%u:%g' "$UPLOAD_ROOT")"
must standalone_changed verify_8215

mkdir "$workdir/router"
tar -xzf "$ROUTER_ARCHIVE" --no-same-owner -C "$workdir/router"
must router_manifest_missing test -f "$workdir/router/${ROUTER_RELEASE_NAME}/manifest.json"
must router_manifest_changed env EXPECTED_VERSION="$ROUTER_VERSION" /usr/bin/node -e '
  const fs=require("node:fs"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(m?.version!==process.env.EXPECTED_VERSION||m?.target?.os!=="linux"||m?.target?.architecture!=="x64")process.exit(1)' \
  "$workdir/router/${ROUTER_RELEASE_NAME}/manifest.json"
must archive_symlink test -z "$(find "$workdir/router/${ROUTER_RELEASE_NAME}" -type l -print -quit)"
must web_create mkdir -m 0755 "$WEB_NEW"
web_created=1
must web_copy cp -a --reflink=auto "$WEB_OLD/." "$WEB_NEW/"
must web_symlink test -z "$(find "$WEB_NEW" -type l -print -quit)"
must web_transform /usr/bin/node "$TRANSFORMER" --candidate "$WEB_NEW" \
  --browser-assets "$BROWSER_ASSETS" --server-assets "$SERVER_ASSETS" >"$workdir/transform.json"
must web_transform_event /usr/bin/node -e '
  const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(v?.event!=="r127_startup_split_installed"||v?.preload_name!=="preload-96037be1.js"||
    v?.exact_telemetry_short_circuit!==true||v?.brotli_preferred!==true)process.exit(1)' "$workdir/transform.json"
must standalone_changed_before_mutation verify_8215

mutation_started=1
router_staging="${ROUTER_ROOT}/releases/.${ROUTER_RELEASE_NAME}.r127.$$"
must router_stage mkdir "$router_staging"
must router_copy cp -a "$workdir/router/${ROUTER_RELEASE_NAME}/." "$router_staging/"
must router_activate mv "$router_staging" "$ROUTER_NEW"
router_created=1
must router_link ln -s "releases/${ROUTER_RELEASE_NAME}" "${ROUTER_ROOT}/.current-r127.$$"
must router_switch_link replace_link "${ROUTER_ROOT}/.current-r127.$$" "$ROUTER_CURRENT"
router_switched=1
must web_link ln -s "$WEB_NEW" "${WEB_ROOT}/.current-r127.$$"
must web_switch_link replace_link "${WEB_ROOT}/.current-r127.$$" "$WEB_CURRENT"
web_switched=1
must router_restart systemctl restart "$ROUTER_SERVICE"
must manager_restart systemctl restart "$MANAGER_SERVICE"
must app_restart systemctl restart "$APP_SERVICE"
must web_restart systemctl restart "$WEB_SERVICE"
must readiness_failed wait_stack_ready
must route_restore_failed wait_identity Secondary
must app_account_missing app_account_ready
must browser_restore_failed verify_browser
must credential_changed test "$(sha256 "$APP_CREDENTIAL")" = "$APP_CREDENTIAL_SHA256"
must upload_root_not_persistent test "$(stat -Lc '%d:%i:%a:%u:%g' "$UPLOAD_ROOT")" = "$UPLOAD_IDENTITY"
must router_not_restarted test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID"
must manager_not_restarted test "$(unit_value MainPID "$MANAGER_SERVICE")" != "$MANAGER_PID"
must app_not_restarted test "$(unit_value MainPID "$APP_SERVICE")" != "$APP_PID"
must web_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID"
must current_router_changed test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_NEW"
must current_web_changed test "$(readlink -f "$WEB_CURRENT")" = "$WEB_NEW"
must standalone_changed_after_restart verify_8215

sleep 1
EVENT_SINCE=$(date +%s)
PRIMARY_STARTED=$(date +%s%3N)
must primary_switch_rejected switch_router Primary
must primary_identity_timeout wait_identity Primary
PRIMARY_ELAPSED=$(( $(date +%s%3N) - PRIMARY_STARTED ))
SECONDARY_STARTED=$(date +%s%3N)
must secondary_switch_rejected switch_router Secondary
must secondary_identity_timeout wait_identity Secondary
SECONDARY_ELAPSED=$(( $(date +%s%3N) - SECONDARY_STARTED ))
must app_account_missing_after_roundtrip app_account_ready
must browser_restore_failed_after_roundtrip verify_browser
must event_telemetry_missing verify_event_telemetry "$EVENT_SINCE" >"$workdir/event-metrics"
must credential_changed_after_roundtrip test "$(sha256 "$APP_CREDENTIAL")" = "$APP_CREDENTIAL_SHA256"
must upload_root_changed_after_roundtrip test "$(stat -Lc '%d:%i:%a:%u:%g' "$UPLOAD_ROOT")" = "$UPLOAD_IDENTITY"
must standalone_changed_after_roundtrip verify_8215

success=1
trap - EXIT
printf 'deployment_status=success\n'
printf 'router_release=%s\nweb_release=%s\n' "$ROUTER_RELEASE_NAME" "$WEB_RELEASE_NAME"
printf 'configured_accounts=2\nroute_restored=Secondary\nnative_identity_restored=Secondary\n'
printf 'primary_event_sync_elapsed_ms=%s\nsecondary_event_sync_elapsed_ms=%s\n' "$PRIMARY_ELAPSED" "$SECONDARY_ELAPSED"
cat "$workdir/event-metrics"
printf 'app_account_present=true\nlogin_state_restored=true\nupload_root_persistent=true\n'
printf 'initial_preload_bytes=26335\naccount_settings_deferred=true\nworkspace_dialog_deferred=true\nreact_client_deferred=true\nbrotli_preferred=true\n'
printf 'model_request_sent=false\nsemantic_output_replayed=false\nstandalone_8215_unchanged=true\n'
rm -rf -- "$workdir"
