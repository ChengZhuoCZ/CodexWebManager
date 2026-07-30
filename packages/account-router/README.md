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

- admin listener: `127.0.0.1:18318`
- model listener: `127.0.0.1:18317`
- `GET /healthz`: `200` while the process is alive
- `GET /readyz`: `503` with `reason=no_accounts` until an account provider reports at least one
  usable account

Override the listeners with `CODEX_ROUTER_ADMIN_HOST`, `CODEX_ROUTER_ADMIN_PORT`,
`CODEX_ROUTER_MODEL_HOST`, and `CODEX_ROUTER_MODEL_PORT`. Only literal IPv4 or IPv6 loopback
addresses are accepted. Port `0` is supported for tests and supervised ephemeral development only.

To enable account routing, set both `CODEX_ROUTER_ACCOUNTS_FILE` and
`CODEX_ROUTER_CREDENTIAL_ROOT`. The account file contains public metadata and opaque references
only:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "account-a",
      "alias": "Account A",
      "enabled": true,
      "priority": 0,
      "max_concurrency": 1,
      "provider": "openai-codex",
      "secret_provider": "codex-auth",
      "credential_ref": "auth.json"
    }
  ]
}
```

The referenced `auth.json` stays in the private credential root and is never copied into the public
account catalog. The root must be owned by the service user with no group/other access; credential
files must also deny group/other access. `CODEX_ROUTER_UPSTREAM_ORIGIN` defaults to
`https://chatgpt.com`. An optional admin bearer token is loaded from the private file named by
`CODEX_ROUTER_ADMIN_TOKEN_FILE`; no token is accepted on the command line or in the account file.

The M0.4 architecture mode is `LIMITED_MODE`. This service does not claim seamless account
continuity. An accepted manual switch is explicitly reported as `new_backend_session`; real
cross-account switching remains untested and deferred.

## Admin and event API

M1.3 exports `createAdminAuthenticator()`, `createAdminState()`, `createEventBroker()`, and
`createAdminHandler()` for programmatic composition with `createRouterService()`. The standalone
CLI enables the protected admin routes only when `CODEX_ROUTER_ADMIN_TOKEN_FILE` is configured.

- `GET /v1/status`: sanitized router state, account aliases, current route, and the explicit
  `LIMITED_MODE` continuity flags.
- `GET /v1/accounts`: sanitized account runtime status without internal IDs or credential binding
  fields.
- `GET /v1/events`: bounded SSE backlog and live sanitized events, with `Last-Event-ID` replay.
- `POST /v1/switch`: validates a manual request and, in the standalone runtime, records an
  eligible account as the bounded preference for the next new request.

All four routes require a dedicated admin bearer token. Proxy-like headers are rejected, bodies
are bounded, unknown fields fail closed, and manual switch requests are rejected while a semantic
stream is active. The runtime starts that guard only after the first semantic HTTP SSE or WebSocket
event and releases it on every terminal or failure path. Automatic pre-semantic failover and manual
selection publish only sanitized route aliases, reasons, and `new_backend_session` continuity. A
manual selection is acknowledged only after its private route intent is atomically persisted. Route
selection and mutation are serialized through that short boundary; if a semantic stream starts
before acknowledgement, the candidate state is rolled back and the switch is rejected. An
automatic route that changes the current backend is likewise persisted before the runtime opens
the upstream attempt; a failed private write therefore fails closed without contacting that
upstream. This wait observes the existing bounded failover selection signal. A deadline or client
cancel marks the route-persistence boundary unavailable, disposes the acquired secret lease, and
does not apply a late result to the running router's current route. Credential acquisition observes
the same signal without misclassifying cancellation as an authentication failure. It releases the
serialized selector and any unconsumed half-open probe at the boundary, and disposes any
SecretLease that resolves after abandonment, so a later new request can retry a recovered
credential provider. Persisting an authentication-failure classification observes that same
selection boundary. A timed-out save cannot retain the serialized selector; its late storage error
marks both readiness and later selection unavailable, while a different eligible account may serve
only a later new request while the prior classification write remains pending.
Tests use fixture accounts only; they do not access or switch any real account.

## Optional codex-web status bridge

M4.2 exports `createStatusBridge()` and `createPrivateFileTokenConsumer()` as a second validation
boundary in front of the admin API. The bridge is inert when unconfigured, accepts only an exact
HTTP loopback admin origin, applies bounded requests and SSE frames, and copies status and switch
events through explicit field whitelists. The admin bearer token remains server-side.

The pinned codex-web overlay, deployment variables, reserved same-origin endpoints, and M4.3
minimal Shadow DOM account panel are documented in `../../integrations/codex-web/README.md`. The
panel exposes only alias, state, quota windows, cooldown, last switch reason, and the current route.
It disables manual switching during an active semantic stream and labels any accepted switch as a
new backend session. It does not establish or claim cross-account conversation continuity.

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
invalidates every outstanding lease. Retry-after input is accepted for rate limits, while a
sanitized weekly reset may extend quota-exhaustion cooldown; both are clamped to the configured
maximum and other failure kinds reject the field.

`createCircuitStateStore()` atomically writes versioned state through a private temporary file and
rename. It requires an absolute service-user-owned private directory, rejects symlinked,
permissive, corrupt, empty, and oversized files, and validates every field before save or restore.
Probe tokens are runtime-only and never persisted; a restored half-open account starts with zero
in-flight probes. M2.3 tests use a virtual clock and private temporary directories only.

When `CODEX_ROUTER_STATE_DIRECTORY` is configured, the runtime loads this state before starting
listeners, persists bounded failure/cooldown mutations plus the validated sanitized weekly
observation and accepted next-request route preference, and flushes pending writes during shutdown.
The optional weekly state contains only the internal public-config key, observed time, remaining
ratio, and reset time. Route intent uses a separate private, atomically replaced
`routing-state.json` so an older release can ignore it during rollback without encountering a new
field in `circuit-state.json`. It contains only current and preferred internal public-config keys;
no alias, provider identifier, credential binding, or upstream account identifier is stored there.
Old schema-1 files without either optional field remain valid. A restored weekly
entry is discarded when its explicit reset timestamp is at or before the startup clock, and the next
atomic save removes that historical entry. A restored route is accepted only when the referenced
account remains enabled in the current public configuration, and the admin projection exposes only
its sanitized alias with `new_backend_session`. Restored open/half-open health and unexpired Weekly
quota are reflected in sanitized admin status.
Protected status reads also prune an observation once a running process reaches that explicit reset
boundary, refresh the sanitized panel, and queue the private state update without changing an
independent circuit cooldown. Persistence failure makes readiness and later selection fail closed.

Release `0.2.0` and later include `bin/codex-stack-deploy`. It validates schema-1 configuration/state,
creates private snapshots that exclude credentials, atomically activates immutable releases, and
supports one-command rollback. See `docs/linux-upgrade-rollback.md` in the repository.

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
backend paths: models over HTTP, Responses over WebSocket, and alpha search over HTTP. A later
qualified Codex transport fallback also permits `POST /backend-api/codex/responses` over HTTP/SSE
at the same exact upstream path; it uses the same bounded failover and semantic replay gate as the
standard Responses route. Memory and all other backend paths remain unallowlisted.

Normalization accepts origin-form request targets only, enforces method and transport per route,
rejects encoded/dot traversal, absolute/authority targets, fragments, backslashes, control bytes,
unknown suffixes, and arbitrary queries. Only a bounded plain `client_version` value is preserved
on model routes; the Codex HTTP/SSE fallback accepts no query. The result contains a relative
upstream target and never an origin, host, or authority, preventing this layer from becoming an
open proxy.

## HTTP, SSE, and WebSocket pass-through

M3.2 exports `createProxyHandler()` and `createModelProxyService()`. The model listener defaults to
`127.0.0.1:18317`, rejects non-loopback binds, and applies the M3.1 route normalizer before calling
the injected upstream resolver. The resolver returns an internal origin plus selected-account
headers and an optional release callback; clients cannot choose the upstream origin or forward
their own authorization, cookie, API-key, or account-selection headers.

HTTP request bodies and non-SSE response bodies have explicit byte limits. Streaming uses Node
stream backpressure, forwards SSE chunks incrementally, propagates client cancellation, and applies
separate upstream-header and total deadlines. Response headers are allowlisted and `set-cookie` is
never returned. Codex may fall back from its observed WebSocket Responses route to HTTP/SSE on the
same backend path; both transports remain exact allowlist entries. The WebSocket route uses a raw,
backpressured duplex tunnel; client cancellation closes the upstream socket and releases its lease.
Compression extensions are not forwarded because this layer does not independently validate
compressed frame semantics.

The standalone CLI composes this listener with the scheduler, credential provider, circuit breaker,
failover state machine, and separate admin listener. M3.2's own tests still use loopback fixture
servers only and are not cross-account evidence.

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
fixture account. M3.5 composes that callback before releasing the selected account lease so a
half-open probe cannot be mistaken for a success. M3.3's multi-account integration tests still use
loopback mock accounts from `test-fixtures/mock_scenarios.yaml`; they are not real account-switch
evidence and do not prove seamless continuation.

## Codex auxiliary endpoints

M3.4 derives its auxiliary HTTP policy directly from the redacted M0.2 capture for Codex CLI
0.144.2. The observed surface is limited to:

- `GET /backend-api/codex/models?client_version=...`, with no request body and a JSON response;
- `POST /backend-api/codex/alpha/search`, with the observed stable search JSON fields and a JSON
  response.

The router buffers these request and response bodies within the configured limits. Search input
must be UTF-8 JSON with the observed stable top-level types (`id`, `input`, `max_output_tokens`, and
`model`); unknown nested or configuration fields remain byte-for-byte intact. Successful upstream
responses are committed only after their media type and complete JSON body validate. Invalid input
fails before account resolution, while an invalid successful upstream response becomes a bounded
`502` instead of leaking a partial or non-JSON payload.

Each auxiliary route forwards only its M0.2-observed safe client headers. Host and content length
are regenerated, account identity and authorization can only come from the internal resolver, and
client credentials, cookies, Responses-only session/turn headers, upstream cookies, and private
response headers are removed. The observed safe `x-oai-request-id` response header is preserved.

Unsupported methods, queries, transports, suffixes, and paths return a structured route error
before the resolver is called. In particular, no memory endpoint is inferred or allowlisted because
M0.2 observed none. All M3.4 integration tests use one loopback fixture account, including the
failover-enabled compatibility case; they perform no real account switch and make no continuity
claim.

## App Server compatibility scope

M3.5 adds `createRuntimeComposition()` and the clean-room
`scripts/run-app-server-e2e.mjs` harness. With one user-authorized account, the real Codex App Server
completed a persistent two-turn thread through the router and, after both processes restarted,
successfully resumed that historical thread. The checked-in evidence contains only fixture
assertions, terminal states, counts, and aliases; it contains no prompts, responses, account ID, or
credential material.

The required approved A-to-B scenario was not run because a second distinct user-authorized account
is unavailable. M3.5 therefore remains blocked at that acceptance gate. The same-account resume
result does not show that an upstream `previous_response_id` is portable to a replacement connection
or a different account, and no seamless cross-account continuity claim is permitted.

## Unchanged codex-web integration

M4.1 adds the executable `bin/codex-router-cli.mjs` as the `CODEX_CLI_PATH` boundary used by the
pinned codex-web checkout. It passes `--version` directly to the real Codex binary and permits only
the Codex App Server invocation otherwise. For App Server it injects exactly one
`openai_base_url` pointing to the loopback model listener. Public origins, credentials in URLs,
wrong paths, missing ports, and unrelated Codex subcommands fail closed.

`scripts/run-codex-web-integration.mjs` validates the pinned upstream revision and a clean tracked
diff, starts the router CLI, then starts the upstream codex-web server without editing its tracked
source. Its Codex, UI, and configuration homes are private temporary directories; raw child logs,
prompts, responses, credentials, and account identity are not written to evidence.

The single-account browser verification created a fixture task, received the exact fixture reply,
entered a `/thread/...` route, and retained the reply after page reload. The approved same-page
account-switch row remains deferred because this device has no second authorized account. See
`docs/codex-web-router-configuration.md` for the exact environment contract.
