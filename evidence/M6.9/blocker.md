# M6.9 blocker

## Blocking condition

The server contains one configured, enabled, usable user-authorized account
credential. A second private Codex credential is not present, so a real
new-request A-to-B switch cannot be executed.

## Completed before blocking

- atomic private account-enrollment command implemented, tested, packaged, and
  installed;
- weekly quota and explicit pre-semantic HTTP/SSE/WebSocket failure matrices
  pass with bounded attempts, backoff, and total deadline;
- no replay after semantic output is enforced;
- 8216 reproducible minification, output-hash module versioning,
  Brotli/gzip negotiation, and clean-room authenticated Statsig event
  collection disablement are verified;
- r16 deterministically places the main-module resource hint before the
  synchronous Tailnet startup shim while preserving the r15 asset URL/cache;
- r17 hash-pins and inlines the 1,942-byte startup shim at the same execution
  position, removing its separate `max-age=0` Tailnet request while preserving
  the r16 main URL/cache;
- r18 adds deterministic 4,149-byte Brotli and 5,960-byte gzip representations
  for the final HTML while preserving its identity bytes and hash;
- live r17 signed-in composer and two fixed non-private single-account model
  sentinels completed;
- live r18 signed-in composer and one fixed non-private single-account model
  sentinel completed;
- r17 page diagnostics contained zero Statsig/manual-flush/event-drop warnings
  and zero error logs;
- App Server timing probes completed in 1.5-23.2 ms per method after a
  15.8 ms initialization, while browser startup remained variable;
- after an explicit user-authorized interrupt, standalone 8215 was repaired
  with an immutable optimized release and a stdout-discarding systemd log
  boundary; its signed-in composer and real model path completed, and the
  post-boundary journal contained zero sensitive-shape or sentinel matches;
- r18 activation changed only 8216 and preserved repaired 8215 plus the routed
  App Server activation timestamps;
- strict release matrix: 258/258;
- focused security tests: 83/83;
- repository secret scan: 319 files, zero findings.

## Required external input

Stage a second user-authorized Codex `auth.json` as a private regular mode
`0600` file on the server without printing or pasting its contents into chat
or shell history. The installed `codex-router-account enroll` workflow can
then add it atomically.

After enrollment, M6.9 still requires:

1. readiness showing two usable accounts;
2. a minimal authorized request selecting account A;
3. a controlled pre-semantic quota/failure boundary that selects account B for
   a new request;
4. proof that a post-semantic failure is not replayed;
5. service restart and readiness recheck with both bindings;
6. sanitized evidence with no prompt/response body, email, provider account
   identifier, token, cookie, or complete quota response.

Until those steps pass, real automatic account switching and cross-account
continuity remain unverified. No seamless continuity or in-flight computation
resume is claimed.
