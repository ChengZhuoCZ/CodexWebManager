#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=/tmp/codex-m69-r20-83d062d.tar.gz
readonly ARCHIVE_SHA256=75f8d70f40481fc1e5c6cc53f803a6d04bbd7f4c01a8209419401d6b9ef40852
readonly ROOT=/opt/0xcaff-codex-web-router
readonly CURRENT="${ROOT}/current"
readonly PREVIOUS="${ROOT}/releases/c3e92f0f-20260729-m69-router-r19"
readonly SUCCESSOR="${ROOT}/releases/c3e92f0f-20260729-m69-router-r20"
readonly WEBVIEW="${SUCCESSOR}/scratch/asar/webview"
readonly PRELOAD_NAME=preload-65708a1c.js
readonly PRELOAD_SHA256=65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a
readonly PRELOAD_GZIP_SHA256=ee83a0334b52d8557a7b4252e02addf34687082b584a769f06091c2dc5355d32
readonly PRELOAD_BROTLI_SHA256=815f74c342f4046a6c1d0e01276adfb5dca47a0ec0771532f5bedfae62b07b68
readonly INDEX_SHA256=20703fc1b770eeb40a23fd604b46ed5efb5f2d95a93eb7e51cec30b39ef60d59
readonly INDEX_GZIP_SHA256=3f497714830ce20ec895cb9211fd3b690f5695a1e71ef8fbaa06d83c88a9cf21
readonly INDEX_BROTLI_SHA256=618f6e08f54baecba5eebdceeed74b4d75030f846d8848e0e02730489b573c11
readonly STANDALONE_WEB_PID=466019
readonly STANDALONE_APP_PID=465713
readonly STANDALONE_WEB_TS=173291171117
readonly STANDALONE_APP_TS=173290089055

success=0
successor_created=0
current_switched=0
probe_directory=

expect_sha256() {
  local expected=$1
  local file=$2
  local actual
  actual=$(sha256sum "$file" | awk '{print $1}')
  [[ "$actual" == "$expected" ]]
}

expect_unit_state() {
  local unit=$1
  local expected=$2
  [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == "$expected" ]]
}

expect_standalone_unchanged() {
  expect_unit_state codex-web-upstream.service active
  expect_unit_state codex-web-upstream-app-server.service active
  [[ "$(systemctl show -p MainPID --value codex-web-upstream.service)" == "$STANDALONE_WEB_PID" ]]
  [[ "$(systemctl show -p MainPID --value codex-web-upstream-app-server.service)" == "$STANDALONE_APP_PID" ]]
  [[ "$(systemctl show -p ExecMainStartTimestampMonotonic --value codex-web-upstream.service)" == "$STANDALONE_WEB_TS" ]]
  [[ "$(systemctl show -p ExecMainStartTimestampMonotonic --value codex-web-upstream-app-server.service)" == "$STANDALONE_APP_TS" ]]
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8215/)" == 200 ]]
}

wait_for_unit() {
  local unit=$1
  local attempt
  for attempt in $(seq 1 100); do
    if expect_unit_state "$unit" active; then
      return 0
    fi
    sleep 0.2
  done
  return 1
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

wait_for_socket() {
  local socket=$1
  local attempt
  for attempt in $(seq 1 150); do
    if [[ -S "$socket" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

expect_header() {
  local headers=$1
  local expected=$2
  grep -Fqi "$expected" "$headers"
}

decode_brotli_sha256() {
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const zlib = require("node:zlib");
    const bytes = zlib.brotliDecompressSync(fs.readFileSync(process.argv[1]));
    process.stdout.write(crypto.createHash("sha256").update(bytes).digest("hex"));
  ' "$1"
}

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$success" -ne 1 ]]; then
    systemctl stop codex-web-router.service >/dev/null 2>&1 || true
    systemctl stop codex-web-router-app-server.service >/dev/null 2>&1 || true
    systemctl stop codex-account-router.service >/dev/null 2>&1 || true
    if [[ "$current_switched" -eq 1 ]]; then
      local rollback_link="${ROOT}/.current-r20-rollback.$$"
      ln -s "$PREVIOUS" "$rollback_link"
      mv -Tf "$rollback_link" "$CURRENT"
    fi
    if [[ "$successor_created" -eq 1 ]]; then
      rm -rf "$SUCCESSOR"
    fi
    printf 'deployment_status=rolled_back\n'
  fi
  if [[ -n "$probe_directory" ]]; then
    rm -rf "$probe_directory"
  fi
  exit "$exit_code"
}
trap rollback EXIT

printf 'deployment_status=preflight\n'
expect_standalone_unchanged
expect_unit_state codex-web-router.service inactive
expect_unit_state codex-web-router-app-server.service inactive
expect_unit_state codex-account-router.service inactive
[[ "$(readlink -f "$CURRENT")" == "$PREVIOUS" ]]
[[ ! -e "$SUCCESSOR" ]]
expect_sha256 "$ARCHIVE_SHA256" "$ARCHIVE"

mapfile -t archive_entries < <(tar -tzf "$ARCHIVE")
expected_entries=(
  "./"
  "./scratch/"
  "./scratch/asar/"
  "./scratch/asar/webview/"
  "./scratch/asar/webview/index.html"
  "./scratch/asar/webview/index.html.br"
  "./scratch/asar/webview/index.html.gz"
  "./scratch/asar/webview/assets/"
  "./scratch/asar/webview/assets/${PRELOAD_NAME}.br"
  "./scratch/asar/webview/assets/${PRELOAD_NAME}"
  "./scratch/asar/webview/assets/${PRELOAD_NAME}.gz"
)
[[ "${#archive_entries[@]}" -eq "${#expected_entries[@]}" ]]
for index in "${!expected_entries[@]}"; do
  [[ "${archive_entries[$index]}" == "${expected_entries[$index]}" ]]
done
tar -tvzf "$ARCHIVE" | awk '$1 !~ /^[-d]/ { exit 1 }'

cp -a --reflink=auto "$PREVIOUS" "$SUCCESSOR"
successor_created=1
[[ -d "${WEBVIEW}/assets" ]]
[[ ! -L "${WEBVIEW}/assets" ]]
[[ -f "${WEBVIEW}/index.html" ]]
[[ ! -L "${WEBVIEW}/index.html" ]]
tar --no-same-owner -xzf "$ARCHIVE" -C "$SUCCESSOR"
chmod 0644 \
  "${WEBVIEW}/index.html" \
  "${WEBVIEW}/index.html.gz" \
  "${WEBVIEW}/index.html.br" \
  "${WEBVIEW}/assets/${PRELOAD_NAME}" \
  "${WEBVIEW}/assets/${PRELOAD_NAME}.gz" \
  "${WEBVIEW}/assets/${PRELOAD_NAME}.br"

expect_sha256 "$INDEX_SHA256" "${WEBVIEW}/index.html"
expect_sha256 "$INDEX_GZIP_SHA256" "${WEBVIEW}/index.html.gz"
expect_sha256 "$INDEX_BROTLI_SHA256" "${WEBVIEW}/index.html.br"
expect_sha256 "$PRELOAD_SHA256" "${WEBVIEW}/assets/${PRELOAD_NAME}"
expect_sha256 "$PRELOAD_GZIP_SHA256" "${WEBVIEW}/assets/${PRELOAD_NAME}.gz"
expect_sha256 "$PRELOAD_BROTLI_SHA256" "${WEBVIEW}/assets/${PRELOAD_NAME}.br"
[[ "$(gzip -dc "${WEBVIEW}/assets/${PRELOAD_NAME}.gz" | sha256sum | awk '{print $1}')" == "$PRELOAD_SHA256" ]]
[[ "$(decode_brotli_sha256 "${WEBVIEW}/assets/${PRELOAD_NAME}.br")" == "$PRELOAD_SHA256" ]]
[[ "$(grep -Foc "./assets/${PRELOAD_NAME}" "${WEBVIEW}/index.html")" -eq 1 ]]
[[ "$(grep -Foc '<script type="module" src="./assets/preload.js"></script>' "${WEBVIEW}/index.html" || true)" -eq 0 ]]
[[ "$(grep -Foc './assets/app-initial-BTphDPeq.js?v=e2d356e06763a828' "${WEBVIEW}/index.html")" -eq 2 ]]

next_link="${ROOT}/.current-r20.$$"
ln -s "$SUCCESSOR" "$next_link"
mv -Tf "$next_link" "$CURRENT"
current_switched=1

systemctl start codex-account-router.service
wait_for_unit codex-account-router.service
wait_for_url http://127.0.0.1:18318/readyz
systemctl start codex-web-router-app-server.service
wait_for_unit codex-web-router-app-server.service
wait_for_socket /run/codex-web-router-app-server/app-server.sock
systemctl start codex-web-router.service
wait_for_unit codex-web-router.service
wait_for_url http://127.0.0.1:8216/

probe_directory=$(mktemp -d /tmp/m69-r20-live.XXXXXX)
readonly PRELOAD_URL="http://127.0.0.1:8216/assets/${PRELOAD_NAME}"
curl -fsS --max-time 20 -D "${probe_directory}/identity.headers" -H 'Accept-Encoding: identity' -o "${probe_directory}/identity" "$PRELOAD_URL"
curl -fsS --max-time 20 -D "${probe_directory}/gzip.headers" -H 'Accept-Encoding: gzip' -o "${probe_directory}/gzip" "$PRELOAD_URL"
curl -fsS --max-time 20 -D "${probe_directory}/brotli.headers" -H 'Accept-Encoding: br' -o "${probe_directory}/brotli" "$PRELOAD_URL"
curl -fsS --max-time 20 -H 'Accept-Encoding: identity' -o "${probe_directory}/index" http://127.0.0.1:8216/

expect_sha256 "$PRELOAD_SHA256" "${probe_directory}/identity"
expect_sha256 "$PRELOAD_GZIP_SHA256" "${probe_directory}/gzip"
expect_sha256 "$PRELOAD_BROTLI_SHA256" "${probe_directory}/brotli"
expect_sha256 "$INDEX_SHA256" "${probe_directory}/index"
[[ "$(gzip -dc "${probe_directory}/gzip" | sha256sum | awk '{print $1}')" == "$PRELOAD_SHA256" ]]
[[ "$(decode_brotli_sha256 "${probe_directory}/brotli")" == "$PRELOAD_SHA256" ]]
for headers in identity gzip brotli; do
  expect_header "${probe_directory}/${headers}.headers" 'cache-control: public, max-age=31536000, immutable'
  expect_header "${probe_directory}/${headers}.headers" 'vary: Accept-Encoding'
done
expect_header "${probe_directory}/gzip.headers" 'content-encoding: gzip'
expect_header "${probe_directory}/brotli.headers" 'content-encoding: br'
if grep -Fqi 'content-encoding:' "${probe_directory}/identity.headers"; then
  exit 1
fi

expect_standalone_unchanged
[[ "$(readlink -f "$CURRENT")" == "$SUCCESSOR" ]]
expect_unit_state codex-account-router.service active
expect_unit_state codex-web-router-app-server.service active
expect_unit_state codex-web-router.service active

success=1
trap - EXIT
rm -rf "$probe_directory"
probe_directory=
rm -f "$ARCHIVE"
printf 'deployment_status=success\n'
printf 'release=%s\n' "$(basename "$SUCCESSOR")"
printf 'preload_url=./assets/%s\n' "$PRELOAD_NAME"
printf 'preload_cache_control=public, max-age=31536000, immutable\n'
printf 'standalone_8215_unchanged=true\n'
