import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import tls from "node:tls";
import {
  describeHeaders,
  describeJsonBody,
  describeJsonShape,
  describeUrl,
  sanitizeEventType,
} from "./shape.mjs";

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

class JsonlLogger {
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

function validateUpstreamOrigin(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("UPSTREAM_ORIGIN must use http or https");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("UPSTREAM_ORIGIN must be an origin without credentials, path, query, or fragment");
  }
  return url;
}

function filterForwardHeaders(headers, targetHost) {
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

async function readRequestBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("request body exceeds observation limit");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createSseShapeParser(onEventType) {
  const decoder = new StringDecoder("utf8");
  let textBuffer = "";
  let eventName = null;
  let dataLines = [];

  function flushEvent() {
    if (eventName === null && dataLines.length === 0) {
      return;
    }

    let eventType = eventName;
    if (dataLines.length > 0) {
      try {
        const payload = JSON.parse(dataLines.join("\n"));
        if (typeof payload?.type === "string") {
          eventType = payload.type;
        }
      } catch {
        // Payload contents are deliberately discarded when they are not JSON.
      }
    }

    onEventType(sanitizeEventType(eventType));
    eventName = null;
    dataLines = [];
  }

  function processLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  return {
    push(chunk) {
      textBuffer += decoder.write(chunk);
      let newlineIndex = textBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        processLine(textBuffer.slice(0, newlineIndex));
        textBuffer = textBuffer.slice(newlineIndex + 1);
        newlineIndex = textBuffer.indexOf("\n");
      }
    },
    end() {
      textBuffer += decoder.end();
      if (textBuffer.length > 0) {
        processLine(textBuffer);
      }
      flushEvent();
    },
  };
}

function createWebSocketShapeParser(onJsonMessage) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentedOpcode = null;

  function deliver(opcode, payload) {
    if (opcode !== 0x1) {
      return;
    }
    try {
      onJsonMessage(JSON.parse(payload.toString("utf8")));
    } catch {
      // Non-JSON text is forwarded but deliberately not persisted.
    }
  }

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let payloadLength = second & 0x7f;
        let offset = 2;

        if (payloadLength === 126) {
          if (buffer.length < 4) {
            return;
          }
          payloadLength = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (buffer.length < 10) {
            return;
          }
          const bigLength = buffer.readBigUInt64BE(2);
          if (bigLength > BigInt(16 * 1024 * 1024)) {
            fragments = [];
            fragmentedOpcode = null;
            return;
          }
          payloadLength = Number(bigLength);
          offset = 10;
        }

        const maskLength = masked ? 4 : 0;
        const frameLength = offset + maskLength + payloadLength;
        if (buffer.length < frameLength) {
          return;
        }

        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payloadStart = offset + maskLength;
        const payload = Buffer.from(buffer.subarray(payloadStart, frameLength));
        buffer = buffer.subarray(frameLength);

        if (mask) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }

        if (opcode === 0x1 || opcode === 0x2) {
          if (final) {
            deliver(opcode, payload);
          } else {
            fragmentedOpcode = opcode;
            fragments = [payload];
          }
        } else if (opcode === 0x0 && fragmentedOpcode !== null) {
          fragments.push(payload);
          if (final) {
            deliver(fragmentedOpcode, Buffer.concat(fragments));
            fragments = [];
            fragmentedOpcode = null;
          }
        }
      }
    },
  };
}

function parseHttpHeaderBlock(block) {
  const lines = block.toString("latin1").split("\r\n");
  const statusLine = lines.shift() ?? "HTTP/1.1 502 Bad Gateway";
  const headers = {};
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "502", 10);
  return { statusLine, status: Number.isInteger(status) ? status : 502, headers };
}

function serializeUpgradeRequest(request, target) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (
      name === "host" ||
      name === "proxy-authorization" ||
      name === "sec-websocket-extensions" ||
      rawValue === undefined
    ) {
      continue;
    }
    headers[name] = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
  }
  headers.host = target.host;
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";

  const requestLine = `${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`;
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return Buffer.from(`${requestLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`, "latin1");
}

function serializeUpgradeResponse(statusLine, headers) {
  const headerLines = Object.entries(headers)
    .filter(([name]) => name !== "sec-websocket-extensions")
    .map(([name, value]) => `${name}: ${value}`);
  return Buffer.from(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`, "latin1");
}

export async function createObserver({
  upstreamOrigin,
  logPath,
  host = "127.0.0.1",
  port = 0,
  maxBodyBytes = 10 * 1024 * 1024,
}) {
  if (host !== "127.0.0.1") {
    throw new Error("protocol observer must bind to 127.0.0.1");
  }
  if (!logPath) {
    throw new Error("logPath is required");
  }

  const upstream = validateUpstreamOrigin(upstreamOrigin);
  const logger = new JsonlLogger(logPath);
  let requestSequence = 0;
  const activeSockets = new Set();

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "", { mode: 0o600 });

  const server = http.createServer(async (request, response) => {
    const observationId = `obs-${String(++requestSequence).padStart(6, "0")}`;

    let body;
    try {
      body = await readRequestBody(request, maxBodyBytes);
    } catch (error) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
      await logger.write({ kind: "request_rejected", observation_id: observationId, status });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "request_rejected" }));
      return;
    }

    const requestUrl = describeUrl(request.url ?? "/");
    await logger.write({
      kind: "request_shape",
      observation_id: observationId,
      method: request.method ?? "GET",
      ...requestUrl,
      headers: describeHeaders(request.headers),
      body: describeJsonBody(body, request.headers["content-type"]),
    });

    const target = new URL(request.url ?? "/", upstream);
    const transport = target.protocol === "https:" ? https : http;
    const upstreamRequest = transport.request(
      target,
      {
        method: request.method,
        headers: filterForwardHeaders(request.headers, target.host),
      },
      (upstreamResponse) => {
        const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
        const contentType = upstreamResponse.headers["content-type"];
        void logger.write({
          kind: "response_shape",
          observation_id: observationId,
          status: upstreamResponse.statusCode ?? 502,
          headers: describeHeaders(upstreamResponse.headers),
        });

        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        const isSse = contentType?.toLowerCase().includes("text/event-stream");
        const sseParser = isSse
          ? createSseShapeParser((eventType) => {
              void logger.write({
                kind: "sse_event",
                observation_id: observationId,
                event_type: eventType,
              });
            })
          : null;

        upstreamResponse.on("data", (chunk) => {
          sseParser?.push(chunk);
          response.write(chunk);
        });
        upstreamResponse.on("end", () => {
          sseParser?.end();
          response.end();
        });
        upstreamResponse.on("error", () => {
          response.destroy();
        });
      },
    );

    upstreamRequest.on("error", (error) => {
      void logger.write({
        kind: "upstream_error",
        observation_id: observationId,
        error_code: typeof error.code === "string" ? error.code : "UNKNOWN",
      });
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: "upstream_unavailable" }));
    });

    request.on("aborted", () => upstreamRequest.destroy());
    if (body.length > 0) {
      upstreamRequest.write(body);
    }
    upstreamRequest.end();
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

  server.on("upgrade", async (request, clientSocket, head) => {
    const observationId = `obs-${String(++requestSequence).padStart(6, "0")}`;
    const requestUrl = describeUrl(request.url ?? "/");
    await logger.write({
      kind: "websocket_upgrade_request",
      observation_id: observationId,
      method: request.method ?? "GET",
      ...requestUrl,
      headers: describeHeaders(request.headers),
    });

    const target = new URL(request.url ?? "/", upstream);
    const upstreamSocket =
      target.protocol === "https:"
        ? tls.connect({
            host: target.hostname,
            port: Number.parseInt(target.port || "443", 10),
            servername: target.hostname,
          })
        : net.connect({
            host: target.hostname,
            port: Number.parseInt(target.port || "80", 10),
          });

    let handshakeComplete = false;
    let upstreamBuffer = Buffer.alloc(0);
    const queuedClientFrames = [];
    const clientParser = createWebSocketShapeParser((message) => {
      void logger.write({
        kind: "websocket_message_shape",
        observation_id: observationId,
        direction: "client_to_upstream",
        message_type: sanitizeEventType(message?.type),
        body: { encoding: "json", valid: true, fields: describeJsonShape(message) },
      });
    });
    const upstreamParser = createWebSocketShapeParser((message) => {
      void logger.write({
        kind: "websocket_event",
        observation_id: observationId,
        event_type: sanitizeEventType(message?.type),
      });
    });

    const forwardClientFrame = (chunk) => {
      clientParser.push(chunk);
      if (handshakeComplete) {
        upstreamSocket.write(chunk);
      } else {
        queuedClientFrames.push(Buffer.from(chunk));
      }
    };
    clientSocket.on("data", forwardClientFrame);
    if (head.length > 0) {
      forwardClientFrame(head);
    }

    const failUpgrade = (errorCode) => {
      void logger.write({
        kind: "upstream_error",
        observation_id: observationId,
        error_code: errorCode,
      });
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    };

    upstreamSocket.once("connect", () => {
      upstreamSocket.write(serializeUpgradeRequest(request, target));
    });
    upstreamSocket.once("error", (error) => {
      failUpgrade(typeof error.code === "string" ? error.code : "UNKNOWN");
    });
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => clientSocket.destroy());

    const receiveHandshake = (chunk) => {
      upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
      const boundary = upstreamBuffer.indexOf("\r\n\r\n");
      if (boundary === -1) {
        return;
      }

      upstreamSocket.off("data", receiveHandshake);
      const headerBlock = upstreamBuffer.subarray(0, boundary + 4);
      const remainder = upstreamBuffer.subarray(boundary + 4);
      const parsed = parseHttpHeaderBlock(headerBlock);
      void logger.write({
        kind: "websocket_upgrade_response",
        observation_id: observationId,
        status: parsed.status,
        headers: describeHeaders(parsed.headers),
      });
      clientSocket.write(serializeUpgradeResponse(parsed.statusLine, parsed.headers));

      if (parsed.status !== 101) {
        if (remainder.length > 0) {
          clientSocket.write(remainder);
        }
        upstreamSocket.pipe(clientSocket);
        return;
      }

      handshakeComplete = true;
      for (const queued of queuedClientFrames.splice(0)) {
        upstreamSocket.write(queued);
      }
      upstreamSocket.on("data", (frame) => {
        upstreamParser.push(frame);
        clientSocket.write(frame);
      });
      if (remainder.length > 0) {
        upstreamParser.push(remainder);
        clientSocket.write(remainder);
      }
    };
    upstreamSocket.on("data", receiveHandshake);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  return {
    address: typeof address === "object" && address ? address : null,
    flush: () => logger.flush(),
    close: async () => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await logger.flush();
    },
  };
}
