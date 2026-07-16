import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { classifyResponseEvent } from "./semantic-events.mjs";
import {
  FailoverAttemptError,
  FailoverResultError,
  failoverErrorBody,
} from "./failover-state-machine.mjs";
import {
  buildUpstreamRequestHeaders,
  rawHttpResponse,
  resolveUpstreamConfiguration,
} from "./proxy-upstream.mjs";
import { normalizeProxyRoute, ProxyRouteError } from "./proxy-routes.mjs";
import {
  closeFramePayload,
  createTextMessageAssembler,
  createWebSocketFrameParser,
  encodeWebSocketFrame,
} from "./websocket-frames.mjs";

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function validUpgrade(headers) {
  const key = headers["sec-websocket-key"];
  const decodedKey = typeof key === "string" ? Buffer.from(key, "base64") : Buffer.alloc(0);
  return (
    typeof headers.upgrade === "string" &&
    headers.upgrade.toLowerCase() === "websocket" &&
    typeof key === "string" &&
    decodedKey.length === 16 &&
    decodedKey.toString("base64") === key &&
    headers["sec-websocket-version"] === "13" &&
    headers["sec-websocket-protocol"] === undefined
  );
}

function socketHttpError(socket, statusCode, code) {
  if (socket.destroyed) return;
  const body = Buffer.from(`${JSON.stringify({ error: code })}\n`);
  socket.end(rawHttpResponse(statusCode, http.STATUS_CODES[statusCode], {
    connection: "close",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
  }, body));
}

function abortSocket(socket) {
  if (!socket || socket.destroyed) return;
  try {
    if (typeof socket.resetAndDestroy === "function") {
      socket.resetAndDestroy();
      return;
    }
  } catch {
    // Fall back for transports which do not expose a resettable TCP handle.
  }
  if (!socket.destroyed) socket.destroy();
}

function failureFromMessage(message) {
  if (message?.type !== "error" && message?.type !== "response.failed") return null;
  const type = message?.error?.type ?? message?.response?.error?.type;
  if (type === "quota_exhausted" || type === "insufficient_quota") {
    return new FailoverAttemptError("quota_exhausted");
  }
  if (type === "rate_limit" || type === "rate_limited") {
    return new FailoverAttemptError("rate_limited");
  }
  if (type === "invalid_auth" || type === "authentication_error") {
    return new FailoverAttemptError("auth_expired");
  }
  return null;
}

function responseFailure(statusCode) {
  if (statusCode === 401 || statusCode === 403) return new FailoverAttemptError("auth_expired");
  if (statusCode === 429) return new FailoverAttemptError("rate_limited");
  if (statusCode >= 500 && statusCode <= 599) return new FailoverAttemptError("upstream_5xx");
  return new FailoverAttemptError("protocol_error");
}

function openManagedConnection({
  accountId,
  configuration,
  downstream,
  onClosed,
  request,
  route,
  upstreamHeadersTimeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const key = request.headers["sec-websocket-key"];
    const expectedAccept = websocketAccept(key);
    const headers = buildUpstreamRequestHeaders(request.headers, configuration.headers, {
      websocket: true,
    });
    const transport = configuration.origin.protocol === "https:" ? https : http;
    let settled = false;
    let managed = null;
    const upstreamRequest = transport.request({
      protocol: configuration.origin.protocol,
      hostname: configuration.origin.hostname,
      port: configuration.origin.port || undefined,
      method: route.method,
      path: route.upstream_target,
      headers,
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new FailoverAttemptError("network_error"));
      }
      upstreamRequest.destroy();
    }, upstreamHeadersTimeoutMs);

    upstreamRequest.once("response", (incoming) => {
      clearTimeout(timer);
      incoming.destroy();
      if (!settled) {
        settled = true;
        reject(responseFailure(incoming.statusCode ?? 502));
      }
    });
    upstreamRequest.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new FailoverAttemptError("network_error"));
      }
    });
    upstreamRequest.once("upgrade", (upgradeResponse, socket, head) => {
      clearTimeout(timer);
      if (
        settled ||
        upgradeResponse.headers["sec-websocket-accept"] !== expectedAccept ||
        upgradeResponse.headers["sec-websocket-extensions"] !== undefined ||
        upgradeResponse.headers["sec-websocket-protocol"] !== undefined
      ) {
        socket.destroy();
        if (!settled) {
          settled = true;
          reject(new FailoverAttemptError("protocol_error"));
        }
        return;
      }
      settled = true;
      let operation = null;
      let closed = false;
      let waitingForDownstreamDrain = false;
      let waitingForUpstreamDrain = false;
      const failOperation = (error) => {
        const active = operation;
        operation = null;
        active?.cleanup();
        active?.reject(error);
      };
      const forward = (bytes) => {
        if (downstream.destroyed) {
          failOperation(new FailoverAttemptError("client_cancelled"));
          abortSocket(socket);
          return;
        }
        if (!downstream.write(bytes) && !waitingForDownstreamDrain) {
          waitingForDownstreamDrain = true;
          socket.pause();
          downstream.once("drain", () => {
            waitingForDownstreamDrain = false;
            if (!closed && !downstream.destroyed) socket.resume();
          });
        }
      };
      const handleText = (payload) => {
        const encoded = encodeWebSocketFrame(payload, { masked: false, opcode: 0x1 });
        if (!operation) {
          forward(encoded);
          return;
        }
        let message = null;
        try { message = JSON.parse(payload.toString("utf8")); } catch {}
        const failure = failureFromMessage(message);
        if (failure) {
          failOperation(failure);
          abortSocket(socket);
          return;
        }
        const eventType = typeof message?.type === "string" ? message.type : null;
        const classification = classifyResponseEvent(eventType);
        if (classification === "preflight" && !operation.committed) {
          operation.preflightBytes += encoded.length;
          if (operation.preflightBytes > 2 * 1024 * 1024) {
            failOperation(new FailoverAttemptError("protocol_error"));
            abortSocket(socket);
            return;
          }
          operation.preflight.push(encoded);
          return;
        }
        operation.observeEvent(eventType);
        operation.committed = true;
        for (const buffered of operation.preflight) forward(buffered);
        operation.preflight.length = 0;
        forward(encoded);
        if (classification === "terminal") {
          const active = operation;
          operation = null;
          active.cleanup();
          active.resolve();
        }
      };
      const assembleText = createTextMessageAssembler({ onMessage: handleText });
      const parser = createWebSocketFrameParser({
        expectMasked: false,
        onFrame(frame) {
          if (frame.opcode === 0x9) {
            socket.write(encodeWebSocketFrame(frame.payload, { masked: true, opcode: 0xa }));
            return;
          }
          if (frame.opcode === 0x8) {
            failOperation(new FailoverAttemptError("network_error"));
            abortSocket(socket);
            return;
          }
          if (assembleText(frame)) return;
          const encoded = encodeWebSocketFrame(frame.payload, {
            final: frame.final,
            masked: false,
            opcode: frame.opcode,
          });
          if (operation) {
            operation.observeEvent(null);
            operation.committed = true;
            for (const buffered of operation.preflight) forward(buffered);
            operation.preflight.length = 0;
          }
          forward(encoded);
        },
      });

      managed = Object.freeze({
        accountId,
        get destroyed() { return closed || socket.destroyed; },
        destroy() { abortSocket(socket); },
        sendFrame(opcode, payload) {
          if (closed || socket.destroyed) throw new FailoverAttemptError("network_error");
          if (
            !socket.write(encodeWebSocketFrame(payload, { masked: true, opcode })) &&
            !waitingForUpstreamDrain
          ) {
            waitingForUpstreamDrain = true;
            downstream.pause();
            socket.once("drain", () => {
              waitingForUpstreamDrain = false;
              if (!closed && !downstream.destroyed) downstream.resume();
            });
          }
        },
        runResponse({ observeEvent, payload, signal }) {
          if (operation !== null) {
            return Promise.reject(new FailoverAttemptError("protocol_error"));
          }
          return new Promise((resolveOperation, rejectOperation) => {
            if (signal.aborted) {
              rejectOperation(new FailoverAttemptError("client_cancelled"));
              abortSocket(socket);
              return;
            }
            const onAbort = () => {
              failOperation(new FailoverAttemptError("client_cancelled"));
              abortSocket(socket);
            };
            const cleanup = () => signal.removeEventListener("abort", onAbort);
            operation = {
              cleanup,
              committed: false,
              observeEvent,
              preflight: [],
              preflightBytes: 0,
              reject: rejectOperation,
              resolve: resolveOperation,
            };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              managed.sendFrame(0x1, payload);
            } catch (error) {
              failOperation(error);
            }
          });
        },
      });

      socket.on("data", (chunk) => {
        try {
          parser.push(chunk);
        } catch {
          failOperation(new FailoverAttemptError("protocol_error"));
          abortSocket(socket);
        }
      });
      socket.once("error", () => {
        failOperation(new FailoverAttemptError("network_error"));
      });
      socket.once("end", () => {
        failOperation(new FailoverAttemptError("network_error"));
        abortSocket(socket);
      });
      socket.once("close", () => {
        closed = true;
        failOperation(new FailoverAttemptError("network_error"));
        onClosed(managed);
      });
      resolve(managed);
      if (head.length > 0) {
        queueMicrotask(() => {
          try { parser.push(head); } catch { abortSocket(socket); }
        });
      }
    });
    upstreamRequest.end();
  });
}

function errorMessage(error) {
  return Buffer.from(JSON.stringify({ type: "error", ...failoverErrorBody(error) }));
}

export function createWebSocketFailoverHandler({
  failoverStateMachine,
  onAttemptFailure,
  resolveUpstream,
  upstreamHeadersTimeoutMs,
}) {
  return (request, downstream, head) => {
    let route;
    try {
      route = normalizeProxyRoute({
        method: request.method,
        rawTarget: request.url,
        transport: "websocket",
      });
      if (!validUpgrade(request.headers)) throw new Error("invalid upgrade");
    } catch (error) {
      if (error instanceof ProxyRouteError) socketHttpError(downstream, error.statusCode, error.code);
      else socketHttpError(downstream, 400, "invalid_websocket_upgrade");
      return;
    }

    const accept = websocketAccept(request.headers["sec-websocket-key"]);
    downstream.write(rawHttpResponse(101, "Switching Protocols", {
      connection: "Upgrade",
      "sec-websocket-accept": accept,
      upgrade: "websocket",
    }));

    let closed = false;
    let current = null;
    let processing = Promise.resolve();
    const relayController = new AbortController();
    const closeRelay = (error = null) => {
      if (closed) return;
      closed = true;
      relayController.abort();
      current?.destroy();
      current = null;
      if (!downstream.destroyed) {
        if (error instanceof FailoverResultError) {
          downstream.write(encodeWebSocketFrame(errorMessage(error), { opcode: 0x1 }));
          const code = error.code === "all_accounts_unavailable" ? 1013 : 1011;
          downstream.end(encodeWebSocketFrame(
            closeFramePayload(code, error.code),
            { opcode: 0x8 },
          ));
        } else {
          downstream.end(encodeWebSocketFrame(
            closeFramePayload(1011, "protocol_error"),
            { opcode: 0x8 },
          ));
        }
      }
    };

    const handleResponseCreate = async (payload, message) => {
      const policy = Object.hasOwn(message, "previous_response_id")
        ? "continuation_request"
        : "initial_request";
      if (policy === "continuation_request" && (current === null || current.destroyed)) {
        closeRelay(new FailoverResultError("unsafe_to_replay", {
          reason: "continuation_connection_not_portable",
          attempts: 0,
          semanticOutput: false,
        }));
        return;
      }
      try {
        await failoverStateMachine.execute({
          replayPolicy: policy,
          signal: relayController.signal,
          async selectAccount(selectionContext) {
            if (
              policy === "continuation_request" &&
              current !== null &&
              !current.destroyed &&
              selectionContext.excludeAccountIds.length === 0
            ) {
              return { accountId: current.accountId, existing: true };
            }
            const configuration = await resolveUpstreamConfiguration(
              resolveUpstream,
              route,
              selectionContext,
            );
            if (configuration === null) return null;
            if (configuration.accountId === null) {
              try { configuration.release?.(); } catch {}
              throw new Error("failover upstream requires accountId");
            }
            return {
              accountId: configuration.accountId,
              configuration,
              release: configuration.release,
            };
          },
          async attempt({ accountId, observeEvent, selection, signal }) {
            let connection = selection.existing === true ? current : null;
            if (connection === null || connection.destroyed || connection.accountId !== accountId) {
              current?.destroy();
              connection = await openManagedConnection({
                accountId,
                configuration: selection.configuration,
                downstream,
                onClosed(closedConnection) {
                  if (current === closedConnection) current = null;
                },
                request,
                route,
                upstreamHeadersTimeoutMs,
              });
              current = connection;
            }
            try {
              await connection.runResponse({ observeEvent, payload, signal });
            } catch (error) {
              if (current === connection) current = null;
              connection.destroy();
              throw error;
            }
          },
          onAttemptFailure,
        });
      } catch (error) {
        closeRelay(error instanceof FailoverResultError ? error : new FailoverResultError(
          "protocol_error",
          { reason: "relay_operation_failed", attempts: 0, semanticOutput: false },
        ));
      }
    };

    const handleText = async (payload) => {
      let message;
      try { message = JSON.parse(payload.toString("utf8")); } catch {
        if (!current || current.destroyed) throw new Error("route unavailable");
        current.sendFrame(0x1, payload);
        return;
      }
      if (message?.type === "response.create") {
        await handleResponseCreate(payload, message);
        return;
      }
      if (!current || current.destroyed) throw new Error("route unavailable");
      current.sendFrame(0x1, payload);
    };

    const assembleText = createTextMessageAssembler({
      onMessage(payload) {
        processing = processing.then(() => handleText(payload)).catch(() => closeRelay());
      },
    });
    const parser = createWebSocketFrameParser({
      expectMasked: true,
      onFrame(frame) {
        if (frame.opcode === 0x9) {
          downstream.write(encodeWebSocketFrame(frame.payload, { opcode: 0xa }));
          return;
        }
        if (frame.opcode === 0x8) {
          closed = true;
          relayController.abort();
          current?.destroy();
          downstream.end(encodeWebSocketFrame(frame.payload, { opcode: 0x8 }));
          return;
        }
        if (assembleText(frame)) return;
        if (!current || current.destroyed) {
          closeRelay();
          return;
        }
        try {
          current.sendFrame(frame.opcode, frame.payload);
        } catch {
          closeRelay();
        }
      },
    });
    downstream.on("data", (chunk) => {
      try { parser.push(chunk); } catch { closeRelay(); }
    });
    downstream.once("error", () => {
      closed = true;
      relayController.abort();
      current?.destroy();
    });
    downstream.once("end", () => {
      closed = true;
      relayController.abort();
      current?.destroy();
      downstream.destroy();
    });
    downstream.once("close", () => {
      closed = true;
      relayController.abort();
      current?.destroy();
    });
    if (head.length > 0) {
      try { parser.push(head); } catch { closeRelay(); }
    }
  };
}
