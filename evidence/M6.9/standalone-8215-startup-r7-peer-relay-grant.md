# Standalone 8215 startup R7 peer-relay grant

Date: 2026-07-30 (Asia/Shanghai)
Scope: user-authorized Tailnet policy continuation for standalone 8215 inside M6.9
Repository: `ChengZhuoCZ/CodexWebManager`
Branch: `codex/m6-9-routed-failover-performance`
Input commit: `f4a0ae1c093ae93c0fe77835efcb44eec8b7493c`
Dependencies: M2.5, M6.8, G-SECRETS

Expected output: authorize and verify a narrowly scoped Peer Relay path for the
restrictive 8215 server without changing routed 8216, the account router,
credentials, model traffic, account selection, or the server's required Japan
Codex egress.

## Tailnet policy change

After the user completed the interactive Tailnet administrator sign-in, the
existing policy received one relationship-scoped application grant:

```json
{
  "src": ["100.95.50.98"],
  "dst": ["100.94.10.13"],
  "app": {
    "tailscale.com/cap/relay": []
  }
}
```

The source is only the restrictive 8215 server and the destination is only the
current Mac relay candidate. No wildcard source, tag expansion, exit-node
selection, SSH policy, or existing network grant changed. The policy editor
accepted the file, and its Save and Discard controls were disabled afterward,
confirming no unsaved browser-side edit remained.

The Mac retained `RelayServerPort=40000`, an empty exit-node selection, and
UDP listeners on both IPv4 and IPv6 port 40000.

## Minimal relay experiment

Sanitized commands:

```text
tailscale debug prefs
tailscale debug netmap | jq <relay-only projection>
tailscale status --json | jq <8215-only projection>
tailscale ping -c 5 100.95.50.98
tailscale debug peer-relay-sessions
tailscale debug metrics | grep <peer-relay counters>
ssh <authorized-8215-host> "sudo tailscale debug netmap | jq <relay-only projection>"
ssh <authorized-8215-host> "sudo tailscale debug peer-relay-servers"
ssh <authorized-8215-host> "tailscale ping -c 5 <mac-tailnet-ip>"
tailscale debug portmap --duration=8s
tailscale debug portmap --duration=8s --gateway-addr=<outer-gateway> --self-addr=<outer-private-address>
```

The Mac received the exact source-to-destination relay capability. The server
listed the Mac as its sole candidate peer-relay server and received the reverse
`relay-target` relationship. This proves that the grant direction and control
plane propagation are correct.

The data-plane session did not open. The Mac reported one relay session with
no handshake and zero packets, `udprelay_endpoints_connecting=1`, and
`udprelay_endpoints_open=0`. Five probes in each direction continued to use
DERP and ended without a direct connection.

The nearest gateway supports UPnP, but its reported external address is itself
private. A bounded diagnostic mapping was created and removed by the debug
helper; a subsequent exact UPnP lookup returned `NoSuchEntryInArray`. The
outer gateway did not expose a usable UPnP control endpoint. The Mac therefore
also has a double-NAT boundary for the dedicated UDP 40000 relay listener.
No persistent router mapping was created or deleted.

The grant is valid but cannot provide a working Peer Relay until UDP 40000 is
forwarded through both Mac-side NAT layers or a directly reachable authorized
VPS is configured as the relay.

## Current bounded performance observation

Read-only static probes against the canonical URL produced:

```text
root HTTP 200: TTFB 0.326 s, total 0.489 s
Brotli main 3294106 bytes: 3.257 s
Brotli main 3294106 bytes: 3.577 s
Brotli main 3294106 bytes: 2.573 s
```

The three main-module requests used distinct cache-busting query values and
explicit Brotli negotiation. One fresh browser navigation from a blank
document reached the signed-in Codex composer in 6.282 seconds. This is a
current bounded observation, not proof that DERP throughput or browser startup
will remain stable.

## End invariants

- Standalone Web remained PID 510876, start monotonic 196497166178.
- Standalone App Server remained PID 508396, start monotonic 194490256399.
- Account router remained PID 548777, start monotonic 209169242318.
- Routed App Server remained PID 495033, start monotonic 188703455626.
- Routed Web remained PID 538278, start monotonic 205386075436.
- Server-local 8215 and 8216 roots both returned HTTP 200 in about 1.3 ms.
- A no-model country check under the `codex` service UID returned `JP`.
- No service, release, unit, credential, model request, account switch, or
  account-continuity behavior changed.
- No stable startup guarantee, direct-path claim, Peer Relay success, seamless
  account continuity, or in-flight computation recovery is claimed.

## Residual risk

The canonical site is currently usable, but its data path remains dependent on
Tailscale DERP and can regress to the previously observed slow transfers. The
narrow Peer Relay policy and Mac listener remain configured but inactive at
the data plane. Completing the network repair requires an authorized
double-port-forward for UDP 40000 or an authorized, directly reachable VPS
relay. The real two-account M6.9 acceptance gate remains independently blocked.
