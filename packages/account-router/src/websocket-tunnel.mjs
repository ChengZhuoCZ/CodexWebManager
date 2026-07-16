import http from "node:http";
import https from "node:https";
import { pipeline, Transform } from "node:stream";
import { normalizeProxyRoute, ProxyRouteError } from "./proxy-routes.mjs";
import {
  buildUpstreamRequestHeaders,
  filterHttpResponseHeaders,
  filterWebSocketResponseHeaders,
  rawHttpResponse,
  resolveUpstreamConfiguration,
} from "./proxy-upstream.mjs";

function socketError(socket, statusCode, code, extraHeaders = {}) {
  if (socket.destroyed) {
    return;
  }
  const body = Buffer.from(`${JSON.stringify({ error: code })}\n`);
  socket.end(rawHttpResponse(statusCode, http.STATUS_CODES[statusCode], {
    "cache-control": "no-store",
    "connection": "close",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  }, body));
}

function validUpgradeHeaders(headers) {
  const upgrade = headers.upgrade;
  const key = headers["sec-websocket-key"];
  const version = headers["sec-websocket-version"];
  return (
    typeof upgrade === "string" &&
    upgrade.toLowerCase() === "websocket" &&
    typeof key === "string" &&
    /^[A-Za-z0-9+/]{16,64}={0,2}$/.test(key) &&
    version === "13"
  );
}

class BodyLimitError extends Error {}

function responseLimitTransform(limit) {
  let length = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      length += chunk.length;
      callback(length > limit ? new BodyLimitError() : null, chunk);
    },
  });
}

function abortSocket(socket) {
  if (!socket || socket.destroyed) return;
  try {
    if (typeof socket.resetAndDestroy === "function") {
      socket.resetAndDestroy();
      return;
    }
  } catch {
    // Fall through to the portable destroy path for non-TCP transports.
  }
  if (!socket.destroyed) {
    socket.destroy();
  }
}

export function createWebSocketTunnelHandler({
  resolveUpstream,
  upstreamHeadersTimeoutMs,
  requestTotalTimeoutMs,
  responseBodyLimitBytes,
}) {
  return (request, clientSocket, clientHead) => {
    let route;
    try {
      route = normalizeProxyRoute({
        method: request.method,
        rawTarget: request.url,
        transport: "websocket",
      });
      if (!validUpgradeHeaders(request.headers)) {
        socketError(clientSocket, 400, "invalid_websocket_upgrade");
        return;
      }
    } catch (error) {
      if (error instanceof ProxyRouteError) {
        socketError(clientSocket, error.statusCode, error.code, error.allowedMethods.length > 0
          ? { allow: error.allowedMethods.join(", ") }
          : {});
      } else {
        socketError(clientSocket, 400, "invalid_websocket_upgrade");
      }
      return;
    }

    void (async () => {
      let configuration;
      let released = false;
      let upstreamRequest;
      let upstreamSocket;
      let headersTimer;
      let totalTimer;
      let responseStarted = false;
      let terminal = false;
      const release = () => {
        if (!released) {
          released = true;
          try {
            configuration?.release?.();
          } catch {
            // Release failures are intentionally not exposed to the client.
          }
        }
      };
      const cleanup = () => {
        clearTimeout(headersTimer);
        clearTimeout(totalTimer);
        release();
      };
      const fail = (statusCode, code) => {
        if (terminal) return;
        terminal = true;
        abortSocket(upstreamSocket);
        upstreamRequest?.destroy();
        if (responseStarted) {
          clientSocket.destroy();
        } else {
          socketError(clientSocket, statusCode, code);
        }
        cleanup();
      };
      const closeTunnel = () => {
        if (terminal) return;
        terminal = true;
        abortSocket(upstreamSocket);
        upstreamRequest?.destroy();
        cleanup();
      };
      try {
        configuration = await resolveUpstreamConfiguration(resolveUpstream, route);
        if (clientSocket.destroyed) {
          release();
          return;
        }
        const headers = buildUpstreamRequestHeaders(request.headers, configuration.headers, {
          websocket: true,
        });
        const transport = configuration.origin.protocol === "https:" ? https : http;
        upstreamRequest = transport.request({
          protocol: configuration.origin.protocol,
          hostname: configuration.origin.hostname,
          port: configuration.origin.port || undefined,
          method: route.method,
          path: route.upstream_target,
          headers,
        });
        headersTimer = setTimeout(() => {
          fail(504, "upstream_headers_timeout");
        }, upstreamHeadersTimeoutMs);
        headersTimer.unref();
        totalTimer = setTimeout(() => {
          fail(504, "upstream_total_timeout");
        }, requestTotalTimeoutMs);
        totalTimer.unref();

        clientSocket.once("close", () => {
          closeTunnel();
        });
        clientSocket.once("end", () => {
          clientSocket.destroy();
          closeTunnel();
        });
        clientSocket.once("error", () => {
          closeTunnel();
        });
        upstreamRequest.once("upgrade", (upstreamResponse, socket, upstreamHead) => {
          if (terminal) {
            socket.destroy();
            return;
          }
          clearTimeout(headersTimer);
          responseStarted = true;
          upstreamSocket = socket;
          const responseHeaders = filterWebSocketResponseHeaders(upstreamResponse.headers);
          responseHeaders.connection = "Upgrade";
          responseHeaders.upgrade = "websocket";
          clientSocket.write(rawHttpResponse(101, "Switching Protocols", responseHeaders));
          if (upstreamHead.length > 0) {
            clientSocket.write(upstreamHead);
          }
          if (clientHead.length > 0) {
            socket.write(clientHead);
          }
          socket.once("close", () => {
            clientSocket.destroy();
            closeTunnel();
          });
          socket.once("end", () => {
            clientSocket.destroy();
            closeTunnel();
          });
          socket.once("error", () => {
            clientSocket.destroy();
            closeTunnel();
          });
          clientSocket.pipe(socket);
          socket.pipe(clientSocket);
        });
        upstreamRequest.once("response", (upstreamResponse) => {
          if (terminal) {
            upstreamResponse.destroy();
            return;
          }
          clearTimeout(headersTimer);
          const contentLength = Number(upstreamResponse.headers["content-length"] ?? 0);
          if (Number.isFinite(contentLength) && contentLength > responseBodyLimitBytes) {
            upstreamResponse.destroy();
            fail(502, "upstream_response_too_large");
            return;
          }
          responseStarted = true;
          const responseHeaders = filterHttpResponseHeaders(upstreamResponse.headers);
          responseHeaders.connection = "close";
          clientSocket.write(rawHttpResponse(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage,
            responseHeaders,
          ));
          pipeline(upstreamResponse, responseLimitTransform(responseBodyLimitBytes), clientSocket, (error) => {
            if (terminal) return;
            if (error) {
              fail(502, error instanceof BodyLimitError
                ? "upstream_response_too_large"
                : "upstream_stream_failed");
            } else {
              terminal = true;
              cleanup();
            }
          });
        });
        upstreamRequest.once("error", () => {
          fail(502, "upstream_connection_failed");
        });
        upstreamRequest.end();
      } catch {
        fail(502, "upstream_unavailable");
      }
    })();
  };
}
