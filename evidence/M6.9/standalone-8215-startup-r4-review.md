# Standalone 8215 startup R4 review

The user explicitly delegated the reported standalone 8215 startup-page
incident to a subagent while the main thread continued M6.9 on 8216. The
subagent was restricted to 8215 and was instructed not to modify or restart
8216.

The server-side path was healthy:

- the root HTML and all eight referenced startup resources returned HTTP 200
  with the expected MIME type;
- the Tailnet TCP and WebSocket paths were reachable;
- the Web-to-App Server Unix socket was connected;
- a benign Web IPC round trip completed in about 4 ms;
- App Server initialization completed in about 45 ms;
- the account and seven-model catalog read completed in about 47 ms.

The main thread then opened a fresh browser page at
`http://100.95.50.98:8215/?repair=20260729-r4`. A single cold observation
reached the signed-in Codex page with an active `Do anything` composer in about
14.65 seconds. No model request or account switch was sent.

No 8215 service, file, unit, release, or credential was changed or restarted.
During the subagent's observation window, routed 8216 Web and App Server PID,
start-monotonic time, release, and effective-unit hashes were unchanged. The
main thread subsequently and independently upgraded only
`codex-account-router.service` from 0.2.5 to 0.2.6; that later router PID change
was not caused by this subtask, and the 8215 plus 8216 Web/App Server
invariants remained unchanged through it.

The remaining risk is variable cold browser startup rather than a demonstrated
server outage. If a fresh cache-busting URL stalls again, the minimum new
evidence is the first red browser Console error and its stack. This one
observation is not a stable startup-latency claim.
