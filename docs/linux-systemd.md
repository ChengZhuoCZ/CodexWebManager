# Linux systemd deployment

M5.2 supervises the account router, Codex App Server, and pinned codex-web server as three
independent non-root services. The router and codex-web expose literal IPv4 loopback listeners;
the App Server exposes only `/run/codex-app-server/app-server.sock`. These units do not publish a
port to a LAN or the Internet.

This deployment remains `LIMITED_MODE`. It has no evidence for cross-account conversation
continuity and does not describe a service restart or account change as resuming an in-flight
calculation in place.

## Pinned compatibility boundary

- Router release: the M5.1 artifact built from this repository.
- codex-web: clean checkout at `888692f7d885118c6a92bbaf60cf2121f5947adf`, with the optional
  clean-room status overlay applied and its server bundle built.
- Node.js: version 22 or newer, installed at `/usr/bin/node` for the checked-in unit.
- Codex CLI: an operator-installed executable at `/usr/local/bin/codex`. The M5.2 experiment
  observed `codex-cli 0.144.5` exposing both `app-server --listen unix://PATH` and
  `app-server proxy --sock PATH`. Re-run those two help probes before using another CLI version.
- systemd: a release supporting `LoadCredential=`, `ImportCredential=`, and the `%d` credential
  directory specifier (Ubuntu 24.04 is the native CI baseline).

The web process still emits the pinned stdio invocation
`-c features.code_mode_host=true app-server --analytics-default-enabled`. The clean-room
`codex-router-cli` adapter rewrites that exact invocation to the bounded Unix proxy command. It
rejects public, non-`/run`, overlong, control-character, and unsupported proxy input. Direct mode
from M4.1 remains available when `CODEX_APP_SERVER_SOCKET` is absent.

## Install public files

First install an M5.1 Linux artifact at its default prefix so that this path exists:

```text
/opt/codex-account-router/current/bin/codex-account-router
```

Prepare the pinned codex-web checkout at `/opt/codex-web`; apply
`integrations/codex-web/apply-status-bridge.mjs` if the status panel is required, then build the
server so `/opt/codex-web/src/server/main.js` exists. Install the unit and provisioning files:

```sh
sudo install -m 0644 systemd/*.service systemd/*.target /etc/systemd/system/
sudo install -m 0644 systemd/codex-stack.sysusers.conf /usr/lib/sysusers.d/codex-stack.conf
sudo install -m 0644 systemd/codex-stack.tmpfiles.conf /usr/lib/tmpfiles.d/codex-stack.conf
sudo systemd-sysusers
sudo systemd-tmpfiles --create
```

The generated `codex` identity has no login shell. The shared identity is necessary for the private
App Server socket; service mount namespaces keep each systemd credential directory isolated. State
directories are `0700`, and the common sandbox baseline removes capabilities, makes the host file
system read-only, protects the home/kernel/control-group namespaces, and permits only Unix, IPv4,
and IPv6 socket families. `MemoryDenyWriteExecute=` is intentionally absent because Node.js uses a
JIT. Namespace restrictions that would prevent an authorized Codex sandbox from operating are also
not guessed here.

## Configure accounts and credential paths

Create `/etc/codex-account-router/accounts.json` as a regular `0600` file owned by `codex`. It
contains public account metadata and opaque credential references only. For example, an account
whose `credential_ref` is `codex-account-router.auth.primary` reads the matching imported systemd
credential; it does not contain a token in the account file.

Place router account credentials in the system credential store with names matching
`codex-account-router.auth.*`, for example:

```text
/etc/credstore/codex-account-router.auth.primary
```

The router unit imports the matching names and sets `CODEX_ROUTER_CREDENTIAL_ROOT=%d`. The original
credential-store file should be root-owned and mode `0600`. Never put credential contents in a unit,
environment variable, shell argument, repository, or journal.

Two explicit service credentials are also required:

```text
/etc/codex-account-router/credentials/admin-token
/etc/codex-account-router/credentials/app-server-auth.json
```

Keep their parent directory root-owned `0700` and both files root-owned `0600`. The first is copied
independently into the router and codex-web credential namespaces. The second is exposed to the App
Server as a temporary `%d/codex-auth` file and linked from its private `CODEX_HOME`; the source value
never appears in `Environment=` or `ExecStart=`.

The systemd credentials model intentionally exposes credential data as service-user-restricted
files rather than inherited environment values. See the upstream
[System and Service Credentials](https://systemd.io/CREDENTIALS/) documentation for the `%d` and
credential-directory behavior.

## Verify and start

Verify the installed unit syntax after installing the router, Codex CLI, codex-web server, and
credential source files:

```sh
sudo systemd-analyze verify \
  /etc/systemd/system/codex-account-router.service \
  /etc/systemd/system/codex-app-server.service \
  /etc/systemd/system/codex-web.service \
  /etc/systemd/system/codex-stack.target
sudo systemctl daemon-reload
sudo systemctl enable --now codex-stack.target
```

Check only the local endpoints and socket:

```sh
curl --fail http://127.0.0.1:18318/healthz
curl --fail http://127.0.0.1:8214/
ss -ltn
ss -lx
```

The empty-account router deliberately reports `503 no_accounts` from `/readyz`; do not weaken that
signal. Do not change any listener to `0.0.0.0`, `[::]`, or public WebSocket. Remote access and a
separately authenticated reverse proxy are outside M5.2.

Each unit may be restarted without systemd stopping or restarting its peers:

```sh
sudo systemctl restart codex-account-router.service
sudo systemctl restart codex-app-server.service
sudo systemctl restart codex-web.service
```

The units intentionally use only `Wants=` and `After=` ordering. They omit `Requires=`, `BindsTo=`,
`PartOf=`, and propagation directives. A peer can therefore remain active while a dependency is
temporarily unavailable and recover through its own bounded behavior.

## Evidence boundary

The Ubuntu lifecycle job installs an empty-account router plus local fixture App Server/web
processes. It verifies unit syntax, PID 1 supervision, a non-root UID, loopback/Unix listeners,
credential-path delivery, the actual wrapper-to-socket connection, and one independent restart of
each service. The fixtures use bounded retry and an overall deadline.

That job does not configure a real Codex account, send a model request, or switch accounts. A native
fixture pass is deployment evidence only; it cannot satisfy M0.3, M3.5, or M4.1 account-switch rows.
