import { inspect, TextDecoder } from "node:util";

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

function endpoint(definition) {
  return Object.freeze({
    route_id: definition.route_id,
    method: definition.method,
    canonical_path: definition.canonical_path,
    allowed_query_keys: Object.freeze([...definition.allowed_query_keys]),
    forwarded_client_headers: Object.freeze([...definition.forwarded_client_headers]),
    request_body: definition.request_body,
    response_body: definition.response_body,
  });
}

const ENDPOINTS = Object.freeze([
  endpoint({
    route_id: "codex_models",
    method: "GET",
    canonical_path: "/backend-api/codex/models",
    allowed_query_keys: ["client_version"],
    forwarded_client_headers: ["accept", "originator", "user-agent", "version"],
    request_body: "empty",
    response_body: "json",
  }),
  endpoint({
    route_id: "codex_search",
    method: "POST",
    canonical_path: "/backend-api/codex/alpha/search",
    allowed_query_keys: [],
    forwarded_client_headers: ["accept", "content-type", "originator", "user-agent", "version"],
    request_body: "observed_search_json",
    response_body: "json",
  }),
]);

const ENDPOINTS_BY_ROUTE = new Map(ENDPOINTS.map((definition) => [
  definition.route_id,
  definition,
]));
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mediaType(headers) {
  const value = headers?.["content-type"];
  return typeof value === "string" ? value.trim() : null;
}

function parseJson(body) {
  if (!Buffer.isBuffer(body)) throw new TypeError("auxiliary body must be a Buffer");
  return JSON.parse(UTF8.decode(body));
}

function validSearchRequest(value) {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.input) &&
    typeof value.max_output_tokens === "number" &&
    Number.isFinite(value.max_output_tokens) &&
    typeof value.model === "string"
  );
}

export class AuxiliaryEndpointError extends Error {
  constructor(code, statusCode) {
    super("auxiliary endpoint validation failed");
    this.name = "AuxiliaryEndpointError";
    this.code = code;
    this.statusCode = statusCode;
    Object.freeze(this);
  }

  [inspect.custom]() {
    return `[AuxiliaryEndpointError ${this.code}]`;
  }
}

export function listAuxiliaryEndpointPolicies() {
  return ENDPOINTS;
}

export function getAuxiliaryEndpointPolicy(route) {
  if (route === null || typeof route !== "object" || Array.isArray(route)) return null;
  return ENDPOINTS_BY_ROUTE.get(route.route_id) ?? null;
}

export function validateAuxiliaryRequest(route, headers, body) {
  const policy = getAuxiliaryEndpointPolicy(route);
  if (policy === null) return null;
  if (!Buffer.isBuffer(body)) throw new TypeError("auxiliary request body must be a Buffer");

  if (policy.request_body === "empty") {
    if (body.length !== 0) {
      throw new AuxiliaryEndpointError("auxiliary_request_body_not_allowed", 400);
    }
    return policy;
  }

  if (!JSON_MEDIA_TYPE.test(mediaType(headers) ?? "")) {
    throw new AuxiliaryEndpointError("auxiliary_unsupported_media_type", 415);
  }
  let value;
  try {
    value = parseJson(body);
  } catch {
    throw new AuxiliaryEndpointError("invalid_auxiliary_request", 400);
  }
  if (!validSearchRequest(value)) {
    throw new AuxiliaryEndpointError("invalid_auxiliary_request", 400);
  }
  return policy;
}

export function validateAuxiliaryResponse(route, statusCode, headers, body) {
  const policy = getAuxiliaryEndpointPolicy(route);
  if (policy === null) return null;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new AuxiliaryEndpointError("invalid_auxiliary_response", 502);
  }
  if (statusCode < 200 || statusCode > 299) return policy;
  if (!JSON_MEDIA_TYPE.test(mediaType(headers) ?? "")) {
    throw new AuxiliaryEndpointError("invalid_auxiliary_response", 502);
  }
  try {
    parseJson(body);
  } catch {
    throw new AuxiliaryEndpointError("invalid_auxiliary_response", 502);
  }
  return policy;
}
