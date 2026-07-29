# Standalone 8215 startup repair

Date: 2026-07-29 (Asia/Shanghai)

This was an explicit user-requested parallel repair, limited to standalone
8215 while M6.9 work continued on 8216.

## Cause

The standalone App Server had restarted after the Web process. The existing
`codex-remote-proxy.mjs` process makes one Unix-socket WebSocket connection and
does not reconnect after the App Server replaces its socket. The Web listener
therefore continued returning HTTP 200 while the renderer remained at its
startup screen.

A read-only protocol probe through the App Server socket completed
initialization, proving that the App Server and replacement socket were
healthy. Before repair there was no established Unix-socket connection from
the Web proxy.

## Repair

Only `codex-web-upstream.service` was restarted. The signed-in App Server
remained running with PID `508396` and monotonic start `194490256322`.

The 8215-only drop-in
`/etc/systemd/system/codex-web-upstream.service.d/app-server-lifecycle.conf`
now contains:

```ini
[Unit]
PartOf=codex-web-upstream-app-server.service
```

This makes an explicit future App Server restart propagate to the standalone
Web service so that its one-shot proxy reconnects. Removing this single
drop-in and running `systemctl daemon-reload` is the rollback.

## Verification

- Web PID changed from `466019` to `510876`, as intended.
- App Server PID and start time did not change.
- The replacement Unix-socket connection was established.
- HTML and the primary JavaScript asset returned HTTP 200.
- `/__backend/ipc` accepted a WebSocket connection.
- Safe App Server probes completed `initialize`, account read, and model list;
  an account was present and seven models were listed.
- No prompt or model request was sent.
- Mac-to-Tailnet HTTP returned 200 in 0.541 seconds during the repair check.
- The three 8216 services retained their original PIDs and monotonic start
  times during the 8215 repair.

The browser-control backend was unavailable to the repair worker, so this
repair does not include a pixel or DOM assertion. It does include the actual
Web IPC handshake and backend initialization path.
