# Account router

This package is the clean-room, headless service foundation for the Codex account router. It uses
Node.js built-ins only and does not depend on Electron, a display server, or a desktop keychain.

M1.1 exposes process health and readiness on the admin listener. M1.2 defines account metadata,
secret providers, leases, and log redaction. Authenticated admin APIs, scheduling, and model proxy
routes are added by later DAG tasks.

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
continuity, and M1.1 performs no account switching.

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
