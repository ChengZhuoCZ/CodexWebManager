import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AuxiliaryEndpointError,
  getAuxiliaryEndpointPolicy,
  validateAuxiliaryRequest,
  validateAuxiliaryResponse,
} from "./auxiliary-endpoints.mjs";
import { sendJson } from "./http-handler.mjs";
import { createFailoverHttpHandler } from "./failover-http-handler.mjs";
import { createModelCatalogCache } from "./model-catalog-cache.mjs";
import { normalizeProxyRoute, ProxyRouteError } from "./proxy-routes.mjs";
import {
  buildUpstreamRequestHeaders,
  filterHttpResponseHeaders,
  resolveUpstreamConfiguration,
} from "./proxy-upstream.mjs";
import { createWebSocketTunnelHandler } from "./websocket-tunnel.mjs";
import { createWebSocketFailoverHandler } from "./websocket-failover-relay.mjs";

class BodyLimitError extends Error {}

function integerOption(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function parseContentLength(headers, limit) {
  const raw = headers["content-length"];
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new Error("invalid_content_length");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("invalid_content_length");
  }
  if (value > limit) {
    throw new BodyLimitError();
  }
  return value;
}

function forwardRequestBody(request, upstreamRequest, limit) {
  return new Promise((resolve, reject) => {
    let length = 0;
    let waitingForDrain = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      upstreamRequest.off("drain", onDrain);
      upstreamRequest.off("error", onUpstreamError);
    };
    const fail = (error) => {
      cleanup();
      request.resume();
      reject(error);
    };
    const onDrain = () => {
      waitingForDrain = false;
      request.resume();
    };
    const onData = (chunk) => {
      length += chunk.length;
      if (length > limit) {
        fail(new BodyLimitError());
        return;
      }
      if (!upstreamRequest.write(chunk)) {
        waitingForDrain = true;
        request.pause();
        upstreamRequest.once("drain", onDrain);
      }
    };
    const onEnd = () => {
      cleanup();
      upstreamRequest.end();
      resolve(length);
    };
    const onAborted = () => fail(new Error("client_aborted"));
    const onError = () => fail(new Error("client_error"));
    const onUpstreamError = () => {
      if (waitingForDrain) {
        request.resume();
      }
      fail(new Error("upstream_error"));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    upstreamRequest.once("error", onUpstreamError);
    request.resume();
  });
}

async function readBoundedBody(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new BodyLimitError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function responseLimitTransform(limit, onLimit) {
  let length = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      length += chunk.length;
      if (length > limit) {
        onLimit();
        callback(new BodyLimitError());
        return;
      }
      callback(null, chunk);
    },
  });
}

function isSse(headers) {
  const contentType = headers["content-type"];
  return typeof contentType === "string" && /^text\/event-stream(?:;|$)/i.test(contentType);
}

export function createProxyHandler({
  resolveUpstream,
  requestBodyLimitBytes = 50 * 1024 * 1024,
  responseBodyLimitBytes = 64 * 1024 * 1024,
  upstreamHeadersTimeoutMs = 90_000,
  requestTotalTimeoutMs = 15 * 60_000,
  failoverStateMachine = null,
  modelCatalogCache = undefined,
  onAttemptFailure = async () => undefined,
  onSemanticStreamEnd = () => undefined,
  onSemanticStreamStart = () => undefined,
  onWeeklyQuotaObservation = () => undefined,
  quotaNow = () => Date.now(),
} = {}) {
  if (typeof resolveUpstream !== "function") {
    throw new TypeError("resolveUpstream must be a function");
  }
  integerOption(requestBodyLimitBytes, "requestBodyLimitBytes", 1, 1024 * 1024 * 1024);
  integerOption(responseBodyLimitBytes, "responseBodyLimitBytes", 1, 1024 * 1024 * 1024);
  integerOption(upstreamHeadersTimeoutMs, "upstreamHeadersTimeoutMs", 1, 15 * 60_000);
  integerOption(requestTotalTimeoutMs, "requestTotalTimeoutMs", 1, 60 * 60_000);
  if (requestTotalTimeoutMs < upstreamHeadersTimeoutMs) {
    throw new Error("requestTotalTimeoutMs must be at least upstreamHeadersTimeoutMs");
  }
  if (failoverStateMachine !== null && typeof failoverStateMachine?.execute !== "function") {
    throw new TypeError("failoverStateMachine must provide execute or be null");
  }
  if (typeof onAttemptFailure !== "function") {
    throw new TypeError("onAttemptFailure must be a function");
  }
  if (typeof onSemanticStreamStart !== "function") {
    throw new TypeError("onSemanticStreamStart must be a function");
  }
  if (typeof onSemanticStreamEnd !== "function") {
    throw new TypeError("onSemanticStreamEnd must be a function");
  }
  if (typeof onWeeklyQuotaObservation !== "function") {
    throw new TypeError("onWeeklyQuotaObservation must be a function");
  }
  if (typeof quotaNow !== "function") {
    throw new TypeError("quotaNow must be a function");
  }
  const catalogCache = modelCatalogCache === undefined
    ? createModelCatalogCache({
        maxBodyBytes: Math.min(responseBodyLimitBytes, 2 * 1024 * 1024),
      })
    : modelCatalogCache;
  if (
    catalogCache !== null &&
    (
      typeof catalogCache !== "object" ||
      typeof catalogCache.read !== "function" ||
      typeof catalogCache.write !== "function"
    )
  ) {
    throw new TypeError("modelCatalogCache must provide read/write or be null");
  }

  const failoverHttpHandler = failoverStateMachine === null
    ? null
    : createFailoverHttpHandler({
        failoverStateMachine,
        modelCatalogCache: catalogCache,
        onAttemptFailure,
        onSemanticStreamEnd,
        onSemanticStreamStart,
        onWeeklyQuotaObservation,
        quotaNow,
        requestBodyLimitBytes,
        resolveUpstream,
        responseBodyLimitBytes,
        upstreamHeadersTimeoutMs,
      });

  const handleUpgrade = failoverStateMachine === null
    ? createWebSocketTunnelHandler({
        resolveUpstream,
        upstreamHeadersTimeoutMs,
        requestTotalTimeoutMs,
        responseBodyLimitBytes,
      })
    : createWebSocketFailoverHandler({
        failoverStateMachine,
        onAttemptFailure,
        onSemanticStreamEnd,
        onSemanticStreamStart,
        onWeeklyQuotaObservation,
        quotaNow,
        resolveUpstream,
        upstreamHeadersTimeoutMs,
      });

  const handleHttpAsync = async (request, response) => {
    let route;
    try {
      route = normalizeProxyRoute({ method: request.method, rawTarget: request.url });
    } catch (error) {
      if (error instanceof ProxyRouteError) {
        const headers = error.allowedMethods.length > 0
          ? { allow: error.allowedMethods.join(", ") }
          : {};
        sendJson(request, response, error.statusCode, error.toJSON(), headers);
      } else {
        sendJson(request, response, 400, { error: "invalid_request" });
      }
      request.resume();
      return;
    }

    let contentLength;
    try {
      contentLength = parseContentLength(request.headers, requestBodyLimitBytes);
    } catch (error) {
      request.resume();
      sendJson(
        request,
        response,
        error instanceof BodyLimitError ? 413 : 400,
        { error: error instanceof BodyLimitError ? "request_body_too_large" : "invalid_content_length" },
        { connection: "close" },
      );
      return;
    }

    const auxiliaryPolicy = getAuxiliaryEndpointPolicy(route);
    let auxiliaryBody = null;
    if (auxiliaryPolicy !== null) {
      try {
        auxiliaryBody = await readBoundedBody(request, requestBodyLimitBytes);
        validateAuxiliaryRequest(route, request.headers, auxiliaryBody);
      } catch (error) {
        if (error instanceof AuxiliaryEndpointError) {
          sendJson(request, response, error.statusCode, { error: error.code });
        } else if (error instanceof BodyLimitError) {
          sendJson(
            request,
            response,
            413,
            { error: "request_body_too_large" },
            { connection: "close" },
          );
        } else if (!response.destroyed) {
          response.destroy();
        }
        return;
      }
    }

    if (failoverHttpHandler !== null) {
      await failoverHttpHandler({
        request,
        response,
        route,
        contentLength,
        body: auxiliaryBody,
      });
      return;
    }

    let configuration;
    try {
      configuration = await resolveUpstreamConfiguration(resolveUpstream, route);
    } catch {
      request.resume();
      sendJson(request, response, 502, { error: "upstream_unavailable" });
      return;
    }
    if (request.aborted || response.destroyed) {
      try { configuration.release?.(); } catch {}
      return;
    }

    let released = false;
    let finished = false;
    let upstreamResponse = null;
    let bodyFailure = null;
    let responseFailure = null;
    let headersTimer;
    let totalTimer;
    const release = () => {
      if (!released) {
        released = true;
        try { configuration.release?.(); } catch {}
      }
    };
    let upstreamRequest;
    try {
      const headers = buildUpstreamRequestHeaders(request.headers, configuration.headers, {
        contentLength: auxiliaryBody === null
          ? contentLength
          : route.method === "GET" ? null : auxiliaryBody.length,
        route,
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
    } catch {
      release();
      request.resume();
      sendJson(request, response, 502, { error: "upstream_unavailable" });
      return;
    }

    const cleanup = () => {
      clearTimeout(headersTimer);
      clearTimeout(totalTimer);
      release();
    };
    const fail = (statusCode, code) => {
      if (finished) return;
      finished = true;
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
      cleanup();
      if (request.aborted || response.destroyed) return;
      if (!response.headersSent) {
        sendJson(request, response, statusCode, { error: code }, { connection: "close" });
      } else {
        response.destroy();
      }
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
      cleanup();
    };

    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableFinished) cancel();
    });
    headersTimer = setTimeout(() => fail(504, "upstream_headers_timeout"), upstreamHeadersTimeoutMs);
    headersTimer.unref();
    totalTimer = setTimeout(() => fail(504, "upstream_total_timeout"), requestTotalTimeoutMs);
    totalTimer.unref();

    upstreamRequest.once("response", (incoming) => {
      clearTimeout(headersTimer);
      upstreamResponse = incoming;
      const streamingSse = isSse(incoming.headers);
      const declared = incoming.headers["content-length"];
      if (!streamingSse && typeof declared === "string") {
        const declaredLength = Number(declared);
        if (Number.isFinite(declaredLength) && declaredLength > responseBodyLimitBytes) {
          fail(502, "upstream_response_too_large");
          return;
        }
      }
      const statusCode = incoming.statusCode;
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        fail(502, "invalid_upstream_response");
        return;
      }
      if (auxiliaryPolicy !== null) {
        void readBoundedBody(incoming, responseBodyLimitBytes).then((body) => {
          try {
            validateAuxiliaryResponse(route, statusCode, incoming.headers, body);
          } catch (error) {
            fail(
              502,
              error instanceof AuxiliaryEndpointError
                ? error.code
                : "invalid_auxiliary_response",
            );
            return;
          }
          if (finished || request.aborted || response.destroyed) {
            cancel();
            return;
          }
          response.writeHead(statusCode, filterHttpResponseHeaders(incoming.headers));
          response.end(body, () => {
            if (!finished) {
              finished = true;
              cleanup();
            }
          });
        }).catch((error) => {
          fail(
            502,
            error instanceof BodyLimitError
              ? "upstream_response_too_large"
              : "upstream_stream_failed",
          );
        });
        return;
      }
      response.writeHead(statusCode, filterHttpResponseHeaders(incoming.headers));
      const streams = [incoming];
      if (!streamingSse) {
        streams.push(responseLimitTransform(responseBodyLimitBytes, () => {
          responseFailure = "upstream_response_too_large";
        }));
      }
      streams.push(response);
      void pipeline(...streams).then(() => {
        if (!finished) {
          finished = true;
          cleanup();
        }
      }).catch(() => {
        if (responseFailure) {
          fail(502, responseFailure);
        } else if (!request.aborted && !response.destroyed) {
          fail(502, "upstream_stream_failed");
        } else {
          cancel();
        }
      });
    });
    upstreamRequest.on("error", () => {
      if (bodyFailure === "request_body_too_large") {
        fail(413, bodyFailure);
      } else if (!request.aborted) {
        fail(502, "upstream_connection_failed");
      }
    });

    if (auxiliaryBody !== null) {
      upstreamRequest.end(auxiliaryBody);
    } else {
      void forwardRequestBody(request, upstreamRequest, requestBodyLimitBytes).catch((error) => {
        if (error instanceof BodyLimitError) {
          bodyFailure = "request_body_too_large";
          fail(413, bodyFailure);
        } else if (error.message !== "client_aborted") {
          fail(502, "request_forward_failed");
        }
      });
    }
  };

  return Object.freeze({
    handleHttp(request, response) {
      void handleHttpAsync(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed) {
          sendJson(request, response, 500, { error: "internal_proxy_error" });
        } else if (!response.destroyed) {
          response.destroy();
        }
      });
    },
    handleUpgrade,
  });
}
