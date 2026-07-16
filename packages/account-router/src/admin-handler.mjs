import { routePath, sendJson } from "./http-handler.mjs";

const ADMIN_PATHS = new Set(["/v1/status", "/v1/accounts", "/v1/events", "/v1/switch"]);
const SWITCH_FIELDS = new Set(["account_alias", "routing_session_id", "reason"]);
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

class BodyError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BodyError(400, "invalid_json_body");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BodyError(400, "invalid_json_body");
  }
}

function validateSwitchBody(body) {
  assertPlainObject(body);
  for (const field of Object.keys(body)) {
    if (!SWITCH_FIELDS.has(field)) {
      throw new BodyError(400, "unsupported_switch_field");
    }
  }
  if (
    typeof body.account_alias !== "string" ||
    body.account_alias.trim() !== body.account_alias ||
    [...body.account_alias].length < 1 ||
    [...body.account_alias].length > 64
  ) {
    throw new BodyError(400, "invalid_account_alias");
  }
  if (body.reason !== "manual") {
    throw new BodyError(400, "invalid_switch_reason");
  }
  if (
    body.routing_session_id !== undefined &&
    (typeof body.routing_session_id !== "string" ||
      !SESSION_PATTERN.test(body.routing_session_id))
  ) {
    throw new BodyError(400, "invalid_routing_session_id");
  }
  return Object.freeze({
    accountAlias: body.account_alias,
    routingSessionId: body.routing_session_id ?? null,
    reason: body.reason,
  });
}

async function readJsonBody(request, limitBytes) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new BodyError(415, "content_type_must_be_json");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limitBytes) {
      request.resume();
      throw new BodyError(413, "request_body_too_large");
    }
    chunks.push(chunk);
  }
  if (length === 0) {
    throw new BodyError(400, "request_body_required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new BodyError(400, "invalid_json_body");
  }
}

function writeSseEvent(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify({ ...event.data, timestamp: event.timestamp })}\n\n`);
}

export function createAdminHandler({
  authenticator,
  state,
  eventBroker,
  onSwitchRequest = null,
  requestBodyLimitBytes = 8 * 1024,
  heartbeatMs = 15_000,
} = {}) {
  if (authenticator !== null && (typeof authenticator !== "object" || typeof authenticator.authenticate !== "function")) {
    throw new TypeError("admin authenticator is invalid");
  }
  if (state === null || typeof state !== "object" || typeof state.snapshot !== "function") {
    throw new TypeError("admin state is invalid");
  }
  if (eventBroker === null || typeof eventBroker !== "object" || typeof eventBroker.subscribe !== "function") {
    throw new TypeError("event broker is invalid");
  }
  if (onSwitchRequest !== null && typeof onSwitchRequest !== "function") {
    throw new TypeError("onSwitchRequest must be a function");
  }
  if (!Number.isSafeInteger(requestBodyLimitBytes) || requestBodyLimitBytes < 256 || requestBodyLimitBytes > 1024 * 1024) {
    throw new Error("requestBodyLimitBytes must be an integer from 256 through 1048576");
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0 || heartbeatMs > 60_000) {
    throw new Error("heartbeatMs must be an integer from 0 through 60000");
  }

  const handle = async (request, response, parsedPath = undefined) => {
    const pathname = parsedPath ?? routePath(request.url);
    if (pathname === null) {
      sendJson(request, response, 400, { error: "invalid_request_target" });
      return;
    }
    if (!ADMIN_PATHS.has(pathname)) {
      sendJson(request, response, 404, { error: "not_found" });
      return;
    }
    if (authenticator === null) {
      sendJson(request, response, 503, { error: "admin_auth_not_configured" });
      return;
    }
    if (!authenticator.authenticate(request.headers)) {
      sendJson(
        request,
        response,
        401,
        { error: "admin_auth_required" },
        { "www-authenticate": 'Bearer realm="codex-router-admin"' },
      );
      return;
    }

    if (pathname === "/v1/status" || pathname === "/v1/accounts") {
      if (!new Set(["GET", "HEAD"]).has(request.method)) {
        sendJson(request, response, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
        return;
      }
      const payload =
        pathname === "/v1/status" ? state.snapshot() : { accounts: state.listAccounts() };
      sendJson(request, response, 200, payload);
      return;
    }

    if (pathname === "/v1/events") {
      if (request.method !== "GET") {
        sendJson(request, response, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return;
      }
      const afterId = request.headers["last-event-id"] ?? "0";
      if (typeof afterId !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(afterId)) {
        sendJson(request, response, 400, { error: "invalid_event_cursor" });
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      response.write(": connected\n\n");
      const unsubscribe = eventBroker.subscribe((event) => writeSseEvent(response, event), {
        afterId,
      });
      const heartbeat =
        heartbeatMs > 0
          ? setInterval(() => response.write(": heartbeat\n\n"), heartbeatMs)
          : null;
      heartbeat?.unref();
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        unsubscribe();
        request.off("aborted", cleanup);
        response.off("close", cleanup);
      };
      request.once("aborted", cleanup);
      response.once("close", cleanup);
      return;
    }

    if (request.method !== "POST") {
      sendJson(request, response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    if (state.activeStreams > 0) {
      request.resume();
      sendJson(request, response, 409, { error: "active_semantic_stream" });
      return;
    }
    if (onSwitchRequest === null) {
      request.resume();
      sendJson(request, response, 409, { error: "switch_not_available" });
      return;
    }

    let switchRequest;
    try {
      switchRequest = validateSwitchBody(await readJsonBody(request, requestBodyLimitBytes));
    } catch (error) {
      const statusCode = error instanceof BodyError ? error.statusCode : 400;
      const code = error instanceof BodyError ? error.code : "invalid_switch_request";
      sendJson(request, response, statusCode, { error: code });
      return;
    }

    let result;
    try {
      result = await onSwitchRequest(switchRequest);
    } catch {
      sendJson(request, response, 503, { error: "switch_request_failed" });
      return;
    }
    if (!result || result.accepted !== true) {
      sendJson(request, response, 409, { error: "switch_rejected" });
      return;
    }
    const requestedAccountId = state.findAccountIdByAlias(switchRequest.accountAlias);
    if (!requestedAccountId || result.toAccountId !== requestedAccountId) {
      sendJson(request, response, 409, { error: "switch_target_mismatch" });
      return;
    }
    let event;
    try {
      event = state.recordSwitch({
        fromAccountId: result.fromAccountId ?? null,
        toAccountId: result.toAccountId,
        reason: result.reason,
      });
    } catch {
      sendJson(request, response, 503, { error: "switch_state_rejected" });
      return;
    }
    sendJson(request, response, 200, {
      accepted: true,
      account_alias: event.data.to_alias,
      continuity: "new_backend_session",
      architecture_mode: "LIMITED_MODE",
    });
  };

  return (request, response, parsedPath = undefined) =>
    handle(request, response, parsedPath).catch(() => {
      if (!response.headersSent) {
        sendJson(request, response, 500, { error: "internal_error" });
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
}
