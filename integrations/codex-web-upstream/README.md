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

The main pinned desktop bundle is about 22.8 MB. Because the upstream Fastify
server does not negotiate compression for it, the routed release pre-generates
`app-initial-BTphDPeq.js.gz` and applies
`tailnet-precompressed-asset.patch`. Only the exact content-hashed asset route
is handled by the adapter; it returns gzip only when the client explicitly
accepts it, emits `Vary: Accept-Encoding`, and preserves immutable caching.

The upstream loader already paints before the main bundle is ready, but its
background is transparent. `tailnet-startup-background.patch` gives the
existing loader explicit light and dark backgrounds so a direct HTTP browser
does not show its default white canvas while parsing the desktop bundle. It
does not add scripts, requests, or protocol behavior.
