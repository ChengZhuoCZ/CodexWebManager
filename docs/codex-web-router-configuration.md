# codex-web router configuration

This is the exact M4.1 launch contract for the pinned codex-web revision
`888692f7d885118c6a92bbaf60cf2121f5947adf`. The codex-web tracked source is not modified.

## Process topology

```text
browser -> codex-web -> codex-router-cli wrapper -> Codex App Server
                                                -> router model listener
                                                -> fixed official upstream

operator -> router admin listener
```

Both router listeners and codex-web must bind to literal loopback addresses. Publishing codex-web or
either router port directly to a public interface is outside this configuration.

## Router files

Create a private credential directory owned by the service user. Place the authorized Codex
`auth.json` in that directory with mode `0600`. Do not put its contents in environment variables,
command-line arguments, the public account file, logs, or source control.

The separate account file contains public metadata plus an opaque credential reference:

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

Start the router with these variables:

```text
CODEX_ROUTER_ACCOUNTS_FILE=/absolute/path/accounts.json
CODEX_ROUTER_CREDENTIAL_ROOT=/absolute/private/credential-directory
CODEX_ROUTER_ADMIN_HOST=127.0.0.1
CODEX_ROUTER_ADMIN_PORT=18318
CODEX_ROUTER_MODEL_HOST=127.0.0.1
CODEX_ROUTER_MODEL_PORT=18317
CODEX_ROUTER_UPSTREAM_ORIGIN=https://chatgpt.com
CODEX_ROUTER_ADMIN_TOKEN_FILE=/absolute/private/admin-token
```

`CODEX_ROUTER_ADMIN_TOKEN_FILE` is optional. When absent, protected admin routes return unavailable;
health and readiness remain available. Start with `node src/main.mjs` from
`packages/account-router`.

## codex-web and App Server

Use a prepared checkout at the pinned commit and keep its tracked diff clean. Configure codex-web:

```text
CODEX_HOME=/absolute/private/codex-home
CODEX_CLI_PATH=/absolute/path/packages/account-router/bin/codex-router-cli.mjs
CODEX_REAL_CLI_PATH=/absolute/path/to/codex
CODEX_ROUTER_MODEL_BASE_URL=http://127.0.0.1:18317/backend-api/codex
```

Then run the upstream server unchanged:

```text
node src/server/main.js --host 127.0.0.1 --port 8214
```

The wrapper permits the codex-web version probe and App Server mode only. It strips its own
configuration variables before starting the real Codex child and injects:

```text
-c openai_base_url="http://127.0.0.1:18317/backend-api/codex"
```

The router, App Server, and codex-web remain separate processes. Stopping a browser page does not by
itself terminate those server processes, but this does not mean an in-flight upstream calculation
can be moved to another account or resumed in place after process failure.

## M4.1 boundary

The authorized single-account test proved page load, task creation, one model response, thread URL
navigation, and history rendering after page reload. It did not execute an account switch. A second
distinct user-authorized account is still required before the same-browser-page switch row can pass.
No seamless cross-account continuity claim is permitted in `LIMITED_MODE`.
