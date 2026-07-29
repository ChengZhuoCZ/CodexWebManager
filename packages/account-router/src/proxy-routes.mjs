import { inspect } from "node:util";

const MAX_REQUEST_TARGET_LENGTH = 2_048;
const MAX_QUERY_LENGTH = 512;
const TRANSPORTS = new Set(["http", "websocket"]);

function route(definition) {
  return Object.freeze({
    route_id: definition.route_id,
    method: definition.method,
    transport: definition.transport,
    canonical_path: definition.canonical_path,
    upstream_path: definition.upstream_path,
    inbound_paths: Object.freeze([...definition.inbound_paths]),
    allowed_query_keys: Object.freeze([...definition.allowed_query_keys]),
  });
}

const ROUTES = Object.freeze([
  route({
    route_id: "responses_http",
    method: "POST",
    transport: "http",
    canonical_path: "/v1/responses",
    upstream_path: "/v1/responses",
    inbound_paths: [
      "/v1/responses",
      "/responses",
      "/v1/v1/responses",
      "/codex/v1/responses",
    ],
    allowed_query_keys: [],
  }),
  route({
    route_id: "responses_compact",
    method: "POST",
    transport: "http",
    canonical_path: "/v1/responses/compact",
    upstream_path: "/v1/responses/compact",
    inbound_paths: [
      "/v1/responses/compact",
      "/responses/compact",
      "/v1/v1/responses/compact",
      "/codex/v1/responses/compact",
    ],
    allowed_query_keys: [],
  }),
  route({
    route_id: "models_http",
    method: "GET",
    transport: "http",
    canonical_path: "/v1/models",
    upstream_path: "/v1/models",
    inbound_paths: ["/v1/models", "/models", "/v1/v1/models", "/codex/v1/models"],
    allowed_query_keys: ["client_version"],
  }),
  route({
    route_id: "codex_responses_http",
    method: "POST",
    transport: "http",
    canonical_path: "/backend-api/codex/responses",
    upstream_path: "/backend-api/codex/responses",
    inbound_paths: ["/backend-api/codex/responses"],
    allowed_query_keys: [],
  }),
  route({
    route_id: "codex_responses_websocket",
    method: "GET",
    transport: "websocket",
    canonical_path: "/backend-api/codex/responses",
    upstream_path: "/backend-api/codex/responses",
    inbound_paths: ["/backend-api/codex/responses"],
    allowed_query_keys: [],
  }),
  route({
    route_id: "codex_models",
    method: "GET",
    transport: "http",
    canonical_path: "/backend-api/codex/models",
    upstream_path: "/backend-api/codex/models",
    inbound_paths: ["/backend-api/codex/models"],
    allowed_query_keys: ["client_version"],
  }),
  route({
    route_id: "codex_search",
    method: "POST",
    transport: "http",
    canonical_path: "/backend-api/codex/alpha/search",
    upstream_path: "/backend-api/codex/alpha/search",
    inbound_paths: ["/backend-api/codex/alpha/search"],
    allowed_query_keys: [],
  }),
]);

const ROUTES_BY_PATH = new Map();
for (const definition of ROUTES) {
  for (const path of definition.inbound_paths) {
    const candidates = [...(ROUTES_BY_PATH.get(path) ?? []), definition];
    ROUTES_BY_PATH.set(path, Object.freeze(candidates));
  }
}

export class ProxyRouteError extends Error {
  constructor(code, statusCode, message, allowedMethods = []) {
    super(message);
    this.name = "ProxyRouteError";
    this.code = code;
    this.statusCode = statusCode;
    this.allowedMethods = Object.freeze([...allowedMethods]);
  }

  toJSON() {
    return Object.freeze({
      error: this.code,
      status_code: this.statusCode,
      allowed_methods: this.allowedMethods,
    });
  }

  [inspect.custom]() {
    return `[ProxyRouteError ${this.code}]`;
  }
}

function fail(code, statusCode, message, allowedMethods = []) {
  throw new ProxyRouteError(code, statusCode, message, allowedMethods);
}

function parseRequestTarget(rawTarget) {
  if (
    typeof rawTarget !== "string" ||
    rawTarget.length < 1 ||
    rawTarget.length > MAX_REQUEST_TARGET_LENGTH ||
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    rawTarget.includes("#") ||
    rawTarget.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(rawTarget)
  ) {
    fail("invalid_request_target", 400, "request target is invalid");
  }
  const queryIndex = rawTarget.indexOf("?");
  const path = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
  const query = queryIndex === -1 ? null : rawTarget.slice(queryIndex + 1);
  if (
    path.length < 1 ||
    path.includes("%") ||
    path.includes(" ") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail("invalid_request_target", 400, "request target is invalid");
  }
  if (query !== null && (query.length < 1 || query.length > MAX_QUERY_LENGTH)) {
    fail("invalid_query", 400, "request query is invalid");
  }
  return Object.freeze({ path, query });
}

function normalizeQuery(definition, query) {
  if (query === null) {
    return "";
  }
  if (definition.allowed_query_keys.length === 0) {
    fail("query_not_allowed", 400, "query is not allowed for this route");
  }
  const match = /^client_version=([A-Za-z0-9._+-]{1,64})$/.exec(query);
  if (!match || !definition.allowed_query_keys.includes("client_version")) {
    fail("invalid_query", 400, "request query is invalid");
  }
  return `?client_version=${match[1]}`;
}

export function normalizeProxyRoute({ method, rawTarget, transport = "http" } = {}) {
  if (typeof method !== "string" || !/^[A-Z]{3,16}$/.test(method)) {
    fail("invalid_method", 400, "request method is invalid");
  }
  if (!TRANSPORTS.has(transport)) {
    fail("invalid_transport", 400, "request transport is invalid");
  }
  const target = parseRequestTarget(rawTarget);
  const pathCandidates = ROUTES_BY_PATH.get(target.path);
  if (!pathCandidates) {
    fail("route_not_allowed", 404, "request path is not allowlisted");
  }
  const methodCandidates = pathCandidates.filter((definition) => definition.method === method);
  if (methodCandidates.length === 0) {
    const allowedMethods = [...new Set(pathCandidates.map((definition) => definition.method))].sort();
    fail("method_not_allowed", 405, "method is not allowed for this path", allowedMethods);
  }
  const definition = methodCandidates.find((candidate) => candidate.transport === transport);
  if (!definition) {
    if (methodCandidates.some((candidate) => candidate.transport === "websocket")) {
      fail("websocket_required", 426, "this route requires a WebSocket upgrade", [method]);
    }
    fail("transport_not_allowed", 400, "transport is not allowed for this route", [method]);
  }
  const query = normalizeQuery(definition, target.query);
  return Object.freeze({
    route_id: definition.route_id,
    method: definition.method,
    transport: definition.transport,
    canonical_path: definition.canonical_path,
    upstream_target: `${definition.upstream_path}${query}`,
  });
}

export function listProxyRoutes() {
  return ROUTES;
}
