import { validateHeaderValue } from "node:http";
import { TextDecoder } from "node:util";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MODEL_TARGET_PATTERN =
  /^\/backend-api\/codex\/models(?:\?client_version=[A-Za-z0-9._+-]{1,64})?$/;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const CACHED_HEADER_NAMES = Object.freeze([
  "cache-control",
  "content-type",
  "etag",
  "last-modified",
]);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function integerOption(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function isModelCatalogRoute(route) {
  return (
    route !== null &&
    typeof route === "object" &&
    !Array.isArray(route) &&
    route.route_id === "codex_models" &&
    typeof route.upstream_target === "string" &&
    MODEL_TARGET_PATTERN.test(route.upstream_target)
  );
}

function cacheKey(accountId, route) {
  if (
    typeof accountId !== "string" ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    !isModelCatalogRoute(route)
  ) {
    return null;
  }
  return `${accountId.length}:${accountId}${route.upstream_target}`;
}

function headerValue(headers, name) {
  const value = headers?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value.join(", ");
  }
  return null;
}

function sanitizedHeaders(headers, bodyLength) {
  const contentType = headerValue(headers, "content-type");
  if (contentType === null || !JSON_MEDIA_TYPE.test(contentType.trim())) return null;
  const output = Object.create(null);
  for (const name of CACHED_HEADER_NAMES) {
    const value = headerValue(headers, name);
    if (value === null || value.length > 8_192) continue;
    try {
      validateHeaderValue(name, value);
      output[name] = value;
    } catch {
      return null;
    }
  }
  output["content-length"] = String(bodyLength);
  return Object.freeze(output);
}

function isValidJson(body) {
  try {
    JSON.parse(UTF8.decode(body));
    return true;
  } catch {
    return false;
  }
}

export function createModelCatalogCache({
  ttlMs = 5 * 60_000,
  maxEntries = 32,
  maxBodyBytes = 2 * 1024 * 1024,
  now = () => Date.now(),
} = {}) {
  integerOption(ttlMs, "ttlMs", 1, 24 * 60 * 60_000);
  integerOption(maxEntries, "maxEntries", 1, 1_024);
  integerOption(maxBodyBytes, "maxBodyBytes", 1, 64 * 1024 * 1024);
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const entries = new Map();

  function pruneExpired(currentTime) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > currentTime) continue;
      entries.delete(key);
    }
  }

  function read({ accountId, route } = {}) {
    const key = cacheKey(accountId, route);
    if (key === null) return null;
    const currentTime = now();
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= currentTime) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return Object.freeze({
      statusCode: entry.statusCode,
      headers: entry.headers,
      body: Buffer.from(entry.body),
    });
  }

  function write({ accountId, route, statusCode, headers, body } = {}) {
    const key = cacheKey(accountId, route);
    if (
      key === null ||
      !Number.isInteger(statusCode) ||
      statusCode < 200 ||
      statusCode > 299 ||
      !Buffer.isBuffer(body) ||
      body.length < 1 ||
      body.length > maxBodyBytes ||
      !isValidJson(body)
    ) {
      return false;
    }
    const safeHeaders = sanitizedHeaders(headers, body.length);
    if (safeHeaders === null) return false;
    const currentTime = now();
    pruneExpired(currentTime);
    entries.delete(key);
    while (entries.size >= maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    entries.set(key, Object.freeze({
      statusCode,
      headers: safeHeaders,
      body: Buffer.from(body),
      expiresAt: currentTime + ttlMs,
    }));
    return true;
  }

  return Object.freeze({
    read,
    write,
    get size() {
      pruneExpired(now());
      return entries.size;
    },
    toString() {
      return "[ModelCatalogCache]";
    },
    toJSON() {
      return "[ModelCatalogCache]";
    },
  });
}
