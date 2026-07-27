# Release status

## Decision

The current project is **not production-release qualified**.

The source is buildable for controlled `LIMITED_MODE` evaluation, and its automated security, Linux
packaging, systemd, upgrade, rollback, and fixture integration gates are green. Remote deployment is
currently blocked because the target host does not authorize passwordless SSH, so the Tailnet
HTTP/WebSocket authentication matrix has not run. M6.2 is also `rejected` under the user's explicit
skip decision: the required 24-hour soak was not completed and therefore was not qualified.

Real-account protocol continuity and account-switch E2E are also deferred. An accepted routing
change means a **new backend session**; it is not proof that an existing response chain or running
calculation moved between accounts.

## Gate summary

| Gate | Status | Meaning |
|---|---|---|
| Clean-room/license boundary | Passed | No protected CodexManager implementation was copied. |
| Protocol observation | Limited | Observed single-account protocol supports `LIMITED_MODE`; real A-to-B continuity is unverified. |
| Automated matrix | Passed | Node 22 and Node 24 each passed 226/226 at the current M6.3 commit with zero skips. |
| Security and secret audit | Passed | 268 files scanned with zero findings; 75/75 focused security tests passed. |
| Linux x64/arm64 packaging | Passed | Native Ubuntu build/install/health verification passed. |
| systemd lifecycle and rollback | Passed | Least-privilege lifecycle, persistence, upgrade, and rollback fixtures passed. |
| Remote Tailnet web authentication | Blocked | Node is online, but system SSH rejects the client key and Tailscale SSH does not advertise a host key. |
| M6.2 24-hour soak | Rejected | Stopped after about 17 minutes by user direction; no 24-hour qualification. |
| Real-account switching | Deferred | No second authorized Codex account was configured or switched. |
| Seamless/in-flight continuity | Not claimed | No evidence supports such a product claim. |

## Permitted use

- local development with synthetic fixtures;
- controlled internal evaluation on a private Linux host;
- operation behind an authenticated SSH or Tailscale data channel;
- testing new requests and explicit new-session routing behavior.

## Prohibited release claims

Do not claim that this revision:

- passed or completed the 24-hour soak;
- is production ready merely because it starts successfully;
- seamlessly preserves a conversation across account changes;
- resumes a running calculation in place after restart;
- passed real-account switching or cross-account response-chain portability;
- is safe to bind directly to a LAN or public interface.

## Remaining release work

1. Authorize passwordless SSH to the target, deploy the qualified loopback service, and complete the
   remote HTTP/WebSocket authentication matrix without configuring a real account.
2. Run the full procedure in [soak-test.md](soak-test.md) for 24 continuous hours on the target
   Linux topology and complete every scheduled restart drill.
3. With explicit authorization and two suitable accounts, complete the deferred real-account
   protocol and product E2E gates with redacted evidence.
4. Re-run the strict matrix, security audit, native systemd lifecycle, upgrade/rollback, and release
   packaging at the final candidate commit.
5. Review deployment-specific authentication, reverse proxy, backup retention, and incident
   response policy.

Operational steps are in [operator-guide.md](operator-guide.md), with detailed procedures in
[linux-headless-release.md](linux-headless-release.md),
[linux-systemd.md](linux-systemd.md), and
[linux-upgrade-rollback.md](linux-upgrade-rollback.md). Security and licensing constraints are in
[SECURITY.md](../SECURITY.md) and [LICENSE_BOUNDARY.md](../LICENSE_BOUNDARY.md).
