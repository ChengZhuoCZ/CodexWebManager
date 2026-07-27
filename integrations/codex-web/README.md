# Optional codex-web router integration

This directory contains a small, pinned overlay for upstream `codex-web` revision
`888692f7d885118c6a92bbaf60cf2121f5947adf`. It does not copy CodexManager code.

Apply it to a clean checkout:

```sh
node integrations/codex-web/apply-status-bridge.mjs /absolute/path/to/codex-web
cd /absolute/path/to/codex-web
npm run build:server
```

The installer checks the exact upstream revision plus the SHA-256 digests of
`src/server/main.ts`, `src/browser/shim.ts`, and `src/browser/files.ts` before adding
the server bridge, browser panel, and minimal registration lines. It fails closed for
other source revisions so upstream changes can be reviewed deliberately.

## Browser session configuration

The patched server fails closed unless all five variables are present:

```sh
CODEX_WEB_PUBLIC_ORIGIN=http://127.0.0.1:8214
CODEX_WEB_ACCESS_TOKEN_FILE=/absolute/private/browser-access-token
CODEX_WEB_CODEX_HOME=/absolute/private/codex-home
CODEX_WEB_UPLOAD_ROOT=/absolute/private/shared-uploads
CODEX_WEB_WORKSPACE_ROOTS=/srv/codex-workspaces
```

`CODEX_WEB_PUBLIC_ORIGIN` is the one exact browser origin. It may use loopback or one explicit
Tailscale IPv4 address and port while the application stays behind a tailnet-only TCP forwarder;
wildcard listeners and origins inferred from an incoming `Host` header are rejected. The
access-token file must be a non-symlink regular file, contain one random value of at least 32
characters with no newline, and deny group/other access. It is a site login key, not a ChatGPT
password, Cookie, API key, or Codex account token. Because the authenticated Codex protocol can
operate on configured workspaces, treat this key as a high-privilege workspace credential rather
than a read-only website password.

`CODEX_WEB_CODEX_HOME` must be an existing, non-symlink directory dedicated to the Codex
app-server runtime. It is returned only to an authenticated browser session as path
configuration; credential files and their contents are never returned by this route.
`CODEX_WEB_UPLOAD_ROOT` must likewise be an existing, non-symlink directory owned by the
codex-web service identity with mode `0700`. The web service must be able to create private
files there and the supervised app-server identity must be able to read the explicitly shared
runtime path; the systemd units provision this boundary without exposing it as a public static
directory.

The browser receives only an `HttpOnly`, `SameSite=Strict` session cookie. Unsafe HTTP requests
also require a session CSRF token, and the IPC WebSocket requires the exact origin, cookie, host,
and `codex-ipc.v1` subprotocol. A new login revokes the previous browser session. The only
unauthenticated endpoint is `GET /__backend/healthz`.

Workspace browsing is restricted after `realpath` resolution to the configured roots. Renderer
auth-status requests are accepted only with both `includeToken:false` and `refreshToken:false`;
token-bearing or ambiguous variants are rejected. Requests for the OpenAI API key or dictation
bearer connection information are also rejected before reaching the Electron compatibility
handlers.

## Router status configuration

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
- `POST /__backend/codex-router/switch`

When enabled, status is revalidated and copied through an exact field whitelist. The
event endpoint accepts only sanitized `router.switch` SSE frames. Responses are
same-origin, `no-store`, size-bounded, and use fixed error codes.

## Minimal account panel

When status reports `enabled:true`, a Shadow DOM panel shows only account alias, state,
five-hour and weekly quota, cooldown, last switch reason, and the current route. Unknown
quota is displayed as `Unavailable`; it is never guessed as zero or full. When every
enabled account is quota exhausted, the panel displays that condition explicitly.

Manual switch buttons are disabled while `active_streams` is nonzero, for the current
route, and for unavailable account states. The same-origin switch route accepts only
`{"account_alias":"…","reason":"manual"}` and the router admin API remains the
authoritative active-stream guard. UI copy explicitly says a switch starts a new backend
session.

This integration is not evidence that cross-account session continuity works, and it
never describes backend switching as seamless continuation.
