#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_NAME=c3e92f0f-20260803-m69-router-r106-account-management
readonly WEB_ROOT=/opt/0xcaff-codex-web-router
readonly WEB_CURRENT="${WEB_ROOT}/current"
readonly WEB_EXPECTED_CURRENT="${WEB_ROOT}/releases/c3e92f0f-20260802-m69-router-r105-native-usage-dom"
readonly WEB_SUCCESSOR="${WEB_ROOT}/releases/${RELEASE_NAME}"
readonly ROUTER_ROOT=/opt/codex-account-router
readonly ROUTER_CURRENT="${ROUTER_ROOT}/current"
readonly ROUTER_EXPECTED_CURRENT="${ROUTER_ROOT}/releases/codex-account-router-0.2.32-linux-x64"
readonly ROUTER_RELEASE_NAME=codex-account-router-0.2.33-linux-x64
readonly ROUTER_SUCCESSOR="${ROUTER_ROOT}/releases/${ROUTER_RELEASE_NAME}"
readonly STANDALONE_CURRENT=/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3

readonly INPUT_ROOT="${R106_INPUT_ROOT:-/tmp/codex-r106-deploy-inputs}"
readonly SERVER_INSTALLER_SOURCE="${INPUT_ROOT}/install-r106-account-management.mjs"
readonly PANEL_INSTALLER_SOURCE="${INPUT_ROOT}/replace-r106-router-account-management.mjs"
readonly GENERIC_PANEL_INSTALLER_SOURCE="${INPUT_ROOT}/replace-standalone-router-panel.mjs"
readonly PANEL_SOURCE="${INPUT_ROOT}/router-account-panel-standalone.js"
readonly MANAGEMENT_SOURCE="${INPUT_ROOT}/router-account-management-standalone.js"
readonly ROUTER_ARCHIVE_SOURCE="${INPUT_ROOT}/${ROUTER_RELEASE_NAME}.tar.gz"
readonly WEB_UNIT_SOURCE="${INPUT_ROOT}/codex-web-router.service"
readonly MANAGER_SERVICE_SOURCE="${INPUT_ROOT}/codex-router-account-manager.service"
readonly MANAGER_SOCKET_SOURCE="${INPUT_ROOT}/codex-router-account-manager.socket"

readonly SERVER_INSTALLER_SHA256=5d4e6baa05591daa42a0e31cde53054af632435a5fcfa0cb7826c87df474c7c1
readonly PANEL_INSTALLER_SHA256=b3a3abb5f5974068fbf3257d1a07c2e0a5d65a6ce3735674694dd6ae03eddd4e
readonly GENERIC_PANEL_INSTALLER_SHA256=e41ef09d15848c2f32e4142558b459ccb1501036ebddd454c91e2b0f4f78ef27
readonly PANEL_SOURCE_SHA256=6c92b5320a91dcd76508552bb93ab75b1a57cb7dfd98503a5740166ec6cc7b4a
readonly MANAGEMENT_SOURCE_SHA256=a676d6fb4a80cc3faa839bd39f72831fe2d862225e6afa1fa6676a3225cc3dec
readonly ROUTER_ARCHIVE_SHA256=081cf1a659e9618007cea4dbb020256450a36f1ba54f9d3a440c0f23b24d21f0
readonly WEB_UNIT_SHA256=1daaa9b821875713d72dd61eedf6639258aa1ed9e362df058e7ca1ee1fc8e328
readonly MANAGER_SERVICE_SHA256=9da7880a383eaa5f4057eb523a267fda4b6aafa0a0de0361745a608ac7a1671b
readonly MANAGER_SOCKET_SHA256=29aecb37ec655eb4c3499f400f48bc80944ccfd02ef317cf4832e449046fd53e

readonly INDEX=scratch/asar/webview/index.html
readonly ASSETS=scratch/asar/webview/assets
readonly APP_ASSET=app-initial-BTphDPeq.js
readonly PRELOAD_ASSET=preload-65708a1c.js
readonly SOURCE_PANEL_ASSET=router-account-panel-673d9a21.js
readonly SUCCESSOR_PANEL_ASSET=router-account-panel-6c92b532.js
readonly SOURCE_INDEX_SHA256=3adbde28ae4feb647955b5b455022bee7215858a51914b7cf8b3397b0f2f6585
readonly SOURCE_INDEX_GZIP_SHA256=80eebf5a811d5b263099072efdf522140c0822eca1064402e02321ecde9f0905
readonly SOURCE_INDEX_BROTLI_SHA256=725ddc15bdaa3d54e25c2edd65d8ec365b25d7e6c7dd734d9f583702f1a2f8f9
readonly SOURCE_PANEL_SHA256=673d9a21fce3b64cea49605958d0d92fd7c4d1974f5f1e3415126a2b6d1f6214
readonly SOURCE_PANEL_GZIP_SHA256=ba5d0ab788fa213539f5ab0ddc3bddc19b2991a64b09fc7aaee5441e01d2b7f8
readonly SOURCE_PANEL_BROTLI_SHA256=c0918d660e629523b3331058af683f12917363830db4596fee27257dd53c4d9e
readonly SUCCESSOR_INDEX_SHA256=a3109809feaad204f764b98034657ff336438723526402b182a1940c48a0d45a
readonly SUCCESSOR_INDEX_GZIP_SHA256=f86ec8723cc3f130cc9f0b8f40311df3f6a49e7ea1f32ee3a5fcef8f5512af8b
readonly SUCCESSOR_INDEX_BROTLI_SHA256=a41e0676f0c22643b65ef945d0e3e78235156e58a7a4965732cb8e548a955012
readonly SUCCESSOR_PANEL_GZIP_SHA256=93dc2e128dd6f46e956f281a4ddc01a816168ca58f58e32a6c27df0e3233ea88
readonly SUCCESSOR_PANEL_BROTLI_SHA256=96467b6caeb84211c4b1482083e2a659250e1754861ba4e50ed246053a817759
readonly APP_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly SOURCE_MAIN_SHA256=ea69e94c622db32c8d7cc6156d9ffabd5be77ba608b3709eae4928b28c829e67
readonly SUCCESSOR_MAIN_SHA256=e6e932f951b3c3aca875775c1e70984e54af707e368e54bb709e143db0970dfc
readonly SESSION_AUTH_SHA256=7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6
readonly ROUTER_BRIDGE_SHA256=cec53389f8893f9ac2cf821dc2ac3a51b0d7fdd1537a3b32aba137e429515e62

readonly WEB_SERVICE=codex-web-router.service
readonly APP_SERVICE=codex-web-router-app-server.service
readonly ROUTER_SERVICE=codex-account-router.service
readonly MANAGER_SERVICE=codex-router-account-manager.service
readonly MANAGER_SOCKET=codex-router-account-manager.socket
readonly STANDALONE_WEB_SERVICE=codex-web-upstream.service
readonly STANDALONE_APP_SERVICE=codex-web-upstream-app-server.service
readonly WEB_FRAGMENT=/etc/systemd/system/codex-web-router.service
readonly MANAGER_SERVICE_FRAGMENT=/etc/systemd/system/codex-router-account-manager.service
readonly MANAGER_SOCKET_FRAGMENT=/etc/systemd/system/codex-router-account-manager.socket
readonly ISOLATION_DROPIN=/etc/systemd/system/codex-web-router.service.d/8216-isolation.conf
readonly QUOTA_DROPIN=/etc/systemd/system/codex-web-router.service.d/quota-refresh.conf
readonly SOURCE_WEB_BASE_SHA256=5aa4a2bf9951c90a871963b7a683d6922e5906967fa0de698ae199bf1f5b0159
readonly SOURCE_WEB_EFFECTIVE_SHA256=48ff89e7d9bef5504c5b455f940fde5b78ccba64cc25543122962f5c0163198d
readonly APP_EFFECTIVE_SHA256=b3723ecef6a6e1a6153ec0f08f5bf4f890183ed377ab2b27f9d82dc9fe9eaeef
readonly ROUTER_EFFECTIVE_SHA256=b3a525c67a6ba75fb1cc124be73b866d57614700b2cf2ed2268bec81e2ee9e44
readonly STANDALONE_WEB_EFFECTIVE_SHA256=a8c8ceab5b354698c288d1e7db500f059f89c5027579ff9ea49bf5cc788bcb0c
readonly STANDALONE_APP_EFFECTIVE_SHA256=44037ff3c2d9fafef1f51fda6cc83a64edb2f60472d0cd43b737dfbe2008abc3
readonly ISOLATION_DROPIN_SHA256=8709f17a6a2fffacd00878f66a493d021f6507042b447f256254ef43283f54c3
readonly QUOTA_DROPIN_SHA256=10682643f454b414fb8e51b489b3f87f27ef9a94908e2b659a884d600a7f4c57

success=0
workdir=
snapshot_complete=0
web_successor_created=0
web_current_switched=0
router_installed=0
router_current_switched=0
units_installed=0
socket_enabled=0
web_restarted=0
router_restarted=0
web_current_before=
router_current_before=
current_route_before=

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
    const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");
    const root = process.env.INVENTORY_ROOT; const aggregate = crypto.createHash("sha256");
    for (const name of fs.readdirSync(root).sort()) {
      const target = path.join(root, name); const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
      aggregate.update(name); aggregate.update("\0"); aggregate.update(fs.readFileSync(target)); aggregate.update("\0");
      aggregate.update(String(stat.mode & 0o777)); aggregate.update("\0");
    }
    process.stdout.write(aggregate.digest("hex"));
  '
}

verify_unit_baseline() {
  [[ "$(sha256 "$WEB_FRAGMENT")" == "$SOURCE_WEB_BASE_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$WEB_SERVICE")" == "$SOURCE_WEB_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$ROUTER_SERVICE")" == "$ROUTER_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(sha256 "$ISOLATION_DROPIN")" == "$ISOLATION_DROPIN_SHA256" ]] || return 1
  [[ "$(sha256 "$QUOTA_DROPIN")" == "$QUOTA_DROPIN_SHA256" ]] || return 1
  [[ ! -e "$MANAGER_SERVICE_FRAGMENT" && ! -e "$MANAGER_SOCKET_FRAGMENT" ]]
}

verify_no_pending_reload() {
  local unit
  for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" \
    "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
    [[ "$(unit_value NeedDaemonReload "$unit")" == no ]] || return 1
  done
}

verify_source_release() {
  local root=$WEB_EXPECTED_CURRENT
  [[ "$(sha256 "${root}/${INDEX}")" == "$SOURCE_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${INDEX}.gz")" == "$SOURCE_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${INDEX}.br")" == "$SOURCE_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${SOURCE_PANEL_ASSET}")" == "$SOURCE_PANEL_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${SOURCE_PANEL_ASSET}.gz")" == "$SOURCE_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${SOURCE_PANEL_ASSET}.br")" == "$SOURCE_PANEL_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${APP_ASSET}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${PRELOAD_ASSET}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SOURCE_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$ROUTER_BRIDGE_SHA256" ]]
}

verify_successor_release() {
  local root=$WEB_SUCCESSOR
  [[ "$(sha256 "${root}/${INDEX}")" == "$SUCCESSOR_INDEX_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${INDEX}.gz")" == "$SUCCESSOR_INDEX_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${INDEX}.br")" == "$SUCCESSOR_INDEX_BROTLI_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}")" == "$PANEL_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.gz")" == "$SUCCESSOR_PANEL_GZIP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${SUCCESSOR_PANEL_ASSET}.br")" == "$SUCCESSOR_PANEL_BROTLI_SHA256" ]] || return 1
  [[ ! -e "${root}/${ASSETS}/${SOURCE_PANEL_ASSET}" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${APP_ASSET}")" == "$APP_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/${ASSETS}/${PRELOAD_ASSET}")" == "$PRELOAD_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/main.js")" == "$SUCCESSOR_MAIN_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/browser-session-auth.js")" == "$SESSION_AUTH_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-status-bridge.js")" == "$ROUTER_BRIDGE_SHA256" ]] || return 1
  [[ "$(sha256 "${root}/src/server/router-account-management.js")" == "$MANAGEMENT_SOURCE_SHA256" ]] || return 1
  [[ -z "$(find "$root" -type l -print -quit)" ]] || return 1
  grep -Fq "./assets/${SUCCESSOR_PANEL_ASSET}" "${root}/${INDEX}"
}

snapshot_protected() {
  STANDALONE_WEB_PID_BEFORE=$(unit_value MainPID "$STANDALONE_WEB_SERVICE")
  STANDALONE_WEB_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")
  STANDALONE_APP_PID_BEFORE=$(unit_value MainPID "$STANDALONE_APP_SERVICE")
  STANDALONE_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")
  ROUTED_APP_PID_BEFORE=$(unit_value MainPID "$APP_SERVICE")
  ROUTED_APP_START_BEFORE=$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")
  WEB_PID_BEFORE=$(unit_value MainPID "$WEB_SERVICE")
  ROUTER_PID_BEFORE=$(unit_value MainPID "$ROUTER_SERVICE")
  ACCOUNTS_SHA_BEFORE=$(sha256 /etc/codex-account-router/accounts.json)
  CREDENTIALS_SHA_BEFORE=$(private_inventory_hash /etc/credstore)
  ADMIN_CREDENTIALS_SHA_BEFORE=$(private_inventory_hash /etc/codex-account-router/credentials)
  snapshot_complete=1
}

verify_protected() {
  [[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$STANDALONE_CURRENT" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_START_BEFORE" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_WEB_SERVICE")" == "$STANDALONE_WEB_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(unit_value MainPID "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_sha256 "$STANDALONE_APP_SERVICE")" == "$STANDALONE_APP_EFFECTIVE_SHA256" ]] || return 1
  [[ "$(unit_value MainPID "$APP_SERVICE")" == "$ROUTED_APP_PID_BEFORE" ]] || return 1
  [[ "$(unit_value ActiveEnterTimestampMonotonic "$APP_SERVICE")" == "$ROUTED_APP_START_BEFORE" ]] || return 1
  [[ "$(unit_sha256 "$APP_SERVICE")" == "$APP_EFFECTIVE_SHA256" ]]
}

verify_private_stores_unchanged() {
  [[ "$(sha256 /etc/codex-account-router/accounts.json)" == "$ACCOUNTS_SHA_BEFORE" ]] || return 1
  [[ "$(private_inventory_hash /etc/credstore)" == "$CREDENTIALS_SHA_BEFORE" ]] || return 1
  [[ "$(private_inventory_hash /etc/codex-account-router/credentials)" == "$ADMIN_CREDENTIALS_SHA_BEFORE" ]]
}

start_browser_session() {
  : >"${workdir}/cookies"
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: text/html' \
    -c "${workdir}/cookies" http://127.0.0.1:8216/ >/dev/null
  curl --noproxy '*' -fsS --max-time 3 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "${workdir}/cookies" -c "${workdir}/cookies" \
    http://127.0.0.1:8216/__backend/session >"${workdir}/session.json"
  INPUT_SESSION="${workdir}/session.json" /usr/bin/node -e '
    const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.env.INPUT_SESSION,"utf8"));
    if (typeof value?.csrfToken!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) process.exit(1);
  '
}

verify_browser_status() {
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "${workdir}/cookies" http://127.0.0.1:8216/__backend/codex-router/status >"${workdir}/status.json"
  INPUT_STATUS="${workdir}/status.json" EXPECTED_ROUTE="$current_route_before" /usr/bin/node -e '
    const fs=require("node:fs"); const router=JSON.parse(fs.readFileSync(process.env.INPUT_STATUS,"utf8"))?.router;
    if (!router || router.active_streams!==0 || router.accounts?.length!==2 ||
        router.current_route?.account_alias!==process.env.EXPECTED_ROUTE ||
        router.current_route?.continuity!=="new_backend_session") process.exit(1);
  '
}

capture_browser_route() {
  curl --noproxy '*' -fsS --max-time 5 -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' \
    -b "${workdir}/cookies" http://127.0.0.1:8216/__backend/codex-router/status >"${workdir}/status-before.json"
  INPUT_STATUS="${workdir}/status-before.json" /usr/bin/node -e '
    const fs=require("node:fs"); const router=JSON.parse(fs.readFileSync(process.env.INPUT_STATUS,"utf8"))?.router;
    const alias=router?.current_route?.account_alias;
    if (!router || router.active_streams!==0 || router.accounts?.length!==2 ||
        router.current_route?.continuity!=="new_backend_session" ||
        typeof alias!=="string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(alias) || alias.includes("@")) process.exit(1);
    process.stdout.write(alias);
  '
}

verify_management_route_without_mutation() {
  local code
  code=$(curl --noproxy '*' -sS --max-time 3 -o "${workdir}/operation.json" -w '%{http_code}' \
    -H 'Host: 100.95.50.98:8216' -H 'Accept: application/json' -b "${workdir}/cookies" \
    http://127.0.0.1:8216/__backend/codex-router/accounts/device-auth/00000000000000000000000000000000)
  [[ "$code" == 404 ]] || return 1
  INPUT_OPERATION="${workdir}/operation.json" /usr/bin/node -e '
    const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.env.INPUT_OPERATION,"utf8"));
    if (value?.enabled!==true || value?.error!=="device_auth_not_found") process.exit(1);
  '
}

probe_fixed_socket_protocol() {
  /usr/sbin/runuser -u codex8216 -- /usr/bin/node -e '
    const net=require("node:net"); const socket=net.createConnection(process.argv[1]); let bytes="";
    const fail=()=>process.exit(1); const timer=setTimeout(fail,5000);
    socket.once("connect",()=>socket.end("{\"operation\":\"noop\"}\n"));
    socket.on("data",chunk=>{ bytes+=chunk; if (bytes.length>8192) fail(); });
    socket.once("error",fail); socket.once("end",()=>{ clearTimeout(timer); try {
      const value=JSON.parse(bytes); if (value?.ok!==false || value?.error!=="account_operation_failed") fail();
      process.exit(0);
    } catch { fail(); } });
  ' /run/codex-router-account-manager.sock
}

verify_manager_units() {
  [[ "$(sha256 "$WEB_FRAGMENT")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(sha256 "$MANAGER_SERVICE_FRAGMENT")" == "$MANAGER_SERVICE_SHA256" ]] || return 1
  [[ "$(sha256 "$MANAGER_SOCKET_FRAGMENT")" == "$MANAGER_SOCKET_SHA256" ]] || return 1
  [[ "$(sha256 "$ISOLATION_DROPIN")" == "$ISOLATION_DROPIN_SHA256" ]] || return 1
  [[ "$(sha256 "$QUOTA_DROPIN")" == "$QUOTA_DROPIN_SHA256" ]] || return 1
  [[ "$(systemctl is-enabled "$MANAGER_SOCKET" 2>/dev/null)" == enabled ]] || return 1
  [[ "$(systemctl is-enabled "$MANAGER_SERVICE" 2>/dev/null)" == static ]] || return 1
  expect_active "$MANAGER_SOCKET" || return 1
  expect_active "$MANAGER_SERVICE" || return 1
  [[ "$(stat -c '%U:%G:%a' /run/codex-router-account-manager.sock)" == root:codex8216:660 ]] || return 1
  [[ "$(unit_value User "$MANAGER_SERVICE")" == root ]] || return 1
  [[ "$(unit_value Group "$MANAGER_SERVICE")" == codex8216 ]] || return 1
  [[ "$(unit_value NoNewPrivileges "$MANAGER_SERVICE")" == yes ]] || return 1
  [[ "$(unit_value ProtectSystem "$MANAGER_SERVICE")" == strict ]]
}

copy_and_verify_inputs() {
  install -o root -g root -m 0644 "$SERVER_INSTALLER_SOURCE" "${workdir}/install-r106-account-management.mjs"
  install -o root -g root -m 0644 "$PANEL_INSTALLER_SOURCE" "${workdir}/replace-r106-router-account-management.mjs"
  install -o root -g root -m 0644 "$GENERIC_PANEL_INSTALLER_SOURCE" "${workdir}/replace-standalone-router-panel.mjs"
  install -o root -g root -m 0644 "$PANEL_SOURCE" "${workdir}/router-account-panel-standalone.js"
  install -o root -g root -m 0644 "$MANAGEMENT_SOURCE" "${workdir}/router-account-management-standalone.js"
  install -o root -g root -m 0644 "$ROUTER_ARCHIVE_SOURCE" "${workdir}/${ROUTER_RELEASE_NAME}.tar.gz"
  install -o root -g root -m 0644 "$WEB_UNIT_SOURCE" "${workdir}/codex-web-router.service"
  install -o root -g root -m 0644 "$MANAGER_SERVICE_SOURCE" "${workdir}/codex-router-account-manager.service"
  install -o root -g root -m 0644 "$MANAGER_SOCKET_SOURCE" "${workdir}/codex-router-account-manager.socket"
  [[ "$(sha256 "${workdir}/install-r106-account-management.mjs")" == "$SERVER_INSTALLER_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/replace-r106-router-account-management.mjs")" == "$PANEL_INSTALLER_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/replace-standalone-router-panel.mjs")" == "$GENERIC_PANEL_INSTALLER_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/router-account-panel-standalone.js")" == "$PANEL_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/router-account-management-standalone.js")" == "$MANAGEMENT_SOURCE_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/${ROUTER_RELEASE_NAME}.tar.gz")" == "$ROUTER_ARCHIVE_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/codex-web-router.service")" == "$WEB_UNIT_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/codex-router-account-manager.service")" == "$MANAGER_SERVICE_SHA256" ]] || return 1
  [[ "$(sha256 "${workdir}/codex-router-account-manager.socket")" == "$MANAGER_SOCKET_SHA256" ]]
}

restore_links_and_units() {
  if [[ "$socket_enabled" -eq 1 || "$units_installed" -eq 1 ]]; then
    systemctl stop "$MANAGER_SERVICE" "$MANAGER_SOCKET" >/dev/null 2>&1 || true
    systemctl disable "$MANAGER_SOCKET" >/dev/null 2>&1 || true
  fi
  if [[ "$units_installed" -eq 1 ]]; then
    install -o root -g root -m 0644 "${workdir}/codex-web-router.service.before" "$WEB_FRAGMENT"
    rm -f -- "$MANAGER_SERVICE_FRAGMENT" "$MANAGER_SOCKET_FRAGMENT"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [[ "$web_current_switched" -eq 1 && -n "$web_current_before" ]]; then
    local web_link="${WEB_ROOT}/.current-r106-rollback.$$"
    ln -s "$web_current_before" "$web_link"
    replace_link "$web_link" "$WEB_CURRENT"
  fi
  if [[ "$router_current_switched" -eq 1 && -n "$router_current_before" ]]; then
    local router_link="${ROUTER_ROOT}/.current-r106-rollback.$$"
    ln -s "$router_current_before" "$router_link"
    replace_link "$router_link" "$ROUTER_CURRENT"
  fi
  if [[ "$router_restarted" -eq 1 || "$router_current_switched" -eq 1 ]]; then
    systemctl restart "$ROUTER_SERVICE" >/dev/null 2>&1 || true
  fi
  if [[ "$web_restarted" -eq 1 || "$web_current_switched" -eq 1 ]]; then
    systemctl restart "$WEB_SERVICE" >/dev/null 2>&1 || true
  fi
  [[ "$web_successor_created" -eq 0 ]] || rm -rf -- "$WEB_SUCCESSOR"
  [[ "$router_installed" -eq 0 ]] || rm -rf -- "$ROUTER_SUCCESSOR"
}

rollback() {
  local code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    restore_links_and_units
    printf 'deployment_status=rolled_back\n'
  fi
  if [[ -n "$workdir" ]]; then
    if [[ "$snapshot_complete" -eq 1 ]]; then
      verify_protected || code=1
      verify_private_stores_unchanged || code=1
    fi
    rm -rf -- "$workdir"
  fi
  exit "$code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
must root_required test "$EUID" -eq 0
umask 077
workdir=$(mktemp -d /tmp/m69-r106-deploy.XXXXXX)
must service_identity_missing bash -c 'getent passwd codex8216 >/dev/null'
must service_group_missing bash -c 'getent group codex8216 >/dev/null'
for unit in "$WEB_SERVICE" "$APP_SERVICE" "$ROUTER_SERVICE" \
  "$STANDALONE_WEB_SERVICE" "$STANDALONE_APP_SERVICE"; do
  must "service_inactive_${unit}" expect_active "$unit"
done
must unit_baseline_changed verify_unit_baseline
must pending_daemon_reload verify_no_pending_reload
must unexpected_standalone_current test "$(readlink -f /opt/0xcaff-codex-web/current)" = "$STANDALONE_CURRENT"
must unexpected_web_current test "$(readlink -f "$WEB_CURRENT")" = "$WEB_EXPECTED_CURRENT"
must unexpected_router_current test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_EXPECTED_CURRENT"
must web_successor_exists test ! -e "$WEB_SUCCESSOR"
must router_successor_exists test ! -e "$ROUTER_SUCCESSOR"
must source_release_changed verify_source_release
must input_copy_or_hash_failed copy_and_verify_inputs

snapshot_protected
must protected_service_changed verify_protected
must private_store_changed verify_private_stores_unchanged
must current_route_changed start_browser_session
current_route_before=$(capture_browser_route)
must current_route_changed verify_browser_status
web_current_before=$(readlink -f "$WEB_CURRENT")
router_current_before=$(readlink -f "$ROUTER_CURRENT")
cp -a "$WEB_FRAGMENT" "${workdir}/codex-web-router.service.before"

must web_successor_create mkdir "$WEB_SUCCESSOR"
web_successor_created=1
must web_successor_copy cp -a --reflink=auto "$WEB_EXPECTED_CURRENT/." "$WEB_SUCCESSOR/"
must server_management_install /usr/bin/node "${workdir}/install-r106-account-management.mjs" \
  --candidate "$WEB_SUCCESSOR" \
  --management-module "${workdir}/router-account-management-standalone.js"
must panel_replace /usr/bin/node "${workdir}/replace-r106-router-account-management.mjs" \
  --candidate "$WEB_SUCCESSOR" \
  --panel-module "${workdir}/router-account-panel-standalone.js"
must web_successor_changed verify_successor_release
must protected_service_changed verify_protected
must private_store_changed verify_private_stores_unchanged

must router_archive_layout bash -c '
  set -o pipefail
  tar -tzf "$1" | while IFS= read -r entry; do
    case "$entry" in
      codex-account-router-0.2.33-linux-x64|codex-account-router-0.2.33-linux-x64/*) ;;
      *) exit 1 ;;
    esac
  done
' _ "${workdir}/${ROUTER_RELEASE_NAME}.tar.gz"
must router_archive_type bash -c 'tar -tvzf "$1" | awk '\''$1 !~ /^[-d]/ { exit 1 }'\''' _ \
  "${workdir}/${ROUTER_RELEASE_NAME}.tar.gz"
must router_extract tar --no-same-owner -xzf "${workdir}/${ROUTER_RELEASE_NAME}.tar.gz" -C "$workdir"
must router_manifest_version test "$(/usr/bin/node -p "require('${workdir}/${ROUTER_RELEASE_NAME}/lib/account-router/package.json').version")" = 0.2.33

web_link="${WEB_ROOT}/.current-r106.$$"
must web_link_stage ln -s "$WEB_SUCCESSOR" "$web_link"
must web_link_switch replace_link "$web_link" "$WEB_CURRENT"
web_current_switched=1
must router_install env PREFIX="$ROUTER_ROOT" sh "${workdir}/${ROUTER_RELEASE_NAME}/install.sh"
router_installed=1
router_current_switched=1
must router_link_changed test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_SUCCESSOR"
must systemd_units_invalid systemd-analyze verify \
  "${workdir}/codex-web-router.service" \
  "${workdir}/codex-router-account-manager.socket" \
  "${workdir}/codex-router-account-manager.service"

units_installed=1
must web_unit_install install -o root -g root -m 0644 "${workdir}/codex-web-router.service" "$WEB_FRAGMENT"
must manager_service_install install -o root -g root -m 0644 "${workdir}/codex-router-account-manager.service" "$MANAGER_SERVICE_FRAGMENT"
must manager_socket_install install -o root -g root -m 0644 "${workdir}/codex-router-account-manager.socket" "$MANAGER_SOCKET_FRAGMENT"
must daemon_reload systemctl daemon-reload
socket_enabled=1
must manager_socket_enable systemctl enable --now "$MANAGER_SOCKET"
must router_restart systemctl restart "$ROUTER_SERVICE"
router_restarted=1
must web_restart systemctl restart "$WEB_SERVICE"
web_restarted=1

ready=0
for _attempt in $(seq 1 100); do
  if expect_active "$ROUTER_SERVICE" && expect_active "$WEB_SERVICE" && expect_active "$APP_SERVICE" && \
    expect_active "$MANAGER_SOCKET" && curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:18318/readyz >/dev/null && \
    start_browser_session >/dev/null 2>&1 && verify_browser_status >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
must readiness_failed test "$ready" -eq 1
must web_pid_not_restarted test "$(unit_value MainPID "$WEB_SERVICE")" != "$WEB_PID_BEFORE"
must router_pid_not_restarted test "$(unit_value MainPID "$ROUTER_SERVICE")" != "$ROUTER_PID_BEFORE"
must management_route_unavailable verify_management_route_without_mutation

ROUTER_PID_AFTER_PLANNED_RESTART=$(unit_value MainPID "$ROUTER_SERVICE")
must fixed_socket_protocol_failed probe_fixed_socket_protocol
must manager_service_inactive expect_active "$MANAGER_SERVICE"
must invalid_probe_restarted_router test "$(unit_value MainPID "$ROUTER_SERVICE")" = "$ROUTER_PID_AFTER_PLANNED_RESTART"
must manager_unit_contract_failed verify_manager_units
must private_store_changed verify_private_stores_unchanged
must protected_service_changed verify_protected
must current_route_changed verify_browser_status
must web_current_not_successor test "$(readlink -f "$WEB_CURRENT")" = "$WEB_SUCCESSOR"
must router_current_not_successor test "$(readlink -f "$ROUTER_CURRENT")" = "$ROUTER_SUCCESSOR"
must successor_changed verify_successor_release
must router_unit_changed test "$(unit_sha256 "$ROUTER_SERVICE")" = "$ROUTER_EFFECTIVE_SHA256"
must pending_daemon_reload verify_no_pending_reload

success=1
trap - EXIT
rm -rf -- "$workdir"
printf 'deployment_status=success\n'
printf 'web_release=%s\n' "$RELEASE_NAME"
printf 'router_release=%s\n' "$ROUTER_RELEASE_NAME"
printf 'root_helper_socket_activated=true\n'
printf 'root_helper_protocol=enroll_or_remove_only\n'
printf 'root_helper_arbitrary_command_execution=false\n'
printf 'account_store_unchanged=true\n'
printf 'current_route=%s\n' "$current_route_before"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_8216_app_server_unchanged=true\n'
printf 'model_request_sent=false\n'
printf 'account_switch_sent=false\n'
printf 'account_add_or_remove_sent=false\n'
