#!/usr/bin/env bash
set -euo pipefail

readonly INPUT_ROOT="${R129_INPUT_ROOT:-/tmp/codex-r129-deploy-inputs}"
readonly TRANSFORMER="${INPUT_ROOT}/replace-r129-mathproof-surface.mjs"
readonly TRANSFORMER_SHA256=b3007ea39b354d4227af727f726caea745cae7c63c4ac80bcdfd564ecf32fa03
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_OLD="${WEB_ROOT}/releases/c3e92f0f-20260804-m69-router-r127-event-split"
readonly WEB_RELEASE_NAME=c3e92f0f-20260804-m69-router-r129-mathproof-surface
readonly WEB_NEW="${WEB_ROOT}/releases/${WEB_RELEASE_NAME}"
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly APP_SERVICE=codex-web-router-app-server.service
readonly WEB_SERVICE=codex-web-router.service
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly UPLOAD_ROOT=/var/lib/codex-web-router/uploads
readonly APP_INITIAL=app-initial-BTphDPeq.js
readonly APP_INITIAL_SHA256=30f89afa313226c925e44c4fbfb6518f9c2760eeecc252addc4b0338f0505f7a
readonly STUB_NAMES_SHA256=a083d1e38496454a6bd8a8851ce27999f645afe79cfdda30a4e0d9594b605f83
readonly REMOVED_NAMES_SHA256=c44806f8a24a9999b4138291bf0ede8c571a787bb2312b4180d142c7ebea7cd1

success=0
mutation_started=0
web_created=0
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
    socket.once("open",()=>socket.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"m69_r129_mathproof",title:"M6.9 R129 MathProof",version:"0.1.0"},capabilities:{experimentalApi:true}}})));
    socket.on("message",data=>{let value;try{value=JSON.parse(data.toString())}catch{return}
      if(value.id===1&&!value.error&&!initialized){initialized=true;socket.send(JSON.stringify({method:"initialized",params:{}}));socket.send(JSON.stringify({id:2,method:"account/read",params:{refreshToken:false}}));return}
      if(value.id===2)finish(value.error||value.result?.account==null?1:0)});
  '
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

verify_8216_core() {
  [[ "$(unit_value MainPID "$ROUTER_SERVICE")" == "$ROUTER_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")" == "$ROUTER_START" ]] || return 1
  [[ "$(unit_value MainPID "$MANAGER_SERVICE")" == "$MANAGER_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")" == "$MANAGER_START" ]] || return 1
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$APP_PID" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$APP_START" ]] || return 1
  [[ "$(stat -Lc '%d:%i:%a:%u:%g' "$UPLOAD_ROOT")" == "$UPLOAD_IDENTITY" ]] || return 1
  local route requests streams accounts
  IFS='|' read -r route requests streams accounts <<<"$(router_state)"
  [[ "$route" == "$ROUTE_BEFORE" && "$requests" == 0 && "$streams" == 0 && "$accounts" == 2 ]]
}

wait_web_ready() {
  local ready=0
  for _attempt in $(seq 1 120); do
    if expect_active "$WEB_SERVICE" &&
       curl --noproxy '*' -fsS --max-time 2 -H 'Host: 100.95.50.98:8216' \
         http://127.0.0.1:8216/__backend/healthz >/dev/null; then ready=1; break; fi
    sleep 0.25
  done
  [[ "$ready" -eq 1 ]]
}

verify_browser() {
  local headers="$workdir/headers" body="$workdir/app-initial.br" root_status session_status
  root_status=$(curl --noproxy '*' -sS --max-time 5 -o "$workdir/index.html" -w '%{http_code}' \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' http://127.0.0.1:8216/) || return 1
  if [[ "$root_status" == 401 ]]; then
    /usr/bin/node -e 'const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if(v?.error!=="authentication_required")process.exit(1)' "$workdir/index.html" || return 1
    return 0
  fi
  [[ "$root_status" == 200 ]] || return 1
  grep -Fq "./assets/${APP_INITIAL}" "$workdir/index.html" || return 1
  grep -Fq './assets/preload-96037be1.js' "$workdir/index.html" || return 1
  session_status=$(curl --noproxy '*' -sS --max-time 5 -o "$workdir/session.json" -w '%{http_code}' \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    http://127.0.0.1:8216/__backend/session) || return 1
  env SESSION_STATUS="$session_status" /usr/bin/node -e '
    const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(process.env.SESSION_STATUS==="401")process.exit(v?.error==="authentication_required"?0:1);
    if(process.env.SESSION_STATUS!=="200"||typeof v?.csrfToken!=="string"||
      !/^[A-Za-z0-9_-]{43}$/u.test(v.csrfToken)||Number.isNaN(Date.parse(v.expiresAt)))process.exit(1)' \
    "$workdir/session.json" || return 1
  [[ "$session_status" != 401 ]] || return 0
  curl --noproxy '*' -fsS --max-time 12 -D "$headers" -o "$body" -H 'Host: 100.95.50.98:8216' \
    -H 'Accept-Encoding: gzip, deflate, br' \
    "http://127.0.0.1:8216/assets/${APP_INITIAL}" || return 1
  grep -Eiq '^content-encoding:[[:space:]]*br' "$headers" || return 1
  env EXPECTED_SHA="$APP_INITIAL_SHA256" /usr/bin/node -e 'const fs=require("node:fs"),z=require("node:zlib"),c=require("node:crypto");
    const raw=z.brotliDecompressSync(fs.readFileSync(process.argv[1]));
    if(c.createHash("sha256").update(raw).digest("hex")!==process.env.EXPECTED_SHA)process.exit(1)' "$body" || return 1
  for asset in home-ambient-suggestions-content-BxxaJoC6.js pull-request-detail-query-tyorX5z0.js \
    realtime-voice-launch-surface-C_wjL0B3.js; do
    curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' \
      "http://127.0.0.1:8216/assets/$asset" | grep -Fq '__r129_disabled' || return 1
  done
  [[ "$(curl --noproxy '*' -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -H 'Host: 100.95.50.98:8216' \
    http://127.0.0.1:8216/assets/fr-FR-DX9bu8hG.js)" == 404 ]] || return 1
}

verify_bundle() {
  local assets="$WEB_NEW/scratch/asar/webview/assets" stub_count
  [[ "$(sha256 "$assets/$APP_INITIAL")" == "$APP_INITIAL_SHA256" ]] || return 1
  /usr/bin/node --check "$assets/$APP_INITIAL" >/dev/null || return 1
  stub_count=$(grep -lZ '__r129_disabled' "$assets"/*.js | tr -cd '\0' | wc -c)
  [[ "$stub_count" == 83 ]] || return 1
  while IFS= read -r -d '' module; do /usr/bin/node --check "$module" >/dev/null || return 1; done \
    < <(grep -lZ '__r129_disabled' "$assets"/*.js)
  for retained in zh-CN-BXST_Bte.js zh-HK-DhNEKxpI.js zh-TW-0HonSxan.js \
    tex-1KfC2u42.js bibtex-D2Zuw43D.js markdown-DtkKtvD3.js python-CMSGC7OP.js coq-C127Ok58.js \
    codex-dark-DgyInWLc.js codex-light-CVyGr2nP.js; do
    [[ -f "$assets/$retained" ]] || return 1
  done
  for removed in fr-FR-DX9bu8hG.js ja-JP-Dd1_Au3y.js abap-DxuQO2b8.js \
    ayu-light-DFsrtA8V.js appshot-demo-DcV9m9GT.mp4 codex-spritesheet-v6-BRBFriCM.webp; do
    [[ ! -e "$assets/$removed" ]] || return 1
  done
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 && "$mutation_started" -eq 1 ]]; then
    if [[ "$web_switched" -eq 1 ]]; then
      ln -s "$WEB_OLD" "${WEB_ROOT}/.current-r129-rollback.$$" &&
        replace_link "${WEB_ROOT}/.current-r129-rollback.$$" "$WEB_CURRENT" || true
    fi
    systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
    sleep 1
    printf 'deployment_status=rolled_back\n'
  fi
  [[ "$web_created" -eq 0 || "$success" -eq 1 ]] || rm -rf -- "$WEB_NEW"
  [[ -z "$workdir" ]] || rm -rf -- "$workdir"
  if [[ -n "${STANDALONE_WEB_PID:-}" ]]; then verify_8215 || code=1; fi
  if [[ -n "${ROUTER_PID:-}" ]]; then verify_8216_core || code=1; fi
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r129-deploy.XXXXXX)
for unit in "$ROUTER_SERVICE" "$MANAGER_SERVICE" "$MANAGER_SOCKET" "$APP_SERVICE" "$WEB_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
  UNIT_HASH_BEFORE[$unit]=$(unit_sha256 "$unit")
  must "pending_reload_${unit}" test "$(unit_value NeedDaemonReload "$unit")" = no
done
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$WEB_OLD"
must unexpected_8215_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must web_successor_exists test ! -e "$WEB_NEW"
must transformer_missing test -f "$TRANSFORMER"
must transformer_changed test "$(sha256 "$TRANSFORMER")" = "$TRANSFORMER_SHA256"

STANDALONE_WEB_PID=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
STANDALONE_WEB_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
STANDALONE_APP_PID=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
STANDALONE_APP_START=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
ROUTER_PID=$(unit_value MainPID "$ROUTER_SERVICE")
ROUTER_START=$(unit_value ActiveEnterTimestampMonotonic "$ROUTER_SERVICE")
MANAGER_PID=$(unit_value MainPID "$MANAGER_SERVICE")
MANAGER_START=$(unit_value ActiveEnterTimestampMonotonic "$MANAGER_SERVICE")
APP_PID=$(unit_value MainPID "$APP_SERVICE")
APP_START=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
WEB_PID=$(unit_value MainPID "$WEB_SERVICE")
UPLOAD_IDENTITY=$(stat -Lc '%d:%i:%a:%u:%g' "$UPLOAD_ROOT")
IFS='|' read -r ROUTE_BEFORE REQUESTS_BEFORE STREAMS_BEFORE ACCOUNTS_BEFORE <<<"$(router_state)"
must active_requests_nonzero test "$REQUESTS_BEFORE" = 0
must active_streams_nonzero test "$STREAMS_BEFORE" = 0
must configured_accounts_changed test "$ACCOUNTS_BEFORE" = 2
must standalone_changed verify_8215
must routed_core_changed verify_8216_core
must app_account_missing app_account_ready

must web_create mkdir -m 0755 "$WEB_NEW"
web_created=1
must web_copy cp -a --reflink=auto "$WEB_OLD/." "$WEB_NEW/"
must web_symlink test -z "$(find "$WEB_NEW" -type l -print -quit)"
must web_plan /usr/bin/node "$TRANSFORMER" --candidate "$WEB_NEW" --dry-run >"$workdir/plan.json"
must web_plan_contract env STUB_HASH="$STUB_NAMES_SHA256" REMOVED_HASH="$REMOVED_NAMES_SHA256" /usr/bin/node -e '
  const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(v?.event!=="r129_mathproof_surface_planned"||v?.successor_app_initial_sha256!=="30f89afa313226c925e44c4fbfb6518f9c2760eeecc252addc4b0338f0505f7a"||
    v?.original_primary_bytes!==190923137||v?.projected_primary_bytes!==106751265||v?.projected_primary_bytes_saved!==84171872||
    v?.stubbed_module_count!==83||v?.stubbed_module_names_sha256!==process.env.STUB_HASH||v?.removed_primary_count!==348||
    v?.removed_primary_names_sha256!==process.env.REMOVED_HASH||v?.orphan_dependency_count!==0)process.exit(1)' "$workdir/plan.json"
must standalone_changed_after_plan verify_8215
must routed_core_changed_after_plan verify_8216_core
must web_transform /usr/bin/node "$TRANSFORMER" --candidate "$WEB_NEW" >"$workdir/transform.json"
must web_transform_contract /usr/bin/node -e '
  const fs=require("node:fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(v?.event!=="r129_mathproof_surface_installed"||v?.projected_primary_bytes_saved!==84171872||
    v?.stubbed_module_count!==83||v?.removed_primary_count!==348||v?.orphan_dependency_count!==0)process.exit(1)' "$workdir/transform.json"
must bundle_invalid verify_bundle
must standalone_changed_before_mutation verify_8215
must routed_core_changed_before_mutation verify_8216_core

mutation_started=1
must web_link ln -s "$WEB_NEW" "${WEB_ROOT}/.current-r129.$$"
must web_switch_link replace_link "${WEB_ROOT}/.current-r129.$$" "$WEB_CURRENT"
web_switched=1
must web_restart systemctl restart "$WEB_SERVICE"
must readiness_failed wait_web_ready
must browser_failed verify_browser
must app_account_missing_after_restart app_account_ready
must web_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID"
must current_web_changed test "$(readlink -f "$WEB_CURRENT")" = "$WEB_NEW"
must standalone_changed_after_restart verify_8215
must routed_core_changed_after_restart verify_8216_core

success=1
trap - EXIT
printf 'deployment_status=success\n'
printf 'web_release=%s\n' "$WEB_RELEASE_NAME"
printf 'original_primary_bytes=190923137\nprojected_primary_bytes=106751265\nprojected_primary_bytes_saved=84171872\n'
printf 'stubbed_module_count=83\nremoved_primary_count=348\n'
printf 'retained_locales=en_embedded,zh-CN,zh-HK,zh-TW\n'
printf 'model_request_sent=false\naccount_switch_sent=false\nsemantic_output_replayed=false\n'
printf 'routed_8216_core_unchanged=true\nstandalone_8215_unchanged=true\n'
rm -rf -- "$workdir"
