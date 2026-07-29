import http from "node:http";
import https from "node:https";
import {
  AuxiliaryEndpointError,
  validateAuxiliaryResponse,
} from "./auxiliary-endpoints.mjs";
import { sendJson } from "./http-handler.mjs";
import {
  FailoverAttemptError,
  FailoverResultError,
  failoverErrorBody,
} from "./failover-state-machine.mjs";
import {
  buildUpstreamRequestHeaders,
  filterHttpResponseHeaders,
  resolveUpstreamConfiguration,
} from "./proxy-upstream.mjs";
import { createSseSemanticGate, SseLimitError } from "./sse-semantic-gate.mjs";
import {
  parseRateLimitSseEvent,
  weeklyQuotaObservationFromEvent,
} from "./weekly-quota-tracker.mjs";

class RequestBodyLimitError extends Error {}
class ResponseBodyLimitError extends Error {}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readRequestBody(request, limit) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > limit) throw new RequestBodyLimitError();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RequestBodyLimitError) throw error;
    throw new FailoverResultError("client_cancelled", {
      reason: "client_cancelled",
      attempts: 0,
      semanticOutput: false,
    });
  }
  return Buffer.concat(chunks, length);
}

function replayPolicy(route, headers, body) {
  if (route.method === "GET") return "initial_request";
  if (
    !new Set([
      "responses_http",
      "responses_compact",
      "codex_responses_http",
    ]).has(route.route_id)
  ) {
    return "never";
  }
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:;|$)/i.test(contentType)) {
    return "never";
  }
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!isPlainObject(parsed)) return "never";
    return Object.hasOwn(parsed, "previous_response_id")
      ? "continuation_request"
      : "initial_request";
  } catch {
    return "never";
  }
}

function isSse(headers) {
  const contentType = headers["content-type"];
  return typeof contentType === "string" && /^text\/event-stream(?:;|$)/i.test(contentType);
}

async function readBounded(incoming, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > limit) throw new ResponseBodyLimitError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function retryAfterMilliseconds(value) {
  if (typeof value !== "string") return null;
  if (/^(?:0|[1-9][0-9]{0,8})$/.test(value)) {
    return Math.min(Number(value) * 1_000, 30 * 24 * 60 * 60_000);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(0, parsed - Date.now()), 30 * 24 * 60 * 60_000);
}

function quotaFailureKind(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed?.error?.type === "quota_exhausted" ? "quota_exhausted" : "rate_limited";
  } catch {
    return "rate_limited";
  }
}

async function classifyRetryableResponse(incoming, responseBodyLimitBytes) {
  const statusCode = incoming.statusCode ?? 502;
  if (statusCode === 401 || statusCode === 403) {
    incoming.destroy();
    throw new FailoverAttemptError("auth_expired");
  }
  if (statusCode === 429) {
    let body;
    try {
      body = await readBounded(incoming, Math.min(responseBodyLimitBytes, 64 * 1024));
    } catch {
      incoming.destroy();
      throw new FailoverAttemptError("protocol_error");
    }
    const kind = quotaFailureKind(body);
    throw new FailoverAttemptError(kind, {
      retryAfterMs: kind === "rate_limited"
        ? retryAfterMilliseconds(incoming.headers["retry-after"])
        : null,
    });
  }
  if (statusCode >= 500 && statusCode <= 599) {
    incoming.destroy();
    throw new FailoverAttemptError("upstream_5xx");
  }
}

async function writeChunk(response, chunk) {
  if (response.destroyed) throw new FailoverAttemptError("client_cancelled");
  if (response.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new FailoverAttemptError("client_cancelled")); };
    const onError = () => { cleanup(); reject(new FailoverAttemptError("client_cancelled")); };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function endResponse(response, body = null) {
  if (response.destroyed) throw new FailoverAttemptError("client_cancelled");
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("finish", onFinish);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new FailoverAttemptError("client_cancelled")); };
    const onError = () => { cleanup(); reject(new FailoverAttemptError("client_cancelled")); };
    response.once("finish", onFinish);
    response.once("close", onClose);
    response.once("error", onError);
    response.end(body);
  });
}

async function sendBufferedResponse(incoming, response, body, observeEvent, route) {
  const statusCode = incoming.statusCode;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new FailoverAttemptError("protocol_error");
  }
  try {
    validateAuxiliaryResponse(route, statusCode, incoming.headers, body);
  } catch (error) {
    if (error instanceof AuxiliaryEndpointError) {
      throw new FailoverAttemptError("protocol_error");
    }
    throw error;
  }
  observeEvent("response.completed");
  response.writeHead(statusCode, filterHttpResponseHeaders(incoming.headers));
  await endResponse(response, body);
}

function publishWeeklyQuota({
  accountId,
  bytes,
  onWeeklyQuotaObservation,
  quotaNow,
}) {
  try {
    const event = parseRateLimitSseEvent(bytes);
    if (event === null) return;
    const observation = weeklyQuotaObservationFromEvent(event, { now: quotaNow });
    if (observation === null) return;
    const result = onWeeklyQuotaObservation(Object.freeze({ accountId, observation }));
    if (result && typeof result.then === "function") {
      void result.catch(() => undefined);
    }
  } catch {
    // Quota telemetry must never interfere with the model response.
  }
}

async function relaySse({
  accountId,
  incoming,
  onWeeklyQuotaObservation,
  quotaNow,
  response,
  observeEvent,
  responseBodyLimitBytes,
}) {
  const statusCode = incoming.statusCode;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new FailoverAttemptError("protocol_error");
  }
  const gate = createSseSemanticGate({
    maxEventBytes: Math.min(responseBodyLimitBytes, 16 * 1024 * 1024),
    maxPreflightBytes: Math.min(responseBodyLimitBytes, 16 * 1024 * 1024),
  });
  const headers = filterHttpResponseHeaders(incoming.headers);
  delete headers["content-length"];
  const preflight = [];
  let started = false;
  let terminal = false;
  try {
    for await (const chunk of incoming) {
      for (const event of gate.push(chunk)) {
        publishWeeklyQuota({
          accountId,
          bytes: event.bytes,
          onWeeklyQuotaObservation,
          quotaNow,
        });
        if (event.classification === "preflight" && !started) {
          preflight.push(event.bytes);
          continue;
        }
        if (event.eventType !== null || event.classification !== "preflight") {
          observeEvent(event.eventType);
        }
        if (!started) {
          response.writeHead(statusCode, headers);
          started = true;
          for (const buffered of preflight) await writeChunk(response, buffered);
          preflight.length = 0;
        }
        await writeChunk(response, event.bytes);
        if (event.terminal) terminal = true;
      }
    }
    gate.finish();
  } catch (error) {
    if (terminal) {
      await endResponse(response);
      return;
    }
    if (error instanceof SseLimitError && error.code !== "sse_truncated_event") {
      throw new FailoverAttemptError("protocol_error");
    }
    if (error instanceof FailoverAttemptError) throw error;
    throw new FailoverAttemptError("network_error");
  }
  if (!terminal) throw new FailoverAttemptError("network_error");
  await endResponse(response);
}

async function upstreamAttempt({
  body,
  configuration,
  onWeeklyQuotaObservation,
  observeEvent,
  quotaNow,
  requestHeaders,
  response,
  responseBodyLimitBytes,
  route,
  signal,
  upstreamHeadersTimeoutMs,
}) {
  if (signal.aborted) throw new FailoverAttemptError("client_cancelled");
  const headers = buildUpstreamRequestHeaders(requestHeaders, configuration.headers, {
    contentLength: route.method === "GET" ? null : body.length,
    route,
  });
  const transport = configuration.origin.protocol === "https:" ? https : http;
  let incoming = null;
  let headersTimer;
  const upstreamRequest = transport.request({
    protocol: configuration.origin.protocol,
    hostname: configuration.origin.hostname,
    port: configuration.origin.port || undefined,
    method: route.method,
    path: route.upstream_target,
    headers,
  });
  const abort = () => {
    upstreamRequest.destroy();
    incoming?.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    incoming = await new Promise((resolve, reject) => {
      headersTimer = setTimeout(() => {
        upstreamRequest.destroy();
        reject(new FailoverAttemptError("network_error"));
      }, upstreamHeadersTimeoutMs);
      upstreamRequest.once("response", resolve);
      upstreamRequest.once("error", () => {
        reject(new FailoverAttemptError(signal.aborted ? "client_cancelled" : "network_error"));
      });
      upstreamRequest.end(body);
    });
    clearTimeout(headersTimer);
    await classifyRetryableResponse(incoming, responseBodyLimitBytes);
    if (isSse(incoming.headers)) {
      await relaySse({
        accountId: configuration.accountId,
        incoming,
        onWeeklyQuotaObservation,
        quotaNow,
        response,
        observeEvent,
        responseBodyLimitBytes,
      });
      return;
    }
    let responseBody;
    try {
      responseBody = await readBounded(incoming, responseBodyLimitBytes);
    } catch (error) {
      if (error instanceof ResponseBodyLimitError) {
        throw new FailoverAttemptError("protocol_error");
      }
      throw new FailoverAttemptError("network_error");
    }
    await sendBufferedResponse(incoming, response, responseBody, observeEvent, route);
  } finally {
    clearTimeout(headersTimer);
    signal.removeEventListener("abort", abort);
    if (!upstreamRequest.destroyed) upstreamRequest.destroy();
    if (incoming && !incoming.destroyed && !incoming.complete) incoming.destroy();
  }
}

function inStreamError(error) {
  return Buffer.from(`event: error\ndata: ${JSON.stringify(failoverErrorBody(error))}\n\n`);
}

export function createFailoverHttpHandler({
  failoverStateMachine,
  onAttemptFailure,
  onWeeklyQuotaObservation,
  quotaNow,
  requestBodyLimitBytes,
  resolveUpstream,
  responseBodyLimitBytes,
  upstreamHeadersTimeoutMs,
}) {
  if (!failoverStateMachine || typeof failoverStateMachine.execute !== "function") {
    throw new TypeError("failoverStateMachine must provide execute");
  }
  if (typeof resolveUpstream !== "function") throw new TypeError("resolveUpstream is required");
  if (typeof onAttemptFailure !== "function") throw new TypeError("onAttemptFailure is required");
  if (typeof onWeeklyQuotaObservation !== "function") {
    throw new TypeError("onWeeklyQuotaObservation is required");
  }
  if (typeof quotaNow !== "function") throw new TypeError("quotaNow is required");

  return async ({ request, response, route, body: preparedBody = null }) => {
    let body = preparedBody;
    if (!Buffer.isBuffer(body)) {
      try {
        body = await readRequestBody(request, requestBodyLimitBytes);
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          sendJson(request, response, 413, { error: "request_body_too_large" }, { connection: "close" });
        } else if (!response.destroyed) {
          response.destroy();
        }
        return;
      }
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableFinished) cancel();
    });
    try {
      await failoverStateMachine.execute({
        replayPolicy: replayPolicy(route, request.headers, body),
        signal: controller.signal,
        async selectAccount(selectionContext) {
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
        async attempt({ observeEvent, selection, signal }) {
          await upstreamAttempt({
            body,
            configuration: selection.configuration,
            onWeeklyQuotaObservation,
            observeEvent,
            quotaNow,
            requestHeaders: request.headers,
            response,
            responseBodyLimitBytes,
            route,
            signal,
            upstreamHeadersTimeoutMs,
          });
        },
        onAttemptFailure,
      });
    } catch (error) {
      if (!(error instanceof FailoverResultError)) {
        if (!response.headersSent && !response.destroyed) {
          sendJson(request, response, 500, { error: "internal_proxy_error" });
        } else if (!response.destroyed) {
          response.destroy();
        }
        return;
      }
      if (response.headersSent) {
        if (error.code === "unsafe_to_replay" && !response.destroyed) {
          try {
            await writeChunk(response, inStreamError(error));
            await endResponse(response);
          } catch {
            response.destroy();
          }
        } else if (!response.destroyed) {
          response.destroy();
        }
        return;
      }
      if (!response.destroyed && error.code !== "client_cancelled") {
        sendJson(request, response, error.statusCode, failoverErrorBody(error));
      }
    } finally {
      request.off("aborted", cancel);
    }
  };
}
