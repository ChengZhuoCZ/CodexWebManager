# M0 protocol observer

This is a clean-room experiment, not the production account router.

It binds only to `127.0.0.1`, forwards HTTP/SSE and WebSocket traffic to an explicitly
configured upstream origin, and writes JSONL records containing protocol shape
only:

- sanitized path and query-key names;
- request/response header names, with sensitive-header presence only;
- JSON body field paths and value types, never values;
- HTTP status/content type;
- SSE or WebSocket event types, never event/frame data.

Run it with Node.js 22 or newer:

```bash
UPSTREAM_ORIGIN=https://chatgpt.com \
OBSERVATION_LOG=/absolute/path/protocol-redacted.jsonl \
PORT=18319 \
node src/cli.mjs
```

The upstream URL must be an HTTP(S) origin without credentials, query, or
fragment. The observer deliberately rejects non-loopback bind hosts.

Run fixture tests:

```bash
npm test
```

For WebSockets, the observer removes compression negotiation so it can inspect
text-frame JSON shape while forwarding the original frames unchanged. Binary or
non-JSON frames are forwarded but not persisted.

Do not use an observation log as a general HTTP trace. It intentionally omits
payload values, credentials, cookies, response bodies, and dynamic path IDs.
