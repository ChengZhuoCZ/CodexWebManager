# M6.2 fixture soak test

The M6.2 harness exercises the loopback-only router against deterministic fixture failures. It does
not load a real account, test account switching, or claim that an in-flight computation resumes
after a process restart.

## Acceptance run

Run the acceptance mode on Linux with Node.js 22 or newer. Acceptance duration is fixed in code to
24 wall-clock hours and cannot be shortened with a command-line option.

```sh
install -d -m 0700 /var/lib/codex-router-soak
node packages/account-router/scripts/run-soak.mjs \
  --mode acceptance \
  --summary /var/lib/codex-router-soak/soak-summary.json \
  --checkpoints /var/lib/codex-router-soak/soak-checkpoints.jsonl
```

The output directory and files are private (`0700`/`0600`). The runner emits one sanitized
checkpoint per minute, flushes it to disk, sends bounded fixture traffic at concurrency four, and
performs restart drills after approximately 1, 12, and 23 hours. A drill drains active requests,
restarts the router worker, and verifies only a new fixture request.

The run fails unless all of these conditions hold:

- at least 24 wall-clock hours and 95% checkpoint coverage;
- no unexpected worker exit, fatal message, or client request error;
- at most three upstream attempts per client request;
- client, worker, and upstream concurrency never exceed four;
- worker RSS is at most 256 MiB with at most 64 MiB absolute growth;
- worker file descriptors are at most 256 with at most 16 absolute growth;
- all three restart drills recover new fixture traffic with no active request at stop.

Stopping the runner early writes a summary but cannot produce `qualified_24_hour_soak: true`.

## Short smoke

Smoke mode validates the harness and restart path without satisfying the 24-hour gate:

```sh
node packages/account-router/scripts/run-soak.mjs \
  --mode smoke \
  --duration-ms 5000 \
  --summary /absolute/private/path/smoke-summary.json \
  --checkpoints /absolute/private/path/smoke-checkpoints.jsonl
```

Every summary explicitly records:

```json
{
  "real_account_configured": false,
  "account_switch_tested": false,
  "in_flight_computation_resume_claimed": false,
  "seamless_account_continuity_claimed": false
}
```

Do not publish host addresses, user names, credentials, or raw service-manager output in repository
evidence. Copy only the sanitized harness summary and checkpoints after verifying these fields.
