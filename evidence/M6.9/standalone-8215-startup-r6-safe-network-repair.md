# Standalone 8215 startup R6 safe network repair

Date: 2026-07-30 (Asia/Shanghai)
Scope: user-authorized network repair for standalone 8215 inside M6.9
Repository: `ChengZhuoCZ/CodexWebManager`
Branch: `codex/m6-9-routed-failover-performance`
Input commit: `07a85e6`
Dependencies: M2.5, M6.8, G-SECRETS

Expected output: improve the China-client path to standalone 8215 without
changing the requirement that Codex/OpenAI egress from the server uses the
Japan VPN, without changing routed 8216 or the account router, and without
sending a model request or testing account switching.

## Baseline

All five production processes were active before the experiment:

| Service | PID | Start monotonic |
| --- | ---: | ---: |
| standalone Web | 510876 | 196497166178 |
| standalone App Server | 508396 | 194490256399 |
| account router | 548777 | 209169242318 |
| routed App Server | 495033 | 188703455626 |
| routed Web | 538278 | 205386075436 |

The releases remained standalone r3, routed r23 and router 0.2.6. The server
used fixed Tailscale UDP port 41641. Both directions remained DERP relayed.

## Minimal VPN-bypass experiment

The existing `mihomo-tailscale-bypass.service` only marked the dedicated
Mihomo service UID. A temporary nftables rule additionally marked root-owned
UDP packets with source port 41641. Before the rule was added, a transient
systemd timer was scheduled to restart the original bypass service after 180
seconds.

The rule matched 90 Tailscale packets, proving that those packets traversed the
host TUN policy. Ten probes in each direction still remained on DERP and did
not establish a direct connection. The rule therefore did not solve the
upstream NAT boundary and was rejected.

The rollback service was invoked early. The original nftables table contained
only its pre-existing UID rule again, and the persistent file retained SHA-256
`a536c6ec798b90fa6e402794f39fb40755a3653e7bf18b9cf6e0ba8a9d1cdac8`.
`tailscaled`, the dedicated Mihomo service and its bypass service were all
active. No persistent server configuration changed.

## Double-NAT experiment

The inner TP-Link router had no UDP 41641 mapping. A proposed 300-second UPnP
mapping was rejected before creation because all 16 mapping slots were full.
The entries were owned by the same internal server address and described as
`wechat voip`. They were not deleted because doing so could disrupt an
unrelated service.

The upstream gateway is an H3C device and redirects management access to its
login page. No credential guessing or router mutation was attempted. A direct
path therefore still requires an authorized H3C login, bridge/AP conversion,
or a safe double port-forward.

## Codex VPN invariant

A non-model HTTPS country-code request executed under the `codex` service UID
returned `JP`. This preserved the explicit requirement that Codex/OpenAI egress
uses the Japan VPN. No provider endpoint, prompt, turn, model response or
account switch was invoked.

## Safe peer-relay continuation

The current China Mac was configured as a reversible peer-relay candidate on
UDP port 40000:

```text
RelayServerPort=40000
ExitNodeID=""
ExitNodeIP=""
UDP=true
MappingVariesByDestIP=false
IPv6=true
PortMapping=UPnP
```

The Mac is not using an exit node. The relay capability does not become
eligible until a narrowly scoped Tailnet grant is added. The admin page
currently requires an interactive user sign-in, so no policy was changed.

The pending grant must name only the restrictive 8215 server as its source and
the current Mac as its relay destination; it must not use a wildcard source.
If the grant does not produce `peer-relay` or a direct path, the Mac setting is
reverted with:

```text
tailscale set --relay-server-port=""
```

## End invariant

- Five production PIDs and start times matched the baseline.
- Standalone 8215, routed 8216 and the router were not restarted.
- The persistent server nftables file and its hash were unchanged.
- No UPnP mapping was created or deleted.
- Codex egress remained in Japan.
- No credential content, model request, account switch or continuity claim was
  produced.
- M6.9 remains `in_progress` pending the Tailnet grant or authorized upstream
  router/VPS access.

