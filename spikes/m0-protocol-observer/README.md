# M0 protocol observer

This is a clean-room experiment, not the production account router.

It binds only to `127.0.0.1`, forwards HTTP/SSE and WebSocket traffic to an explicitly
configured upstream origin, and writes JSONL records containing protocol shape
only:

- sanitized path and query-key names;
- request/response header names, with sensitive-header presence only;
- JSON body field paths and value types, never values;
- HTTP status/content type;
- SSE or WebSocket event types, never event/frame data.

Run it with Node.js 22 or newer:

```bash
UPSTREAM_ORIGIN=https://chatgpt.com \
OBSERVATION_LOG=/absolute/path/protocol-redacted.jsonl \
PORT=18319 \
node src/cli.mjs
```

The upstream URL must be an HTTP(S) origin without credentials, query, or
fragment. The observer deliberately rejects non-loopback bind hosts.

Run fixture tests:

```bash
npm test
```

Run the M0.3 real-account control groups with an explicitly authorized `CODEX_HOME`:

```bash
M0_3_MODE=control \
M0_3_SCENARIOS=continuity,restart,boundaries \
M0_3_EVIDENCE_DIR=/absolute/path/to/evidence/M0.3 \
M0_3_SUMMARY_LOG=/absolute/path/to/evidence/M0.3/control-summary.jsonl \
CODEX_HOME_A=/absolute/path/to/account-a-home \
node scripts/run-continuity.mjs
```

`M0_3_SCENARIOS` accepts `continuity`, `restart`, `boundaries`, or `all`. Targeted groups make a
transient upstream failure repeatable without rerunning completed model calls.

Cross-account mode requires two distinct, user-authorized homes. The relay compares identity
headers in memory, logs only whether they differ, and removes its temporary credential copies when
the run ends:

```bash
M0_3_MODE=cross \
M0_3_SCENARIOS=continuity,boundaries \
M0_3_EVIDENCE_DIR=/absolute/path/to/evidence/M0.3 \
M0_3_SUMMARY_LOG=/absolute/path/to/evidence/M0.3/cross-summary.jsonl \
CODEX_HOME_A=/absolute/path/to/account-a-home \
CODEX_HOME_B=/absolute/path/to/account-b-home \
node scripts/run-continuity.mjs
```

Mock tests cannot substitute for this real A-to-B run. Do not use the output to claim seamless
continuity until every required cross-account row is complete.

For WebSockets, the observer removes compression negotiation so it can inspect
text-frame JSON shape while forwarding the original frames unchanged. Binary or
non-JSON frames are forwarded but not persisted.

Do not use an observation log as a general HTTP trace. It intentionally omits
payload values, credentials, cookies, response bodies, and dynamic path IDs.
