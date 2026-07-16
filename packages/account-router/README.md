# Account router

This package is the clean-room, headless service foundation for the Codex account router. It uses
Node.js built-ins only and does not depend on Electron, a display server, or a desktop keychain.

M1 provides the service, secret, and admin boundaries. M2 provides quota normalization, scheduling,
circuit breaking, and bounded session stickiness. M3 adds strict model proxy routing and transport
adapters without weakening the explicit `LIMITED_MODE` continuity boundary.

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

## Deterministic scheduling

M2.2 exports `createDeterministicScheduler()`. It validates public account metadata plus canonical
quota snapshots, applies cooldown and concurrency eligibility, and returns a frozen decision with
sanitized per-account explanations. Selection uses this stable order:

1. fresh, complete quota data before uncertain fallback data;
2. higher numeric operator priority;
3. higher conservative minimum of the five-hour and weekly ratios;
4. higher confidence, lower concurrency utilization, then ASCII account ID.

A fresh zero in either quota window is exhausted. Stale, partial, and unavailable data never uses a
cached ratio for scoring and remains an explicit uncertain fallback, so unknown data is not treated
as either zero or full. Fully occupied, actively cooling, disabled, or explicitly excluded accounts
are ineligible. M2.2 only returns fixture decisions; it does not route a request or switch accounts.

## Cooldowns, circuit breaking, and restart state

M2.3 exports `createCircuitBreaker()` with distinct bounded policies for quota exhaustion, expired
authentication, rate limits, network errors, and upstream 5xx failures. An open account rejects
acquisition until its cooldown boundary, then enters half-open and grants at most the configured
number of explicit probe leases. Probe success closes the circuit; probe failure reopens it and
invalidates every outstanding lease. Retry-after input is accepted only for rate limits and is
clamped to the configured maximum.

`createCircuitStateStore()` atomically writes versioned state through a private temporary file and
rename. It requires an absolute service-user-owned private directory, rejects symlinked,
permissive, corrupt, empty, and oversized files, and validates every field before save or restore.
Probe tokens are runtime-only and never persisted; a restored half-open account starts with zero
in-flight probes. M2.3 tests use a virtual clock and private temporary directories only.

## Routing-session stickiness

M2.4 exports `createSessionStickiness()` as an in-memory, TTL- and capacity-bounded routing map.
Calling `beginSemanticStream()` creates an explicit lease for the current account/backend pair;
until every such lease is ended, changing either value or deleting the mapping fails closed. Active
mappings are not evicted or expired, and per-session semantic leases have a separate hard bound.

At a safe boundary, assigning a different account requires a different backend-session ID and
returns `limited_mode_new_session` with `new_backend_session`. Reusing the unchanged pair returns
`sticky_backend_session`; it does not claim that a prior account's upstream response chain moved.
The strict assignment shape rejects `previous_response_id` and credential-bearing fields.

Mappings use deterministic inactive-LRU eviction after pruning expired entries. They are
intentionally not restored after a router restart: under `LIMITED_MODE`, loss of this in-memory map
requires an explicit new backend session (and later bounded rehydration), never forwarding an old
account's response ID or describing the result as seamless recovery.

## Strict proxy routes

M3.1 exports `normalizeProxyRoute()` and a frozen route registry mirrored by
`contracts/proxy-routes.json`. Standard HTTP routes accept only the documented Responses,
Responses compact, and models prefix variants. The clean-room M0.2 observations add exactly three
backend paths: models over HTTP, Responses over WebSocket, and alpha search over HTTP. Memory and
all other backend paths remain unallowlisted.

Normalization accepts origin-form request targets only, enforces method and transport per route,
rejects encoded/dot traversal, absolute/authority targets, fragments, backslashes, control bytes,
unknown suffixes, and arbitrary queries. Only a bounded plain `client_version` value is preserved
on model routes. The result contains a relative upstream target and never an origin, host, or
authority, preventing this layer from becoming an open proxy.

## HTTP, SSE, and WebSocket pass-through

M3.2 exports `createProxyHandler()` and `createModelProxyService()`. The model listener defaults to
`127.0.0.1:18317`, rejects non-loopback binds, and applies the M3.1 route normalizer before calling
the injected upstream resolver. The resolver returns an internal origin plus selected-account
headers and an optional release callback; clients cannot choose the upstream origin or forward
their own authorization, cookie, API-key, or account-selection headers.

HTTP request bodies and non-SSE response bodies have explicit byte limits. Streaming uses Node
stream backpressure, forwards SSE chunks incrementally, propagates client cancellation, and applies
separate upstream-header and total deadlines. Response headers are allowlisted and `set-cookie` is
never returned. The observed Codex WebSocket Responses route uses a raw, backpressured duplex tunnel;
client cancellation closes the upstream socket and releases its lease. Compression extensions are
not forwarded because this layer does not independently validate compressed frame semantics.

The standalone CLI still starts only the health/admin listener: composing a production upstream
resolver requires M3.3 account acquisition and failure-state logic. M3.2 tests use loopback fixture
servers only. They do not access a real account, retry a request on another account, or establish
cross-account conversation continuity.

## Safe failover state machine

M3.3 exports `createFailoverStateMachine()`, semantic-event classification, and fixed safe error
bodies. A selector receives the cumulative `excludeAccountIds` set for every attempt. The machine
permits retries only for explicitly classified quota, rate-limit, authentication, network, and
upstream-5xx failures on a replayable initial request. Attempts, exponential backoff, `Retry-After`,
and the overall operation deadline are all bounded; the deadline actively aborts a stalled selector,
attempt, callback, or backoff.

Only `response.created`, `response.in_progress`, `response.queued`, `codex.rate_limits`, and
`codex.response.metadata` are considered preflight metadata. Text/reasoning/function-argument
deltas, structural output events, completion/failure events, unknown JSON event types, non-JSON SSE
data, and binary WebSocket output all commit the semantic boundary before they are sent downstream.
Any later failure returns `unsafe_to_replay` and never invokes the selector again.

In failover mode, HTTP request bytes are buffered within the configured request limit so a permitted
retry replays identical bytes. SSE preflight events are held behind a bounded gate and discarded if
that account fails; once the first semantic event is forwarded, a later failure ends the stream with
a fixed `error` event. Non-streaming responses are buffered within the response limit before they
are committed.

The WebSocket path terminates and validates the handshake, strips compression, validates masked and
unmasked frames, bounds event/message buffers, and applies backpressure in both directions. An
initial `response.create` may reconnect before semantic output. A continuation carrying
`previous_response_id` remains on its existing upstream WebSocket; if that connection is missing or
fails, the relay returns `unsafe_to_replay` instead of assuming the ID is portable to another
connection or account.

`onAttemptFailure` is the integration boundary for the M2.3 circuit breaker; tests prove explicit
failure kinds open the failed account circuit while the cumulative exclusion set selects another
fixture account. Production scheduler/credential composition remains a later service-composition
step. All M3.3 integration tests use loopback mock accounts from `test-fixtures/mock_scenarios.yaml`.
They are not real account-switch evidence and do not prove seamless continuation.
