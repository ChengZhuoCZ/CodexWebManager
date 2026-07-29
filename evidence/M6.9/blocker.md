# M6.9 blocker

## Blocking condition

The router contains one configured, enabled, usable user-authorized account
credential. A second user-authorized credential now exists only as the
standalone 8215 systemd credential. The user authorized changing 8215, not
copying or enrolling that credential into the router, so a real new-request
A-to-B switch cannot yet be executed.

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
- r19 adds a pinned, fail-closed Terser 5.49.0 second stage; its deterministic
  3,173,689-byte Brotli main response is 120,417 bytes smaller than r18;
- r20 replaces the preload module reference with a deterministic
  eight-character content-hash filename; live identity/gzip/Brotli hashes pass
  and the versioned response is immutable while the retained unversioned path
  stays compatible;
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
- a later explicitly authorized 8215 account change isolated the standalone
  credential from the router, completed a signed-in browser/model check, and
  left both 8216 activation timestamps unchanged;
- r19 activation changed only 8216 and preserved repaired 8215 plus the routed
  App Server activation timestamps;
- r20 activation started only the isolated 8216 units and preserved the 8215
  Web/App Server PIDs and timestamps through two rollback attempts and the
  final successful deployment;
- strict release matrix: 259/259;
- focused security tests: 83/83;
- repository secret scan: 320 files, zero findings.

## Required external input

Explicitly authorize enrolling the standalone-only credential into the
account router. The installed `codex-router-account enroll` workflow can then
copy it atomically from its existing private root-owned mode-`0600` path
without printing or pasting its contents into chat or shell history.

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

Independent of that external gate, one auxiliary 8216 thread-title request
currently receives HTTP 405 and model-manager refreshes can time out. The
fixed signed-in chat model path completed after r20, so these are residual
operational follow-ups rather than evidence of a successful or failed
cross-account switch.
