# Account router

This package is the clean-room, headless service foundation for the Codex account router. It uses
Node.js built-ins only and does not depend on Electron, a display server, or a desktop keychain.

M1.1 exposes process health and readiness on the admin listener. M1.2 defines account metadata,
secret providers, leases, and log redaction. M1.3 adds a separately authenticated, sanitized admin
API and bounded event stream. Scheduling and model proxy routes are added by later DAG tasks.

## Requirements

- Node.js 22 or newer
- A loopback bind address

## Run

```bash
node src/main.mjs
```

Defaults:

- host: `127.0.0.1`
- port: `18318`
- `GET /healthz`: `200` while the process is alive
- `GET /readyz`: `503` with `reason=no_accounts` until an account provider reports at least one
  usable account

Override the listener with `CODEX_ROUTER_ADMIN_HOST` and `CODEX_ROUTER_ADMIN_PORT`. Only literal
IPv4 or IPv6 loopback addresses are accepted. Port `0` is supported for tests and supervised
ephemeral development only.

The M0.4 architecture mode is `LIMITED_MODE`. This service does not claim seamless account
continuity. An accepted manual switch is explicitly reported as `new_backend_session`; real
cross-account switching remains untested and deferred.

## Admin and event API

M1.3 exports `createAdminAuthenticator()`, `createAdminState()`, `createEventBroker()`, and
`createAdminHandler()` for programmatic composition with `createRouterService()`. Production token
loading is intentionally deferred to the systemd credential task; the standalone CLI therefore
continues to expose only health and readiness for now.

- `GET /v1/status`: sanitized router state, account aliases, current route, and the explicit
  `LIMITED_MODE` continuity flags.
- `GET /v1/accounts`: sanitized account runtime status without internal IDs or credential binding
  fields.
- `GET /v1/events`: bounded SSE backlog and live sanitized events, with `Last-Event-ID` replay.
- `POST /v1/switch`: validates a manual request and delegates it to an injected switch callback.

All four routes require a dedicated admin bearer token. Proxy-like headers are rejected, bodies
are bounded, unknown fields fail closed, and manual switch requests are rejected while a semantic
stream is active. The M1.3 tests use fixture accounts and an injected callback only; they do not
access or switch any real account.

## Account and secret boundary

M1.2 keeps the two data classes separate:

- `createAccountCatalog()` exposes frozen public metadata only: `id`, `alias`, `enabled`,
  `priority`, `max_concurrency`, and model `provider`.
- `secret_provider` and `credential_ref` remain in a separate internal credential binding. They are
  absent from `contracts/account.schema.json` and must not be returned by admin/UI APIs.

`SecretProviderRegistry` accepts providers created with `defineSecretProvider()`. The built-in file
provider requires an absolute, service-user-owned private directory and a private regular file. It
rejects group/other permissions, symlinks, traversal-like references, empty files, and oversized
files.

Acquired values are wrapped in `SecretLease`. Prefer `registry.withSecret(...)`, which disposes and
zeroes the lease buffer even when the consumer throws. JavaScript strings passed to the callback
cannot be forcibly zeroed, so consumers must not retain or log them.

All service lifecycle logs pass through `stringifyLogRecord()`. It redacts credential-related keys,
account email, bearer values, known token shapes, `SecretLease` instances, circular structures, and
oversized/deep records. Request and response bodies remain excluded by default.

## Quota snapshots

M2.1 exports `createQuotaSnapshotAdapter()` as a strict boundary between provider-specific quota
observations and later scheduler logic. An injected observer may report canonical `five_hour` and
`weekly` windows with `remaining_ratio`, `resets_at`, and an explicit confidence level. The adapter
adds the attempt time, preserves the source observation time, computes freshness with a configurable
threshold, and can re-evaluate staleness with a virtual clock.

Missing windows, unavailable sources, observer failures, ambiguous percentage fields, and malformed
observations produce `remaining_ratio: null` with `confidence: unknown`; they are never interpreted
as exhausted or full quota. The canonical shape is documented in
`contracts/quota-snapshot.schema.json`. M2.1 uses injected fixture observations only and does not
query a real account.
