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
- 8216 Brotli delivery, startup background, signed-in composer, single-account
  model request, and post-fix log boundary are verified;
- 8215 remained active, independent, and HTTP 200;
- strict matrix: 253/253;
- focused security tests: 82/82;
- repository secret scan: 316 files, zero findings.

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
continuity remain unverified.
