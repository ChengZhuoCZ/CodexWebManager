# Account router

This package is the clean-room, headless service foundation for the Codex account router. It uses
Node.js built-ins only and does not depend on Electron, a display server, or a desktop keychain.

M1.1 exposes process health and readiness on the admin listener. Account providers, secrets,
authenticated admin APIs, scheduling, and model proxy routes are added by later DAG tasks.

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
