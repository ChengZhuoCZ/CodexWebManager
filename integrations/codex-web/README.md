# Optional codex-web router status bridge

This directory contains a small, pinned overlay for upstream `codex-web` revision
`888692f7d885118c6a92bbaf60cf2121f5947adf`. It does not copy CodexManager code.

Apply it to a clean checkout:

```sh
node integrations/codex-web/apply-status-bridge.mjs /absolute/path/to/codex-web
cd /absolute/path/to/codex-web
npm run build:server
```

The installer checks the exact upstream revision and the SHA-256 of `src/server/main.ts`
before adding `router-status-bridge.ts` and two registration lines. It fails closed for
other source revisions so upstream changes can be reviewed deliberately.

## Configuration

The bridge is disabled unless both variables are present:

```sh
CODEX_ROUTER_ADMIN_ORIGIN=http://127.0.0.1:18318
CODEX_ROUTER_ADMIN_TOKEN_FILE=/run/user/1000/codex-router/admin-token
```

The origin must be an exact HTTP loopback origin with an explicit port. The token file
and its parent directory must be owned by the service user and deny group/other access.
The bearer token is read by the server for each upstream request; it is never returned
to the browser.

When disabled, the reserved endpoints return `404 {"enabled":false}`:

- `GET /__backend/codex-router/status`
- `GET /__backend/codex-router/events`

When enabled, status is revalidated and copied through an exact field whitelist. The
event endpoint accepts only sanitized `router.switch` SSE frames. Responses are
same-origin, `no-store`, size-bounded, and use fixed error codes.

This bridge reports router state only. It is not evidence that cross-account session
continuity works, and it never describes backend switching as seamless continuation.
