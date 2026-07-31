# Linux upgrade, backup, and rollback

M5.3 adds a bounded deployment command to the headless router release. It snapshots the non-secret
account configuration and circuit-health state, validates both schemas before changing the active
release, installs immutable release files, atomically replaces the `current` symlink, restarts only
the router, and waits for the loopback health endpoint. A failed post-upgrade health check
automatically restores the snapshot.

This procedure remains `LIMITED_MODE`. A service restart preserves router health history; it does
not resume an in-flight calculation in place and does not prove seamless cross-account continuity.

## Preconditions

- Linux x64 or arm64 matching the release manifest.
- Node.js 22 or newer at `/usr/bin/node`.
- The M5.2 systemd identity, directories, credential sources, and router unit are installed.
- `/opt/codex-account-router/current` is a relative link to one retained release below
  `/opt/codex-account-router/releases/`.
- The new release archive checksum has been verified and the archive has been extracted into a
  root-controlled temporary directory.

The M5.2 `0.1.0` release is the documented implicit accounts/state schema-1 baseline. Beginning
with `0.2.0`, every manifest declares both schemas explicitly. An unsupported schema or a modified
release file fails before the service is stopped.

## Upgrade

After extracting the checked release, run one coordinated command from the extracted release:

```sh
sudo env NODE_BINARY=/usr/bin/node \
  /absolute/path/codex-account-router-0.2.2-linux-x64/bin/codex-stack-deploy \
  upgrade \
  --release-dir /absolute/path/codex-account-router-0.2.2-linux-x64
```

The JSON result contains `snapshot_id` and the activated release name. Save the snapshot ID in the
change record. The command:

1. validates the release manifest, every payload digest/mode, and schema compatibility;
2. validates `/etc/codex-account-router/accounts.json` and the optional circuit-state document;
3. creates a private snapshot under `/var/backups/codex-account-router/<snapshot_id>/`;
4. copies the new release to an immutable versioned directory;
5. stops only `codex-account-router.service`;
6. atomically activates the new release and starts the service;
7. checks `http://127.0.0.1:18318/healthz` with bounded retries and a 30-second deadline;
8. automatically rolls back if activation, restart, or health verification fails.

The App Server and codex-web services remain independently supervised. Restart either only when
the release notes explicitly change their compatibility boundary.

## Backup without upgrading

After `0.2.0` or a later compatible release is active:

```sh
sudo /opt/codex-account-router/current/bin/codex-stack-deploy backup
```

Each snapshot directory is mode `0700`; its manifest and copied files are mode `0600`. It records:

- the previous immutable release name;
- the schema-1 public account configuration;
- the schema-1 circuit-health state when present;
- original service UID/GID and private file modes;
- bounded sizes and SHA-256 digests.

Snapshots deliberately exclude systemd credentials, tokens, cookies, authorization values, account
email, and credential-store files. Back up credential sources only through the operator's approved
secret manager; do not add them to this snapshot or repository.

## One-command rollback

Use the exact snapshot ID emitted by `upgrade` or `backup`:

```sh
sudo /opt/codex-account-router/current/bin/codex-stack-deploy \
  rollback \
  --snapshot 20260727T080000000Z-0123456789ab
```

Rollback verifies the private snapshot and retained release before stopping the service. It then
atomically restores the account configuration, restores or removes the circuit-state file according
to the snapshot, switches `current` to the previous immutable release, starts the router, and runs
the same bounded loopback health check.

Do not delete the previous release or snapshot until the change window closes. Rollback does not
delete account credential sources and does not change App Server or codex-web state.

## Restart persistence

The router service sets:

```text
CODEX_ROUTER_STATE_DIRECTORY=/var/lib/codex-account-router
CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS=3
CODEX_ROUTER_FAILOVER_TOTAL_DEADLINE_MS=120000
CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS=100
CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS=2000
```

Quota, authentication, rate-limit, network, and upstream-5xx circuit failures are saved atomically.
Startup loads the private state before listeners begin. Shutdown flushes pending state writes, and a
restored open/half-open circuit is reflected in the sanitized admin status before another account
selection. If persistence fails, readiness fails closed and later selections reject rather than
silently forgetting cooldown history.

## Recovery checks

```sh
sudo systemctl status codex-account-router.service
curl --fail http://127.0.0.1:18318/healthz
readlink /opt/codex-account-router/current
sudo stat -c '%a %U:%G %n' \
  /var/backups/codex-account-router/<snapshot_id> \
  /var/lib/codex-account-router/circuit-state.json
```

Do not print snapshot contents, systemd credential contents, or authorization headers into tickets
or terminal transcripts. The native M5.3 verifier uses fixture-only account metadata and records
only booleans, versions, and release names.
