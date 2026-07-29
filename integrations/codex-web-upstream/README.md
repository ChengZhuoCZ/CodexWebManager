# Upstream codex-web account-router adapter

This directory keeps the `0xcaff/codex-web` integration small and clean-room.
The browser/server source stays pinned to the upstream repository. The local
files here provide only:

- a bounded stdio-to-Unix-WebSocket adapter for the long-running Codex App
  Server;
- a direct-HTTP compatibility patch for browsers without secure-context Web
  Crypto; and
- systemd wiring that sends App Server model traffic to the loopback account
  router.

The routed deployment is intentionally separate from the direct standalone
instance:

- direct upstream service: port `8215`, `/opt/0xcaff-codex-web`, unchanged by
  router development;
- routed integration service: port `8216`, `/opt/0xcaff-codex-web-router`,
  separate state directories and Unix socket.

The routed request path is:

```text
browser
  -> pinned upstream codex-web
  -> local stdio/Unix-WebSocket adapter
  -> long-running Codex App Server
  -> http://127.0.0.1:18317/backend-api/codex
  -> account scheduler and bounded pre-semantic failover
  -> fixed provider origin
```

The App Server's own credential is a separate server-only identity used for its
account/session control plane. Provider credentials for model requests remain
inside the account router. Neither credential is embedded in the codex-web
bundle, command line, environment value, or repository.

The upstream Electron compatibility layer can print complete IPC messages.
The routed systemd unit therefore discards its standard output and retains only
standard error for operational failures. Do not re-enable stdout journaling
without an upstream message-level redaction boundary.

Automatic failover is request-scoped:

- quota, authentication, rate-limit, network, and upstream-5xx failures may
  select another eligible account only before semantic output;
- attempts, backoff, and the total request deadline are bounded;
- after semantic output, the request stops with `unsafe_to_replay`;
- a manual account switch starts a new backend session; cross-account
  conversation continuity is not claimed.

The service still listens only on `127.0.0.1`. Tailnet publishing belongs
outside codex-web and must remain restricted to an authorized Tailscale
network.

For faster first paint on the direct Tailnet HTTP origin, the routed build may
apply `tailnet-startup-fastpath.patch` after the Web Crypto compatibility
patch. It terminates only exact Statsig initialization/registration POST
routes locally, so unavailable telemetry cannot hold the main UI startup path.
It does not intercept model, account, App Server, or router traffic.

The pinned desktop asset sends the same telemetry through its Electron network
override rather than browser `fetch`. The separate routed release therefore
also applies `tailnet-ipc-statsig-fastpath.patch` to the pinned
`app-initial-BTphDPeq.js` asset. That patch recognizes only the exact Statsig
initialize, registration, and log-event hosts/paths and never matches provider,
account, or model endpoints.

`preventAllNetworkTraffic` short-circuits the Statsig SDK before that override
and still lets the authenticated client collect, batch, compress, and then
discard analytics events. Apply `tailnet-statsig-logging-disabled.patch` after
the IPC patch to give the authenticated client the same
`loggingEnabled: "disabled"` setting already used by the pre-login client. The
patch adds exactly that option; it does not change experiment evaluation,
network routes, model requests, account requests, or App Server traffic.

The main pinned desktop bundle is about 22.8 MB and the browser preload is
about 607 KB. Because the upstream Fastify server does not enable its existing
precompressed-file support, the routed release may run
`build-minified-precompressed-asset.mjs` against the exact final patched
`app-initial-BTphDPeq.js`, `preload.js`, and the initial stylesheet, then apply
`tailnet-precompressed-asset.patch`. The builder accepts only absolute
asset/index paths, their expected input SHA-256 values, and the pinned esbuild
`0.27.0` executable. The required layout is `index.html` next to the `assets`
directory. It syntax-checks the smaller main and preload JavaScript, preserves
the exact stylesheet bytes, deterministically creates Brotli and gzip variants
for all three startup assets, and rewrites the inactive release's index with
an early import map plus matching `modulepreload` URL. Both point to a query
version derived from the minified main-asset SHA-256. The builder relocates
the unique main-module preload next to that import map and ahead of the
synchronous Tailnet startup shim. This lets the multi-megabyte main transfer
overlap the shim's Tailnet round trip instead of waiting behind it, while
preserving exactly one resource hint and the original script execution order.
Any missing, duplicate, already-versioned, or differently laid-out anchor
fails closed:

```sh
node build-minified-precompressed-asset.mjs \
  --asset /absolute/release/webview/assets/app-initial-BTphDPeq.js \
  --expected-sha256 <64-hex-asset-input-sha256> \
  --preload /absolute/release/webview/assets/preload.js \
  --expected-preload-sha256 <64-hex-preload-input-sha256> \
  --stylesheet /absolute/release/webview/assets/app-initial-Czet5G9g.css \
  --expected-stylesheet-sha256 <64-hex-stylesheet-input-sha256> \
  --index /absolute/release/webview/index.html \
  --expected-index-sha256 <64-hex-index-input-sha256> \
  --esbuild /absolute/pinned/esbuild
```

Build order is important: upstream build, compatibility/IPC patches, the
authenticated Statsig logging patch, minification/index versioning, then
precompression. Minifying before the integration patches would invalidate the
reviewed patch boundaries. Running the builder more than once against the same
candidate fails closed; start from a fresh inactive release instead.

The adapter enables the pinned `@fastify/static` `preCompressed` option instead
of implementing content negotiation itself. That mature plugin prefers
Brotli and falls back to gzip and identity. The adapter also normalizes the
selected `.br` or `.gz` sibling back to its original asset path before applying
the existing cache policy and emits `Vary: Accept-Encoding`; plugin-managed
validators, content types, and ranges remain intact. Only the three hash-pinned
startup assets receive generated compressed siblings. The versioned main URL
prevents a refreshed HTML document from reusing the previous release's
immutable main-module entry while keeping all importers on one canonical
module URL. The HTML and un-hashed preload routes remain revalidated rather
than immutable. A newly built bundle must be exercised in an inactive routed
release before activation; the standalone `8215` release is never a candidate
for this optimization.

The upstream loader already paints before the main bundle is ready, but its
background is transparent. `tailnet-startup-background.patch` gives the
existing loader explicit light and dark backgrounds so a direct HTTP browser
does not show its default white canvas while parsing the desktop bundle. It
does not add scripts, requests, or protocol behavior.
