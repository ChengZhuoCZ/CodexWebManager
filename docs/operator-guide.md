# Operator guide

This runbook is the single entry point for operating the clean-room Codex Web Manager stack on
Linux. Detailed build and service behavior remains in
[linux-headless-release.md](linux-headless-release.md),
[linux-systemd.md](linux-systemd.md), and
[linux-upgrade-rollback.md](linux-upgrade-rollback.md).

## Release boundary

The current build runs in `LIMITED_MODE`. It may start a new backend session at a safe routing
boundary, but it has no evidence that an account-bound response chain can move between real
accounts. A service restart restores bounded router health state; it does not resume an in-flight
calculation.

Read [release-status.md](release-status.md) before every deployment. M6.2 is `rejected` because the
required 24-hour soak was stopped and skipped. This runbook therefore supports controlled
evaluation and operator testing; it is not evidence of production-release qualification.

Security and license boundaries are normative:
[SECURITY.md](../SECURITY.md) and [LICENSE_BOUNDARY.md](../LICENSE_BOUNDARY.md).

## Prerequisites

- Ubuntu 24.04 or another compatible systemd Linux host, x64 or arm64.
- Node.js 22 or newer at `/usr/bin/node`.
- A verified router release archive for the host architecture.
- Codex CLI installed at `/usr/local/bin/codex` after rechecking the required App Server help
  probes from [linux-systemd.md](linux-systemd.md).
- The pinned codex-web revision built at `/opt/codex-web`.
- Root access for installation and credential provisioning, plus a separate non-root operator
  login over SSH or Tailscale.
- One independent browser access key of at least 32 random characters. It must not be an account,
  ChatGPT, API, Cookie, or SSH credential.

Do not continue if a checksum, architecture, schema, pinned revision, unit syntax, or credential
permission check fails.

## Install and verify

Verify the downloaded archive before extraction, then install the matching release:

```sh
sha256sum -c codex-account-router-0.2.1-linux-x64.tar.gz.sha256
tar -xzf codex-account-router-0.2.1-linux-x64.tar.gz
sudo env NODE_BINARY=/usr/bin/node \
  sh codex-account-router-0.2.1-linux-x64/install.sh
```

Install the checked-in unit and provisioning files:

```sh
sudo install -m 0644 systemd/*.service systemd/*.target /etc/systemd/system/
sudo install -m 0644 systemd/codex-stack.sysusers.conf /usr/lib/sysusers.d/codex-stack.conf
sudo install -m 0644 systemd/codex-stack.tmpfiles.conf /usr/lib/tmpfiles.d/codex-stack.conf
sudo systemd-sysusers
sudo systemd-tmpfiles --create
sudo systemd-analyze verify /etc/systemd/system/codex-*.service
sudo systemctl daemon-reload
```

Provision the required credential files in the next section before enabling the target. The
services deliberately fail closed when a credential is absent.

All three units run as `codex`, use `UMask=0077`, load secrets from credential files, and set
`LimitCORE=0`. Expected listeners are only:

- codex-web: `127.0.0.1:8214`;
- model router: `127.0.0.1:18317`;
- admin router: `127.0.0.1:18318`;
- App Server: `/run/codex-app-server/app-server.sock`.

Verify the process and listener boundary:

```sh
systemctl is-active codex-account-router.service codex-app-server.service codex-web.service
curl -fsS http://127.0.0.1:18318/healthz
curl -fsS http://127.0.0.1:8214/__backend/healthz
ss -lnt
ss -lx
```

`/readyz` intentionally returns `503 no_accounts` until at least one usable configured account is
available:

```sh
curl -i http://127.0.0.1:18318/readyz
```

## Configure accounts and credentials

Create `/etc/codex-account-router/accounts.json` as a regular file owned by `codex`, mode `0600`.
It may contain public account metadata, aliases, and opaque credential references only. It must
not contain an email address, authorization value, cookie, access token, or refresh token.

Store account credential files as root-owned mode `0600` entries under `/etc/credstore/` using
names matching `codex-account-router.auth.*`. Provision these three service credentials separately:

```text
/etc/codex-account-router/credentials/admin-token
/etc/codex-account-router/credentials/app-server-auth.json
/etc/codex-web/credentials/browser-access-token
```

Each parent credential directory is root-owned mode `0700`; the files are root-owned mode `0600`.
The admin and browser tokens are each one value with no trailing newline. Never pass a credential
through a command-line option, unit `Environment=`, repository file, ticket, or chat transcript.
The browser value is a separate site access key, not a ChatGPT/Codex account credential. It still
grants high-privilege control of the configured Codex workspaces, including protocol operations that
can read/write files and start restricted processes. Generate or enter it privately on the server,
protect it like workspace access, use a strong random value, and do not reuse any other credential.

### Keep the routed browser signed in

In the supervised router deployment, the App Server and the `codex-web` proxy must appear locally
authenticated before the Codex UI opens its main page. Do not solve this by copying the real ChatGPT
credential into the browser proxy home. Keep the real account `auth.json` only in the corresponding
root-owned `/etc/credstore/codex-account-router.auth.*` file.

Instead, create a random router-managed marker through the Codex CLI's standard stdin login path.
The marker is not an OpenAI credential and has no provider authority. It is still stored privately
because Codex treats it as an API-key login:

```sh
sudo install -d -m 0700 -o codex -g codex /var/lib/codex-web
openssl rand -hex 32 \
  | sed 's/^/router-managed-/' \
  | sudo -u codex env \
      HOME=/var/lib/codex-web \
      CODEX_HOME=/var/lib/codex-web \
      /usr/local/bin/codex login --with-api-key
sudo install -m 0600 -o root -g root \
  /var/lib/codex-web/auth.json \
  /etc/codex-account-router/credentials/app-server-auth.json
sudo systemctl restart codex-app-server.service codex-web.service
```

This is safe only while the App Server's exact `openai_base_url` remains the loopback account-router
path. The router discards client `Authorization` and injects the selected real account credential.
If that loopback invariant changes, remove both marker files and stop the services rather than
sending the marker to another origin.

After restart, open a fresh browser session and confirm that the Codex composer appears without a
ChatGPT sign-in prompt. Also verify that `/var/lib/codex-web/auth.json` is a regular `0600` file
owned by `codex`, the App Server source is a regular root-owned `0600` file, and the two marker files
are distinct from every `/etc/credstore/codex-account-router.auth.*` real account credential.

After configuration changes:

```sh
sudo systemctl enable --now codex-stack.target
sudo systemctl restart codex-account-router.service
curl -fsS http://127.0.0.1:18318/healthz
curl -i http://127.0.0.1:18318/readyz
```

Do not add a real account merely to satisfy a health check. Real-account E2E remains a separate,
explicitly authorized gate.

## Private remote access

The safest default keeps every service on loopback. From another device already authorized to reach
the server over Tailscale or SSH, create a local port forward:

```sh
ssh -L 8214:127.0.0.1:8214 operator@TAILSCALE_IP
```

While that session remains open, browse to `http://127.0.0.1:8214` on the client device. The
website is not bound to the tailnet address or a public interface; SSH provides the encrypted,
authenticated data channel.

For explicitly approved direct Tailnet access, keep codex-web on loopback and expose only that
single port through a tailnet-only Tailscale TCP forwarder. For this deployment, first create
`/etc/systemd/system/codex-web.service.d/tailnet-listener.conf`:

```ini
[Service]
Environment=CODEX_WEB_PUBLIC_ORIGIN=http://100.95.50.98:8214
```

Then reload, restart, configure the raw TCP forwarder, and verify that the application itself still
has only a loopback listener:

```sh
sudo systemctl daemon-reload
sudo systemctl restart codex-web.service
sudo tailscale serve --bg --tcp=8214 tcp://127.0.0.1:8214
sudo tailscale serve status
curl -fsS http://127.0.0.1:8214/__backend/healthz
curl -fsS http://100.95.50.98:8214/__backend/healthz
ss -lnt
```

On another device signed into the authorized Tailscale network, open
`http://100.95.50.98:8214`. The login form accepts only the separate site access key from
`/etc/codex-web/credentials/browser-access-token`. Keep the router model/admin ports on loopback,
restrict port 8214 to the intended operator through Tailscale ACLs, and never replace the raw TCP
forwarder with Tailscale Funnel.

If the owner explicitly accepts every Tailnet device allowed by ACL as a high-privilege workspace
operator, enable trusted Tailnet access in the same drop-in:

```ini
[Service]
Environment=CODEX_WEB_PUBLIC_ORIGIN=http://100.95.50.98:8214
Environment=CODEX_WEB_TRUSTED_TAILNET_ACCESS=1
Environment=CODEX_WEB_ACCESS_TOKEN_FILE=
Environment=CODEX_WEB_CODEX_HOME=/var/lib/codex-app-server
Environment=CODEX_WEB_UPLOAD_ROOT=/run/codex-browser-uploads
LoadCredential=
LoadCredential=router-admin-token:<private-router-admin-credential-file>
```

The empty `LoadCredential=` resets the base credential list; the following line restores only the
router admin credential. The browser access key is then neither loaded nor required, and a
top-level HTML request receives a bounded `HttpOnly`, `SameSite=Strict` browser session
automatically. Exact Host/Origin checks, CSRF protection, WebSocket authorization, renderer-message
filtering, and workspace-root restrictions remain active. Keep the old browser key file private if
rollback to site-key mode is required.

Trusted mode starts only for an exact HTTP Tailnet IPv4 origin in `100.64.0.0/10`; it rejects
loopback, hostnames, and wildcard origins. Restrict TCP 8214 with Tailnet ACLs because every device
allowed to reach it can operate the configured workspaces.

Tailscale encrypts the data channel, but a direct IP HTTP origin cannot set a `Secure` cookie and
cookies are not isolated by port. A dedicated MagicDNS name with Tailscale HTTPS is the intended
longer-lived topology, but it is not supported by this release: the current origin validator accepts
only loopback or an explicit Tailnet IPv4 address with a port. Do not switch this deployment to
MagicDNS/HTTPS until an explicit implementation and security review add exact local DNS-name
validation, `Secure` cookies, WebSocket coverage, and real-browser evidence.

If a reverse proxy is later introduced, treat it as a separate security change: require
authentication, TLS, request limits, WebSocket support, an explicit trusted-user model, and a new
security review. Do not expose the model or admin ports through it.

## Monitor

Use bounded status checks and avoid dumping environment variables or credential files:

```sh
systemctl --no-pager --full status codex-account-router.service
systemctl --no-pager --full status codex-app-server.service
systemctl --no-pager --full status codex-web.service
journalctl -u codex-account-router.service --since "15 minutes ago" --no-pager
curl -fsS http://127.0.0.1:18318/healthz
curl -i http://127.0.0.1:18318/readyz
```

Alert on repeated restarts, failed readiness, all accounts unavailable, persistence failure,
growing open file counts, memory growth, or any listener outside loopback/Unix sockets. Inspect:

```sh
systemctl show codex-account-router.service -p NRestarts -p MemoryCurrent -p TasksCurrent
main_pid="$(systemctl show codex-account-router.service -p MainPID --value)"
test "$main_pid" -gt 0 && ls "/proc/$main_pid/fd" | wc -l
ss -lnt
```

Logs are structured and redacted, but still treat journals as sensitive operational data. Do not
enable request/response body logging.

## Rotate credentials

Schedule rotation through the credential provider and keep old values valid only for the shortest
practical overlap.

For the shared admin credential, write a private replacement without printing it, atomically
replace the source, restart both consumers, and verify health:

```sh
sudo sh -c 'umask 077; openssl rand -hex 32 | tr -d "\n" > /etc/codex-account-router/credentials/admin-token.next'
sudo mv /etc/codex-account-router/credentials/admin-token.next \
  /etc/codex-account-router/credentials/admin-token
sudo systemctl restart codex-account-router.service codex-web.service
curl -fsS http://127.0.0.1:18318/healthz
curl -fsS http://127.0.0.1:8214/__backend/healthz
```

Rotate `/etc/codex-web/credentials/browser-access-token` independently in the same way, then
restart only `codex-web.service`. Rotation invalidates existing browser sessions because the
process restarts.

For an account credential, obtain the replacement through the approved secret manager, write it to
a root-owned mode `0600` `.next` file under `/etc/credstore/`, atomically rename it to the existing
credential name, restart only the router, and verify readiness. For App Server authentication,
replace `app-server-auth.json` atomically and restart only `codex-app-server.service`.

On suspected disclosure, revoke first at the issuer, then rotate locally. Never copy the old value
into evidence.

## Backup

Create a non-secret router snapshot:

```sh
sudo /opt/codex-account-router/current/bin/codex-stack-deploy backup
```

Record the returned snapshot ID and verify the directory is private. `codex-stack-deploy backup`
includes public account configuration and circuit-health state; it deliberately excludes tokens,
cookies, authorization values, emails, systemd credentials, and credential-store files.

Back up credential sources only through the approved secret manager. Test restoration with
fixture-only configuration in an isolated change window. Retain at least the current and previous
immutable releases plus the snapshot needed to return to the previous version.

## Upgrade and rollback

Follow [linux-upgrade-rollback.md](linux-upgrade-rollback.md). Verify the new archive, preserve the
previous release, and use the coordinated upgrade command. Do not manually replace the `current`
symlink during a normal change.

If activation or the health deadline fails, the deployment command rolls back automatically. For
an operator-initiated rollback, first remove the persistent Tailnet listener when direct access was
enabled:

```sh
sudo tailscale serve --tcp=8214 off
sudo tailscale serve status
```

Do not continue until the status no longer contains a TCP 8214 handler. Background Tailscale Serve
configuration survives service and host restarts, so stopping `codex-web.service` alone is not
containment. The removal syntax follows the current
[Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve) contract and keeps
unrelated Serve handlers intact.

Then roll back:

```sh
sudo /opt/codex-account-router/current/bin/codex-stack-deploy rollback \
  --snapshot SNAPSHOT_ID_FROM_CHANGE_RECORD
```

`codex-stack-deploy rollback` restores public configuration, circuit state, and the retained router
release. It does not restore credential sources and does not claim that an in-flight computation
survived. Never select a codex-web release from before the authenticated browser-session gate. Keep
the Tailnet listener off until the restored release has passed local health, wrong-host, and
unauthenticated-route checks:

```sh
curl -fsS http://127.0.0.1:8214/__backend/healthz
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Host: 100.95.50.98:8214' \
  http://127.0.0.1:8214/__backend/browser-config)" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  http://127.0.0.1:8214/__backend/browser-config)" = 421
```

Only after these checks and release verification may an operator restore direct access with the
documented `sudo tailscale serve --bg --tcp=8214 tcp://127.0.0.1:8214` command.

## Incident response

1. Contain exposure: run `sudo tailscale serve --tcp=8214 off` for the direct Tailnet handler,
   confirm port 8214 is absent from `sudo tailscale serve status`, close any other unintended
   listener or tunnel, and, if needed, stop `codex-stack.target`.
2. Revoke suspected credentials at their issuer; never wait for log analysis before revocation.
3. Preserve only sanitized service status, timestamps, release names, restart counts, and bounded
   journal excerpts. Do not collect credential files or process environments.
4. Compare the active release and unit files with their verified artifacts.
5. Rotate affected account, admin, and App Server credentials independently.
6. Restore only a known-good immutable release that contains the authenticated browser-session gate
   with `codex-stack-deploy rollback`; never roll back codex-web to an unauthenticated bridge.
7. Re-enable one service at a time and verify configured listeners, `/__backend/healthz`,
   `/healthz`, `/readyz`, wrong-host rejection, and unauthenticated-route rejection. Re-enable the
   Tailnet 8214 handler only after those local checks pass.
8. Record the cause, affected interval, revoked identifiers, and corrective controls without secret
   values.

For availability faults without suspected disclosure, prefer an independent service restart. Never
silently replay a request after semantic SSE output, and never describe restart recovery as
in-place computation recovery.

The soak procedure is documented in [soak-test.md](soak-test.md); its required 24-hour acceptance
remains incomplete for this release.
