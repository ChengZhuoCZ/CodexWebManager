import {
  validateHeaderName,
  validateHeaderValue,
} from "node:http";

const HTTP_CLIENT_HEADERS = new Set([
  "accept",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "thread-id",
  "user-agent",
  "version",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-turn-metadata",
  "x-codex-window-id",
]);
const WEBSOCKET_CLIENT_HEADERS = new Set([
  ...HTTP_CLIENT_HEADERS,
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
]);
const FORBIDDEN_INJECTED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const UPSTREAM_FIELDS = new Set(["origin", "headers", "release"]);
const HTTP_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "request-id",
  "retry-after",
  "x-request-id",
]);
const WEBSOCKET_RESPONSE_HEADERS = new Set([
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "upgrade",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function headerValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value.join(", ");
  }
  return null;
}

function isResponseHeaderAllowed(name) {
  return (
    HTTP_RESPONSE_HEADERS.has(name) ||
    name.startsWith("openai-") ||
    name.startsWith("ratelimit-") ||
    name.startsWith("x-ratelimit-")
  );
}

export class UpstreamConfigurationError extends Error {
  constructor() {
    super("upstream configuration is invalid");
    this.name = "UpstreamConfigurationError";
  }
}

export async function resolveUpstreamConfiguration(resolveUpstream, route) {
  let candidate;
  try {
    candidate = await resolveUpstream(route);
    if (!isPlainObject(candidate)) {
      throw new Error("invalid");
    }
    for (const field of Object.keys(candidate)) {
      if (!UPSTREAM_FIELDS.has(field)) {
        throw new Error("invalid");
      }
    }
    if (typeof candidate.origin !== "string" || !isPlainObject(candidate.headers ?? {})) {
      throw new Error("invalid");
    }
    if (candidate.release !== undefined && typeof candidate.release !== "function") {
      throw new Error("invalid");
    }
    const origin = new URL(candidate.origin);
    if (
      !new Set(["http:", "https:"]).has(origin.protocol) ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      throw new Error("invalid");
    }
    return Object.freeze({
      origin,
      headers: candidate.headers ?? {},
      release: candidate.release ?? null,
    });
  } catch {
    if (typeof candidate?.release === "function") {
      try {
        candidate.release();
      } catch {
        // Invalid configurations still release any lease they already acquired.
      }
    }
    throw new UpstreamConfigurationError();
  }
}

export function buildUpstreamRequestHeaders(
  clientHeaders,
  injectedHeaders,
  { contentLength = null, websocket = false } = {},
) {
  const output = Object.create(null);
  const allowed = websocket ? WEBSOCKET_CLIENT_HEADERS : HTTP_CLIENT_HEADERS;
  for (const [rawName, rawValue] of Object.entries(clientHeaders ?? {})) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) {
      continue;
    }
    const value = headerValue(rawValue);
    if (value !== null) {
      output[name] = value;
    }
  }
  output["accept-encoding"] = "identity";
  if (contentLength !== null) {
    output["content-length"] = String(contentLength);
  }
  if (websocket) {
    output.connection = "Upgrade";
    output.upgrade = "websocket";
  }
  const seenInjected = new Set();
  const entries = Object.entries(injectedHeaders ?? {});
  if (entries.length > 128) {
    throw new UpstreamConfigurationError();
  }
  for (const [rawName, rawValue] of entries) {
    try {
      const name = rawName.toLowerCase();
      if (
        seenInjected.has(name) ||
        FORBIDDEN_INJECTED_HEADERS.has(name) ||
        typeof rawValue !== "string" ||
        rawValue.length > 8_192
      ) {
        throw new Error("invalid");
      }
      validateHeaderName(name);
      validateHeaderValue(name, rawValue);
      seenInjected.add(name);
      output[name] = rawValue;
    } catch {
      throw new UpstreamConfigurationError();
    }
  }
  return output;
}

export function filterHttpResponseHeaders(headers) {
  const output = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!isResponseHeaderAllowed(name)) {
      continue;
    }
    const value = headerValue(rawValue);
    if (value !== null) {
      output[name] = value;
    }
  }
  return output;
}

export function filterWebSocketResponseHeaders(headers) {
  const output = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!WEBSOCKET_RESPONSE_HEADERS.has(name)) {
      continue;
    }
    const value = headerValue(rawValue);
    if (value !== null) {
      output[name] = value;
    }
  }
  return output;
}

export function rawHttpResponse(statusCode, statusMessage, headers, body = Buffer.alloc(0)) {
  const safeMessage =
    typeof statusMessage === "string" && /^[\x20-\x7e]{1,64}$/.test(statusMessage)
      ? statusMessage
      : "Response";
  const lines = [`HTTP/1.1 ${statusCode} ${safeMessage}`];
  for (const [name, value] of Object.entries(headers)) {
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      lines.push(`${name}: ${value}`);
    } catch {
      continue;
    }
  }
  lines.push("", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), body]);
}
