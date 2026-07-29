# Standalone 8215 startup R5 network diagnosis

Date: 2026-07-30 (Asia/Shanghai)
Scope: user-prioritized standalone 8215 startup latency inside M6.9
Repository: `ChengZhuoCZ/CodexWebManager`
Branch: `codex/m6-9-routed-failover-performance`
Input commit: `b322095fa069799428300da6696ba4a3dd53635d`
Dependencies: M2.5, M6.8, G-SECRETS

Expected output: identify and remove the dominant 8215 cold-start delay without
changing routed 8216, the account router, credentials, model traffic, or account
selection.

## Minimal experiment

The standalone service, App Server and Tailnet delivery path were measured
independently before considering a deployment.

Sanitized commands:

```text
curl --max-time 90 -D <headers> -o <html> -w <timings> http://100.95.50.98:8215/
curl --max-time 120 -H "Accept-Encoding: identity|gzip|br" -o /dev/null -w <timings> <versioned-main-url>
tailscale ping -c 5 100.95.50.98
tailscale netcheck
tailscale debug prefs
ssh <authorized-8215-host> "tailscale netcheck; tailscale status"
ssh <authorized-8215-host> "tailscale ping -c 10 <mac-tailnet-ip>"
ssh <authorized-8215-host> "tailscale version; sudo ufw status verbose; sudo nft list ruleset"
ssh <authorized-8215-host> "systemctl show tailscaled.service ...; sed -n ... /etc/default/tailscaled"
UPnP GetExternalIPAddress against the server's local gateway
fresh and repeated in-app browser navigation to the canonical root
```

Sanitized results:

- Root HTML returned HTTP 200 in 0.56 seconds.
- The versioned main module is immutable for one year and negotiates Brotli.
- Main module sizes were 14,138,835 bytes identity, 4,345,031 bytes gzip and
  3,294,106 bytes Brotli.
- Observed Brotli transfer time varied from about 23 to 64 seconds. A separate
  identity transfer delivered only 8,809,027 bytes before its 120-second
  deadline.
- The Web IPC round trip remained about 4 ms. App Server initialization and
  account/model metadata reads remained about 44–46 ms.
- Five Mac-to-server Tailscale probes used `DERP(tok)` at about 156–159 ms and
  ended with `direct connection not established`.
- Ten server-to-Mac probes used `DERP(hkg)` and also failed to establish a
  direct connection.
- The Mac has UDP, stable destination-independent IPv4 mapping, IPv6, and no
  selected exit node.
- The server has UDP and UPnP, but reports destination-dependent mapping. Its
  host firewall is inactive, the nftables input policy accepts traffic, and the
  Tailscale UDP 41641 rule is present.
- `tailscaled` already listens on fixed UDP port 41641.
- The server's first router reports a private WAN address in
  `192.168.33.0/24`, proving an upstream double-NAT boundary. Opening the Linux
  firewall or restarting 8215 cannot remove that boundary.
- A fresh browser document and a repeated document both eventually reached the
  signed-in composer. Individual observations were variable and are not used
  as a stable latency claim.

## Comparison with routed 8216

The portable r23 static differences are two early module hints totaling 2,495
bytes plus a content-hashed preload copy. The equivalent dependency and preload
bytes are identical between the two deployments. The routed main Brotli
artifact is only about 5.4 percent smaller. These differences cannot account
for, or remove, a 23–64 second transfer over the current relay path.

The existing 8215 artifact is already minified, Brotli quality 11 compressed,
content-versioned and immutable. A cache-disabling or service-restart change
would increase repeated transfer cost, so it was rejected.

## Result and blocker

No file, unit, release, credential or service was changed. No model request or
account switch was sent. All 8215, 8216 and router process/release baselines were
preserved.

The effective repair is to establish a direct UDP path or configure the
existing directly reachable VPS as a Tailscale peer relay. The latter preserves
the canonical URL `http://100.95.50.98:8215/` and is the preferred bounded
repair for this double-NAT topology. The local and 8215-server Tailscale clients
meet the documented peer-relay version requirement.

The VPS does not advertise peer-relay capability and the current thread has no
explicitly authorized SSH identity for that separate host. Credential/account
guessing was not attempted after access was rejected. Activation therefore
requires the user to provide or explicitly authorize the VPS SSH login, followed
by a narrowly scoped Tailnet relay grant. Until then, the network repair remains
pending and M6.9 stays `in_progress`.

