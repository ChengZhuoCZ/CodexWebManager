# Linux headless release

M5.1 packages the clean-room account router as a Node-only Linux archive. It does not bundle or
require Electron, a display server, a desktop keychain, `node_modules`, or a native package. The
runtime requirement is Node.js 22 or newer.

The release remains in `LIMITED_MODE`. These packaging checks use no account configuration and do
not test account switching. They do not establish seamless cross-account conversation continuity.

## Deployment target

M6.9 development and deployment targets this server class only:

- `x64`, installed on an `x86_64` Linux host.

The `Linux headless release` GitHub Actions workflow builds, installs, starts, health-checks, and
stops that target on a native Ubuntu 24.04 x64 runner. A successful job uploads the archive, its
SHA-256 file, and a sanitized verification summary. The summary explicitly records that no account
switch was tested.

## Reproducible build

Run the builder from the repository root. It uses only Node built-ins and does not run a package
installer:

```bash
SOURCE_DATE_EPOCH=0 node packages/account-router/scripts/build-linux-release.mjs \
  --arch x64 \
  --output packages/account-router/dist
```

With the same repository content and `SOURCE_DATE_EPOCH`, the builder emits a byte-identical x64
USTAR archive in a deterministic gzip container. The adjacent `.sha256` file contains the archive
digest.

Verify the archive before extraction:

```bash
cd packages/account-router/dist
sha256sum -c codex-account-router-0.1.0-linux-x64.tar.gz.sha256
tar -xzf codex-account-router-0.1.0-linux-x64.tar.gz
```

## Install and run

The installer requires a Linux host whose architecture matches the archive. The default prefix is
`/opt/codex-account-router`, so a system installation normally needs root privileges:

```bash
sudo env NODE_BINARY=/usr/bin/node \
  sh codex-account-router-0.1.0-linux-x64/install.sh
```

For an unprivileged or test installation, provide any absolute prefix:

```bash
PREFIX="$PWD/router-install" NODE_BINARY="$(command -v node)" \
  sh codex-account-router-0.1.0-linux-x64/install.sh
```

The installer writes a version-and-architecture-specific directory under `releases/` and updates
the `current` symlink. Reinstalling the same manifest is idempotent; a mismatched existing release
fails closed. Service lifecycle, least-privilege users, and systemd units belong to M5.2 and are not
installed by M5.1.

Start the installed router with loopback listeners. Without an account configuration, health is
available but readiness correctly reports `no_accounts`:

```bash
CODEX_ROUTER_ADMIN_HOST=127.0.0.1 \
CODEX_ROUTER_MODEL_HOST=127.0.0.1 \
/opt/codex-account-router/current/bin/codex-account-router

curl --fail http://127.0.0.1:18318/healthz
curl http://127.0.0.1:18318/readyz
```

The Linux-only CI verifier extracts the archive into a private temporary directory, installs it
with a private prefix, removes display and router configuration variables from the environment,
binds both listeners to `127.0.0.1` on ephemeral ports, checks `/healthz` and `/readyz`, then
requires a clean `SIGTERM` exit.
