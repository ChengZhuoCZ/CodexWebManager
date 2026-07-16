import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { sanitizeEventType } from "./shape.mjs";
import {
  createTextMessageAssembler,
  createWebSocketFrameParser,
  encodeWebSocketFrame,
  isSemanticResponseEvent,
} from "./websocket-frames.mjs";

const ACCOUNT_ALIASES = new Set(["account-a", "account-b"]);
const IDENTITY_HEADER_NAMES = new Set(["authorization", "chatgpt-account-id", "cookie"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  "connection",
  "host",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
]);
const ALLOWED_PATH_PREFIX = "/backend-api/codex/";
const RESPONSES_PATH = "/backend-api/codex/responses";

class SafeJsonlLogger {
  constructor(logPath) {
    this.logPath = logPath;
    this.pending = Promise.resolve();
  }

  write(record) {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`;
    this.pending = this.pending.then(() => fs.appendFile(this.logPath, line, { mode: 0o600 }));
    return this.pending;
  }

  flush() {
    return this.pending;
  }
}

function validateOrigin(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("upstreamOrigin must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("upstreamOrigin must be an origin without credentials or path data");
  }
  return url;
}

function parseAliasedRequest(rawUrl) {
  const parsed = new URL(rawUrl, "http://127.0.0.1");
  const segments = parsed.pathname.split("/").filter(Boolean);
  const alias = segments.shift();
  if (!ACCOUNT_ALIASES.has(alias)) {
    return null;
  }
  const pathname = `/${segments.join("/")}`;
  if (!pathname.startsWith(ALLOWED_PATH_PREFIX)) {
    return null;
  }
  return { alias, pathname, search: parsed.search };
}

function filterRequestHeaders(headers, targetHost) {
  const output = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === "host" || HOP_BY_HOP_HEADERS.has(name) || rawValue === undefined) {
      continue;
    }
    output[name] = rawValue;
  }
  output.host = targetHost;
  return output;
}

function filterResponseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function headerValue(value) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value === undefined ? undefined : String(value);
}

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function closeFramePayload(code, reason) {
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const output = Buffer.alloc(2 + reasonBytes.length);
  output.writeUInt16BE(code, 0);
  reasonBytes.copy(output, 2);
  return output;
}

function parseHttpHeaderBlock(block) {
  const lines = block.toString("latin1").split("\r\n");
  const statusLine = lines.shift() ?? "HTTP/1.1 502 Bad Gateway";
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "502", 10);
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number.isInteger(status) ? status : 502, headers };
}

function buildUpstreamHeaders(templateHeaders, credentialHeaders, target, websocketKey) {
  const output = {};
  for (const [rawName, rawValue] of Object.entries(templateHeaders)) {
    const name = rawName.toLowerCase();
    if (WEBSOCKET_HANDSHAKE_HEADERS.has(name) || IDENTITY_HEADER_NAMES.has(name)) {
      continue;
    }
    const value = headerValue(rawValue);
    if (value !== undefined) {
      output[name] = value;
    }
  }
  for (const [name, value] of Object.entries(credentialHeaders)) {
    output[name] = value;
  }
  output.host = target.host;
  output.connection = "Upgrade";
  output.upgrade = "websocket";
  output["sec-websocket-key"] = websocketKey;
  output["sec-websocket-version"] = "13";
  return output;
}

function connectRawWebSocket({ upstream, pathname, search, templateHeaders, credentialHeaders, onFrame, onClose }) {
  const target = new URL(`${pathname}${search}`, upstream);
  const port = Number.parseInt(target.port || (target.protocol === "https:" ? "443" : "80"), 10);
  const websocketKey = randomBytes(16).toString("base64");
  const expectedAccept = websocketAccept(websocketKey);
  const headers = buildUpstreamHeaders(templateHeaders, credentialHeaders, target, websocketKey);
  const requestLine = `GET ${target.pathname}${target.search} HTTP/1.1`;
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  const requestBytes = Buffer.from(`${requestLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`, "latin1");

  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    let handshakeBuffer = Buffer.alloc(0);

    const socket =
      target.protocol === "https:"
        ? tls.connect({
            host: target.hostname,
            port,
            ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
          })
        : net.connect({ host: target.hostname, port });

    const frameParser = createWebSocketFrameParser({
      expectMasked: false,
      onFrame,
    });

    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      socket.destroy();
    };

    socket.once(target.protocol === "https:" ? "secureConnect" : "connect", () =>
      socket.write(requestBytes),
    );
    socket.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else if (opened) {
        onClose("network_error");
      }
    });
    socket.once("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("upstream WebSocket closed during handshake"));
      } else if (opened) {
        onClose("closed");
      }
    });
    socket.on("data", (chunk) => {
      if (opened) {
        try {
          frameParser.push(chunk);
        } catch {
          onClose("protocol_error");
          socket.destroy();
        }
        return;
      }

      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      if (handshakeBuffer.length > 64 * 1024) {
        fail(new Error("upstream WebSocket handshake is too large"));
        return;
      }
      const separator = handshakeBuffer.indexOf("\r\n\r\n");
      if (separator === -1) {
        return;
      }

      const { status, headers: responseHeaders } = parseHttpHeaderBlock(
        handshakeBuffer.subarray(0, separator),
      );
      if (status !== 101 || responseHeaders["sec-websocket-accept"] !== expectedAccept) {
        fail(new Error(`upstream WebSocket rejected the handshake with status ${status}`));
        return;
      }
      if (responseHeaders["sec-websocket-extensions"]) {
        fail(new Error("upstream unexpectedly negotiated a WebSocket extension"));
        return;
      }

      const head = handshakeBuffer.subarray(separator + 4);
      handshakeBuffer = Buffer.alloc(0);
      opened = true;
      settled = true;
      const client = {
        sendText(value) {
          socket.write(encodeWebSocketFrame(value, { opcode: 0x1, masked: true }));
        },
        sendFrame(opcode, payload) {
          socket.write(encodeWebSocketFrame(payload, { opcode, masked: true }));
        },
        destroy() {
          opened = false;
          socket.destroy();
        },
        get destroyed() {
          return socket.destroyed;
        },
      };
      resolve(client);
      if (head.length > 0) {
        queueMicrotask(() => frameParser.push(head));
      }
    });
  });
}

export async function createContinuityRelay({
  upstreamOrigin,
  logPath,
  routePlan = [],
  host = "127.0.0.1",
  port = 0,
}) {
  if (host !== "127.0.0.1") {
    throw new Error("continuity relay must bind to 127.0.0.1");
  }
  if (!logPath) {
    throw new Error("logPath is required");
  }

  const upstream = validateOrigin(upstreamOrigin);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "", { mode: 0o600 });
  const logger = new SafeJsonlLogger(logPath);
  const identities = new Map();
  const sessions = new Set();
  let messageSequence = 0;
  let unsafeAfterSemantic = false;

  function captureIdentity(alias, headers) {
    const captured = {};
    for (const name of IDENTITY_HEADER_NAMES) {
      const value = headerValue(headers[name]);
      if (value !== undefined) {
        captured[name] = value;
      }
    }
    if (!captured.authorization) {
      return;
    }
    identities.set(alias, captured);
    void logger.write({
      kind: "identity_headers_captured",
      account_alias: alias,
      header_names: Object.keys(captured).sort(),
    });
    if (identities.has("account-a") && identities.has("account-b")) {
      const left = identities.get("account-a");
      const right = identities.get("account-b");
      void logger.write({
        kind: "identity_comparison",
        distinct:
          left.authorization !== right.authorization ||
          left["chatgpt-account-id"] !== right["chatgpt-account-id"],
      });
    }
  }

  const server = http.createServer((request, response) => {
    const parsed = parseAliasedRequest(request.url ?? "/");
    if (!parsed) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"route_not_allowed"}');
      return;
    }

    captureIdentity(parsed.alias, request.headers);
    const target = new URL(`${parsed.pathname}${parsed.search}`, upstream);
    const client = target.protocol === "https:" ? https : http;
    const upstreamRequest = client.request(
      target,
      {
        method: request.method,
        headers: filterRequestHeaders(request.headers, target.host),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          filterResponseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstreamRequest.once("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end('{"error":"upstream_unavailable"}');
    });
    request.pipe(upstreamRequest);
  });

  server.on("upgrade", (request, downstream, head) => {
    const parsed = parseAliasedRequest(request.url ?? "/");
    const key = headerValue(request.headers["sec-websocket-key"]);
    if (!parsed || parsed.pathname !== RESPONSES_PATH || !key) {
      downstream.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    captureIdentity(parsed.alias, request.headers);
    downstream.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    const session = {
      downstream,
      inputAlias: parsed.alias,
      pathname: parsed.pathname,
      search: parsed.search,
      templateHeaders: request.headers,
      upstreamConnection: null,
      upstreamAlias: null,
      upstreamGeneration: 0,
      activePlan: null,
      processing: Promise.resolve(),
      closed: false,
    };
    sessions.add(session);
    void logger.write({ kind: "downstream_websocket_accepted", account_alias: parsed.alias });

    function closeSession(code = 1011, reason = "relay_closed") {
      if (session.closed) {
        return;
      }
      session.closed = true;
      session.upstreamGeneration += 1;
      session.upstreamConnection?.destroy();
      if (!downstream.destroyed) {
        downstream.write(
          encodeWebSocketFrame(closeFramePayload(code, reason), { opcode: 0x8, masked: false }),
        );
        downstream.end();
      }
      sessions.delete(session);
      void logger.write({ kind: "downstream_websocket_closed", close_code: code });
    }

    async function openForAlias(alias) {
      const credentialHeaders = identities.get(alias);
      if (!credentialHeaders) {
        throw new Error(`identity headers have not been captured for ${alias}`);
      }
      if (
        session.upstreamConnection &&
        !session.upstreamConnection.destroyed &&
        session.upstreamAlias === alias
      ) {
        return session.upstreamConnection;
      }

      session.upstreamGeneration += 1;
      const generation = session.upstreamGeneration;
      session.upstreamConnection?.destroy();
      session.upstreamConnection = null;
      session.upstreamAlias = null;
      void logger.write({ kind: "upstream_route_attempt", account_alias: alias });

      const connection = await connectRawWebSocket({
        upstream,
        pathname: session.pathname,
        search: session.search,
        templateHeaders: session.templateHeaders,
        credentialHeaders,
        onFrame(frame) {
          if (generation !== session.upstreamGeneration || session.closed) {
            return;
          }
          if (frame.opcode === 0x9) {
            connection.sendFrame(0xa, frame.payload);
            return;
          }
          if (frame.opcode === 0x8) {
            closeSession(1011, "upstream_closed");
            return;
          }

          if (frame.opcode === 0x1) {
            let eventType = "unknown";
            try {
              const message = JSON.parse(frame.payload.toString("utf8"));
              eventType = sanitizeEventType(message?.type);
            } catch {
              // Non-JSON text is forwarded without persistence.
            }
            const semantic = isSemanticResponseEvent(eventType);
            void logger.write({
              kind: "upstream_event",
              account_alias: alias,
              event_type: eventType,
              semantic,
            });
            downstream.write(
              encodeWebSocketFrame(frame.payload, {
                opcode: frame.opcode,
                masked: false,
                final: frame.final,
              }),
            );

            if (semantic && session.activePlan?.cutAfterSemantic === true) {
              unsafeAfterSemantic = true;
              void logger.write({
                kind: "failure_injected",
                boundary: "after_first_semantic_event",
                replay_allowed: false,
              });
              connection.destroy();
              closeSession(1011, "unsafe_to_replay");
            }
            return;
          }

          downstream.write(
            encodeWebSocketFrame(frame.payload, {
              opcode: frame.opcode,
              masked: false,
              final: frame.final,
            }),
          );
        },
        onClose(category) {
          if (generation !== session.upstreamGeneration || session.closed) {
            return;
          }
          void logger.write({ kind: "upstream_websocket_closed", category });
          closeSession(1011, "upstream_unavailable");
        },
      });

      if (generation !== session.upstreamGeneration || session.closed) {
        connection.destroy();
        throw new Error("upstream route was superseded");
      }
      session.upstreamConnection = connection;
      session.upstreamAlias = alias;
      void logger.write({ kind: "upstream_route_selected", account_alias: alias });
      return connection;
    }

    async function handleTextMessage(rawText) {
      let message;
      try {
        message = JSON.parse(rawText);
      } catch {
        if (!session.upstreamConnection) {
          closeSession(1003, "non_json_before_route");
          return;
        }
        session.upstreamConnection.sendText(rawText);
        return;
      }

      if (message?.type !== "response.create") {
        if (!session.upstreamConnection) {
          closeSession(1008, "route_not_selected");
          return;
        }
        session.upstreamConnection.sendText(rawText);
        return;
      }

      const sequence = ++messageSequence;
      const plan = routePlan[sequence - 1] ?? { accountAlias: session.inputAlias };
      const primaryAlias = plan.accountAlias ?? session.inputAlias;
      session.activePlan = plan;

      if (unsafeAfterSemantic) {
        void logger.write({
          kind: "replay_blocked",
          message_sequence: sequence,
          reason: "semantic_stream_already_started",
        });
        closeSession(1011, "unsafe_to_replay");
        return;
      }

      const previousPresentBefore = Object.hasOwn(message, "previous_response_id");
      if (plan.omitPreviousResponseId === true) {
        delete message.previous_response_id;
      }
      const previousPresentAfter = Object.hasOwn(message, "previous_response_id");
      void logger.write({
        kind: "response_create_route",
        message_sequence: sequence,
        account_alias: primaryAlias,
        previous_response_id_present_before: previousPresentBefore,
        previous_response_id_present_after: previousPresentAfter,
      });

      if (plan.injectFailureBeforeSemantic === true) {
        const failedConnection = await openForAlias(primaryAlias);
        failedConnection.destroy();
        session.upstreamConnection = null;
        session.upstreamAlias = null;
        void logger.write({
          kind: "failure_injected",
          boundary: "before_first_semantic_event",
          account_alias: primaryAlias,
          replay_allowed: true,
        });
        const fallbackAlias = plan.fallbackAlias ?? primaryAlias;
        const fallbackConnection = await openForAlias(fallbackAlias);
        session.activePlan = { ...plan, accountAlias: fallbackAlias, injectFailureBeforeSemantic: false };
        fallbackConnection.sendText(JSON.stringify(message));
        return;
      }

      const connection = await openForAlias(primaryAlias);
      connection.sendText(plan.omitPreviousResponseId === true ? JSON.stringify(message) : rawText);
    }

    const textAssembler = createTextMessageAssembler((rawText) => {
      session.processing = session.processing
        .then(() => handleTextMessage(rawText))
        .catch(() => {
          void logger.write({ kind: "relay_operation_failed", category: "route_or_protocol" });
          closeSession(1011, "relay_operation_failed");
        });
    });
    const downstreamParser = createWebSocketFrameParser({
      expectMasked: true,
      onFrame(frame) {
        if (frame.opcode === 0x9) {
          downstream.write(
            encodeWebSocketFrame(frame.payload, { opcode: 0xa, masked: false }),
          );
          return;
        }
        if (frame.opcode === 0x8) {
          closeSession(1000, "client_closed");
          return;
        }
        textAssembler(frame);
      },
    });

    downstream.on("data", (chunk) => {
      try {
        downstreamParser.push(chunk);
      } catch {
        void logger.write({ kind: "relay_operation_failed", category: "downstream_frame" });
        closeSession(1002, "protocol_error");
      }
    });
    downstream.once("close", () => closeSession(1000, "client_closed"));
    downstream.once("error", () => closeSession(1011, "client_error"));
    if (head.length > 0) {
      downstreamParser.push(head);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("continuity relay did not expose a TCP address");
  }

  return {
    address: { host, port: address.port },
    identityStatus() {
      const left = identities.get("account-a");
      const right = identities.get("account-b");
      return {
        account_a_captured: Boolean(left),
        account_b_captured: Boolean(right),
        distinct:
          left && right
            ? left.authorization !== right.authorization ||
              left["chatgpt-account-id"] !== right["chatgpt-account-id"]
            : null,
      };
    },
    async flush() {
      await logger.flush();
    },
    async close() {
      for (const session of [...sessions]) {
        session.closed = true;
        session.upstreamGeneration += 1;
        session.upstreamConnection?.destroy();
        session.downstream.destroy();
        sessions.delete(session);
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await logger.flush();
    },
  };
}
