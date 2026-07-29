# 8215 startup-page incident review (round 3)

Date: 2026-07-29 (Asia/Shanghai)
Scope: current standalone 8215 incident only
Outcome: the current server-side 8215 path is healthy and reachable; no
server-side mutation or restart was justified in this round.

## Boundary

The only mutable scope authorized for this incident was:

- `codex-web-upstream.service`
- `codex-web-upstream-app-server.service`
- 8215-only files below `/opt/0xcaff-codex-web`

All 8216/router services and `/opt/0xcaff-codex-web-router` were read only.
No credential contents were read or printed. No model conversation and no
account switch were attempted.

## Fresh baseline

This baseline was captured after the new incident was reported; it was not
copied from the prior review.

| Service | PID | Start monotonic | State |
| --- | ---: | ---: | --- |
| `codex-web-upstream.service` | 510876 | 196497166049 | active/running |
| `codex-web-upstream-app-server.service` | 508396 | 194490256322 | active/running |
| `codex-account-router.service` | 524721 | 200897483122 | active/running |
| `codex-web-router-app-server.service` | 495033 | 188703455553 | active/running |
| `codex-web-router.service` | 538278 | 205386075197 | active/running |

Releases:

- 8215:
  `/opt/0xcaff-codex-web/releases/c3e92f0-20260729-tailnet-startup-r3`
- 8216:
  `/opt/0xcaff-codex-web-router/releases/c3e92f0f-20260729-m69-router-r23`

Effective-unit SHA-256:

| Service | SHA-256 |
| --- | --- |
| `codex-web-upstream.service` | `543ddc71409cc088522e80651955a988cc9f2229e9da29dc8a9107c3def3ea1a` |
| `codex-web-upstream-app-server.service` | `daaefec18fde144f1801e5b4e60a13cfe9e7c8abe98799192ee59a0f3b66db2f` |
| `codex-account-router.service` | `230dba0a5f7e283f4db2291e4bc6ab7b078eebd63e89e9275a9028185531dddc` |
| `codex-web-router-app-server.service` | `5b44e7e28c57daebdf97eb9e5bbb1e5cd6655a7511a7117079988326fea1be2b` |
| `codex-web-router.service` | `bcf691a9362a8f91c4a8d2680631b238bd6ba9ada7e18975bdc567ace4823ca2` |

## Current incident diagnostics

### HTML and every declared boot asset

- Root HTML returned HTTP 200, 17,576 bytes.
- A strict HTML parser found eight declared boot resources.
- All eight returned HTTP 200 and the expected content type:
  - six JavaScript resources;
  - one CSS resource;
  - one SVG icon;
  - one JSON manifest.
- The main application bundle returned 14,138,835 bytes.
- Local 8215 root response time was about 1 ms.

### Tailnet route and WebSocket

From the current Mac:

- Fresh cache-key URL
  `http://100.95.50.98:8215/?repair=20260729-r3`
  returned HTTP 200, 17,576 bytes
  (`ttfb=0.315 s`, `total=0.514 s`).
- A WebSocket upgrade through the same Tailnet address returned
  `101 Switching Protocols`. The diagnostic client then intentionally timed out
  because it did not send application traffic.

### Browser-facing IPC

- `ws://127.0.0.1:8215/__backend/ipc` opened successfully.
- A benign workspace-directory IPC request/response round trip returned
  `ipc_roundtrip=ok`. Only the result boolean and entry count were printed.
- A separate in-app browser document opened the exact fresh cache-key URL. Its
  signed-in Codex navigation, chat list, and active `Do anything` composer all
  appeared without a model request. The single cold-document observation took
  about 50 seconds to reach the composer, while the root HTML itself arrived in
  0.514 seconds. This confirms reachability but not acceptable or stable startup
  latency; renderer transfer/parse work over the DERP path remains a separate
  performance issue.

An additional probe reached the AppView RPC registration layer but used a Codex
JSON-RPC initialization object where the internal AppView envelope was expected.
The temporary diagnostic port rejected that payload and closed as designed.
This produced one `bad RPC message` diagnostic line, did not invoke a model,
did not change account state, and did not affect the existing renderer or
services. It was not used as success evidence.

### Web-to-App-Server Unix socket

- `/run/codex-web-upstream-app-server/app-server.sock` existed as a socket,
  mode `0600`, owner `codex:codex`.
- `ss -xnap` showed the listening socket and an established Web-proxy
  connection.
- The expected `codex-remote-proxy.mjs` child remained attached to the 8215 Web
  process.

### App Server

A separate read-only connection through the production Unix socket returned:

- `initialize=ok`;
- `account_read=ok`;
- account object present;
- `model_list=ok`, seven models.

No prompt, turn, generation, account switch, or credential-read request was
sent.

Recent service logs contained periodic background model-refresh timeouts and
one unrelated pre-existing tool failure. The direct model-list call returned
seven models immediately. There was no current authentication failure, socket
disconnect, initialization failure, service crash, or restart loop.

## Action

No repair mutation was performed because every independently testable
server-side layer passed:

1. Tailnet TCP/HTTP;
2. complete HTML boot-resource graph;
3. Tailnet WebSocket upgrade;
4. browser-facing IPC request/response;
5. Web-to-App-Server Unix socket;
6. App Server initialization;
7. signed-in account state;
8. model catalog.

Restarting a healthy service would only invalidate existing browser WebSockets
and make the reported startup-page symptom more likely.

## Final invariant

At the end of the review:

- all five services had exactly the same PID, start-monotonic value, and active
  state as the fresh baseline;
- both release symlinks were unchanged;
- all five effective-unit SHA-256 values exactly matched the baseline;
- 8215 and 8216 both returned HTTP 200 locally.

Therefore no 8216/router process, unit, release, symlink, credential, or port
was changed.

## Current access result

The 8215 server is currently reachable and its startup dependencies pass.
Use the newly verified URL:

`http://100.95.50.98:8215/?repair=20260729-r3`

The independent browser verification reached the signed-in composer at this
exact URL. If another client still remains on the startup screen for longer
than the observed cold-start interval, the remaining required evidence is a
screenshot or browser-console error from that fresh document. The current
server state does not support a safe additional server-side repair.
