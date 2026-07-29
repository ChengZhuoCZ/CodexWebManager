# 8215 startup-page independent review, round 2

Date: 2026-07-29 (Asia/Shanghai)

The user assigned this review to a subagent while the primary agent continued
M6.9 on 8216. The review was restricted to standalone 8215. It did not restart
or modify any service, unit, file, release, or symlink, and it did not send a
model prompt or test account switching.

Server-side startup was healthy:

- root HTML and all eight declared boot resources returned HTTP 200 with the
  expected media types;
- the principal JavaScript files passed syntax checks;
- a Mac-to-Tailnet cache-busting request returned HTTP 200 in 0.490 seconds;
- the Tailnet WebSocket upgrade returned 101 and a benign Web IPC round trip
  completed;
- the Web process had an established connection to the App Server Unix socket;
- App Server `initialize`, account read, and model-list calls completed;
- an account was present and seven models were reported without recording model
  names.

The final service baselines were identical to the initial baselines:

| Service | PID | Start monotonic |
| --- | ---: | ---: |
| `codex-web-upstream.service` | 510876 | 196497166049 |
| `codex-web-upstream-app-server.service` | 508396 | 194490256322 |
| `codex-account-router.service` | 516181 | 197570548095 |
| `codex-web-router-app-server.service` | 495033 | 188703455553 |
| `codex-web-router.service` | 495185 | 188703695080 |

The 8215 symptom is therefore consistent with a browser document that remained
open across the earlier Web-service restart and retained a dead in-memory IPC
connection. The operator action is a hard refresh or a new tab at
`http://100.95.50.98:8215/?repair=20260729-r2`. If a fresh document still
stalls, a browser screenshot or Console error is required; there is no
remaining server-side failure proven by this review.
