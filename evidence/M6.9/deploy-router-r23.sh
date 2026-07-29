#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=/tmp/codex-m69-r23-9e312bc.tar.gz
readonly ARCHIVE_SHA256=c0fec4758c37bce286b8550aa37e612523985a5eeb200e20044f3ebf51f0661e
readonly TOOL_SHA256=0ccc212e65187c2dd1b238ff7227dc2b96ab168d64f0e4745ba773ebe59b899c
readonly ROOT=/opt/0xcaff-codex-web-router
readonly CURRENT="${ROOT}/current"
readonly PREVIOUS="${ROOT}/releases/c3e92f0f-20260729-m69-router-r20"
readonly SUCCESSOR="${ROOT}/releases/c3e92f0f-20260729-m69-router-r23"
readonly WEBVIEW="${SUCCESSOR}/scratch/asar/webview"
readonly ASSETS="${WEBVIEW}/assets"
readonly INDEX_INPUT_SHA256=20703fc1b770eeb40a23fd604b46ed5efb5f2d95a93eb7e51cec30b39ef60d59
readonly INDEX_OUTPUT_SHA256=5e89e6e9cb38ebb82fde42526a113458d0072e40bd4cd9f10393a320e793bef9
readonly INDEX_GZIP_SHA256=5739d4a92f9ea0ef1f128da027486e12648cce9c22987d4ed88ef3e4c332a9e6
readonly INDEX_BROTLI_SHA256=e2b31240785ac7c894210293fc3ad875ac51ae7e54a3d5d8c09ef09da81e2ed8
readonly ASSET_IDENTITY_SHA256=e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0
readonly ASSET_BROTLI_INPUT_SHA256=0899d532efde663c13196219d5e89b355469969397739c2db890593740bf9be1
readonly ASSET_BROTLI_OUTPUT_SHA256=44f07fa4ca0c8011a7b6bcbeb8594ef48906747963c198488cd263954a17a149
readonly BOOTSTRAP_SHA256=23113ab574274082e1d46a03d8bd9167de84c7a07d0574ec0bd445c611f97694
readonly RPC_SHA256=ab79c31310f5de8a2f4a2c20d2fd028ef949706906f4d3ebd3bf4e50ddd65a91
readonly APP_MAIN_SHA256=41aa0a5c83d77f07b7b9354a1060007a2c1b3e1e266fae5da30e1c22b7901775
readonly ROUTER_UNIT=codex-account-router.service
readonly ROUTED_APP_UNIT=codex-web-router-app-server.service
readonly ROUTED_WEB_UNIT=codex-web-router.service
readonly STANDALONE_APP_UNIT=codex-web-upstream-app-server.service
readonly STANDALONE_WEB_UNIT=codex-web-upstream.service

success=0
successor_created=0
current_switched=0
tool_directory=
probe_directory=
activation_epoch=

unit_pid() {
  systemctl show -p MainPID --value "$1"
}

unit_started_at() {
  systemctl show -p ExecMainStartTimestampMonotonic --value "$1"
}

unit_config_sha256() {
  systemctl cat "$1" --no-pager | sha256sum | awk '{print $1}'
}

expect_sha256() {
  local expected=$1
  local file=$2
  [[ "$(sha256sum "$file" | awk '{print $1}')" == "$expected" ]]
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

decode_brotli_sha256() {
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const zlib = require("node:zlib");
    const bytes = zlib.brotliDecompressSync(fs.readFileSync(process.argv[1]));
    process.stdout.write(
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
  ' "$1"
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${ROOT}/.current-r23-rollback.$$"
      ln -s "$PREVIOUS" "$rollback_link"
      mv -Tf "$rollback_link" "$CURRENT"
      systemctl restart "$ROUTED_WEB_UNIT" >/dev/null 2>&1 || true
    fi
    if [[ "$successor_created" -eq 1 ]]; then
      rm -rf "$SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  if [[ -n "$tool_directory" ]]; then
    rm -rf "$tool_directory"
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
readonly routed_app_pid_before=$(unit_pid "$ROUTED_APP_UNIT")
readonly routed_app_started_before=$(unit_started_at "$ROUTED_APP_UNIT")
readonly routed_app_config_before=$(unit_config_sha256 "$ROUTED_APP_UNIT")
readonly routed_web_pid_before=$(unit_pid "$ROUTED_WEB_UNIT")
readonly routed_web_started_before=$(unit_started_at "$ROUTED_WEB_UNIT")
readonly routed_web_config_before=$(unit_config_sha256 "$ROUTED_WEB_UNIT")
readonly standalone_app_pid_before=$(unit_pid "$STANDALONE_APP_UNIT")
readonly standalone_app_started_before=$(unit_started_at "$STANDALONE_APP_UNIT")
readonly standalone_app_config_before=$(unit_config_sha256 "$STANDALONE_APP_UNIT")
readonly standalone_web_pid_before=$(unit_pid "$STANDALONE_WEB_UNIT")
readonly standalone_web_started_before=$(unit_started_at "$STANDALONE_WEB_UNIT")
readonly standalone_web_config_before=$(unit_config_sha256 "$STANDALONE_WEB_UNIT")
readonly standalone_release_before=$(readlink -f /opt/0xcaff-codex-web/current)

[[ "$(readlink -f "$CURRENT")" == "$PREVIOUS" ]]
[[ ! -e "$SUCCESSOR" ]]
expect_sha256 "$ARCHIVE_SHA256" "$ARCHIVE"
mapfile -t archive_entries < <(tar -tzf "$ARCHIVE")
[[ "${#archive_entries[@]}" -eq 1 ]]
[[ "${archive_entries[0]}" == optimize-versioned-entrypoints.mjs ]]
tar -tvzf "$ARCHIVE" | awk '$1 !~ /^-/ { exit 1 }'

tool_directory=$(mktemp -d /tmp/m69-r23-tool.XXXXXX)
tar --no-same-owner -xzf "$ARCHIVE" -C "$tool_directory"
readonly tool="${tool_directory}/optimize-versioned-entrypoints.mjs"
[[ -f "$tool" && ! -L "$tool" ]]
expect_sha256 "$TOOL_SHA256" "$tool"
node --check "$tool"

cp -a --reflink=auto "$PREVIOUS" "$SUCCESSOR"
successor_created=1
[[ -d "$ASSETS" && ! -L "$ASSETS" ]]
[[ -f "${WEBVIEW}/index.html" && ! -L "${WEBVIEW}/index.html" ]]

for name in \
  index-6UcaOV-H.js \
  rpc-ArWg2Nqw.js \
  app-main-DW9SEGGt.js; do
  candidate="${ASSETS}/${name}"
  source=$(readlink -f "$candidate")
  [[ -f "$source" ]]
  temporary="${candidate}.r23-next"
  cp --reflink=auto "$source" "$temporary"
  chmod 0644 "$temporary"
  mv -Tf "$temporary" "$candidate"
  [[ -f "$candidate" && ! -L "$candidate" ]]
done

optimization_result=$(
  node "$tool" \
    --index "${WEBVIEW}/index.html" \
    --expected-index-sha256 "$INDEX_INPUT_SHA256" \
    --asset "${ASSETS}/app-initial-BTphDPeq.js" \
    --expected-asset-sha256 "$ASSET_IDENTITY_SHA256" \
    --expected-asset-brotli-sha256 "$ASSET_BROTLI_INPUT_SHA256" \
    --bootstrap "${ASSETS}/index-6UcaOV-H.js" \
    --expected-bootstrap-sha256 "$BOOTSTRAP_SHA256" \
    --rpc "${ASSETS}/rpc-ArWg2Nqw.js" \
    --expected-rpc-sha256 "$RPC_SHA256" \
    --app-main "${ASSETS}/app-main-DW9SEGGt.js" \
    --expected-app-main-sha256 "$APP_MAIN_SHA256"
)
[[ "$(printf '%s' "$optimization_result" | node -e '
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(text);
    const valid =
      value.event === "versioned_entrypoints_optimized" &&
      value.asset_brotli_input_bytes === 3173689 &&
      value.asset_brotli_output_bytes === 3117335 &&
      value.asset_brotli_reduction_bytes === 56354 &&
      JSON.stringify(value.hinted_urls) ===
        JSON.stringify([
          "./assets/rpc-ArWg2Nqw.js",
          "./assets/app-main-DW9SEGGt.js",
        ]);
    process.stdout.write(valid ? "ok" : "invalid");
  });
')" == ok ]]

expect_sha256 "$INDEX_OUTPUT_SHA256" "${WEBVIEW}/index.html"
expect_sha256 "$INDEX_GZIP_SHA256" "${WEBVIEW}/index.html.gz"
expect_sha256 "$INDEX_BROTLI_SHA256" "${WEBVIEW}/index.html.br"
expect_sha256 "$ASSET_IDENTITY_SHA256" "${ASSETS}/app-initial-BTphDPeq.js"
expect_sha256 "$ASSET_BROTLI_OUTPUT_SHA256" "${ASSETS}/app-initial-BTphDPeq.js.br"
[[ "$(decode_brotli_sha256 "${ASSETS}/app-initial-BTphDPeq.js.br")" == "$ASSET_IDENTITY_SHA256" ]]
[[ "$(grep -Foc 'href="./assets/rpc-ArWg2Nqw.js"' "${WEBVIEW}/index.html")" -eq 1 ]]
[[ "$(grep -Foc 'href="./assets/app-main-DW9SEGGt.js"' "${WEBVIEW}/index.html")" -eq 1 ]]

activation_epoch=$(date +%s)
next_link="${ROOT}/.current-r23.$$"
ln -s "$SUCCESSOR" "$next_link"
mv -Tf "$next_link" "$CURRENT"
current_switched=1
systemctl restart "$ROUTED_WEB_UNIT"
wait_for_url http://127.0.0.1:8216/

probe_directory=$(mktemp -d /tmp/m69-r23-live.XXXXXX)
curl -fsS --max-time 20 \
  -H 'Accept-Encoding: identity' \
  -o "${probe_directory}/index.identity" \
  http://127.0.0.1:8216/
curl -fsS --max-time 30 \
  -D "${probe_directory}/asset.headers" \
  -H 'Accept-Encoding: br' \
  -o "${probe_directory}/asset.br" \
  'http://127.0.0.1:8216/assets/app-initial-BTphDPeq.js?v=e2d356e06763a828'
expect_sha256 "$INDEX_OUTPUT_SHA256" "${probe_directory}/index.identity"
expect_sha256 "$ASSET_BROTLI_OUTPUT_SHA256" "${probe_directory}/asset.br"
grep -Fqi 'content-encoding: br' "${probe_directory}/asset.headers"
grep -Fqi 'cache-control: public, max-age=31536000, immutable' "${probe_directory}/asset.headers"
grep -Fqi 'vary: Accept-Encoding' "${probe_directory}/asset.headers"
[[ "$(decode_brotli_sha256 "${probe_directory}/asset.br")" == "$ASSET_IDENTITY_SHA256" ]]

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
[[ "$(readlink -f "$CURRENT")" == "$SUCCESSOR" ]]
[[ "$(readlink -f /opt/0xcaff-codex-web/current)" == "$standalone_release_before" ]]
[[ "$(unit_pid "$ROUTER_UNIT")" == "$router_pid_before" ]]
[[ "$(unit_started_at "$ROUTER_UNIT")" == "$router_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTER_UNIT")" == "$router_config_before" ]]
[[ "$(unit_pid "$ROUTED_APP_UNIT")" == "$routed_app_pid_before" ]]
[[ "$(unit_started_at "$ROUTED_APP_UNIT")" == "$routed_app_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTED_APP_UNIT")" == "$routed_app_config_before" ]]
[[ "$(unit_pid "$ROUTED_WEB_UNIT")" != "$routed_web_pid_before" ]]
[[ "$(unit_started_at "$ROUTED_WEB_UNIT")" != "$routed_web_started_before" ]]
[[ "$(unit_config_sha256 "$ROUTED_WEB_UNIT")" == "$routed_web_config_before" ]]
[[ "$(unit_pid "$STANDALONE_APP_UNIT")" == "$standalone_app_pid_before" ]]
[[ "$(unit_started_at "$STANDALONE_APP_UNIT")" == "$standalone_app_started_before" ]]
[[ "$(unit_config_sha256 "$STANDALONE_APP_UNIT")" == "$standalone_app_config_before" ]]
[[ "$(unit_pid "$STANDALONE_WEB_UNIT")" == "$standalone_web_pid_before" ]]
[[ "$(unit_started_at "$STANDALONE_WEB_UNIT")" == "$standalone_web_started_before" ]]
[[ "$(unit_config_sha256 "$STANDALONE_WEB_UNIT")" == "$standalone_web_config_before" ]]

sensitive_journal_matches=$(
  journalctl \
    --since "@${activation_epoch}" \
    -u "$ROUTED_WEB_UNIT" \
    --no-pager \
    -o cat |
    grep -Eci \
      'authorization:|bearer[[:space:]]|refresh[_-]?token|access[_-]?token|cookie:|set-cookie:|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' ||
    true
)
[[ "$sensitive_journal_matches" -eq 0 ]]

success=1
trap - EXIT
rm -rf "$tool_directory" "$probe_directory"
tool_directory=
probe_directory=
rm -f "$ARCHIVE"
printf 'deployment_status=success\n'
printf 'release=%s\n' "$(basename "$SUCCESSOR")"
printf 'asset_identity_bytes=13936387\n'
printf 'asset_brotli_before_bytes=3173689\n'
printf 'asset_brotli_after_bytes=3117335\n'
printf 'asset_brotli_reduction_bytes=56354\n'
printf 'hinted_entrypoints=2\n'
printf 'sensitive_journal_matches=%s\n' "$sensitive_journal_matches"
printf 'standalone_8215_unchanged=true\n'
printf 'routed_router_and_app_server_unchanged=true\n'
