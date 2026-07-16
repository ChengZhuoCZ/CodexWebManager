import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  listProxyRoutes,
  normalizeProxyRoute,
  ProxyRouteError,
} from "../src/proxy-routes.mjs";

test("normalizes documented Responses prefix variants to one HTTP upstream target", () => {
  for (const rawTarget of [
    "/v1/responses",
    "/responses",
    "/v1/v1/responses",
    "/codex/v1/responses",
  ]) {
    assert.deepEqual(normalizeProxyRoute({ method: "POST", rawTarget }), {
      route_id: "responses_http",
      method: "POST",
      transport: "http",
      canonical_path: "/v1/responses",
      upstream_target: "/v1/responses",
    });
  }
});

test("normalizes compact and model path variants without accepting arbitrary suffixes", () => {
  for (const rawTarget of [
    "/v1/responses/compact",
    "/responses/compact",
    "/v1/v1/responses/compact",
    "/codex/v1/responses/compact",
  ]) {
    assert.equal(
      normalizeProxyRoute({ method: "POST", rawTarget }).route_id,
      "responses_compact",
    );
  }
  for (const rawTarget of ["/v1/models", "/models", "/v1/v1/models", "/codex/v1/models"]) {
    assert.equal(normalizeProxyRoute({ method: "GET", rawTarget }).route_id, "models_http");
  }
  for (const rawTarget of [
    "/v1/responses/anything",
    "/v1/models/latest",
    "/codex/v1/responses/compact/more",
  ]) {
    assert.throws(
      () => normalizeProxyRoute({ method: "GET", rawTarget }),
      (error) => error instanceof ProxyRouteError && error.code === "route_not_allowed",
    );
  }
});

test("allows only the exact backend routes and transports observed in M0.2", () => {
  assert.deepEqual(
    normalizeProxyRoute({
      method: "GET",
      rawTarget: "/backend-api/codex/responses",
      transport: "websocket",
    }),
    {
      route_id: "codex_responses_websocket",
      method: "GET",
      transport: "websocket",
      canonical_path: "/backend-api/codex/responses",
      upstream_target: "/backend-api/codex/responses",
    },
  );
  assert.equal(
    normalizeProxyRoute({ method: "GET", rawTarget: "/backend-api/codex/models" }).route_id,
    "codex_models",
  );
  assert.equal(
    normalizeProxyRoute({ method: "POST", rawTarget: "/backend-api/codex/alpha/search" }).route_id,
    "codex_search",
  );
  assert.throws(
    () => normalizeProxyRoute({ method: "GET", rawTarget: "/backend-api/codex/responses" }),
    (error) => error.code === "websocket_required" && error.statusCode === 426,
  );
  for (const rawTarget of [
    "/backend-api/codex/memory",
    "/backend-api/codex/alpha/search/anything",
    "/backend-api/other/models",
  ]) {
    assert.throws(() => normalizeProxyRoute({ method: "GET", rawTarget }), /not allowlisted/);
  }
});

test("preserves only a bounded client_version query on model routes", () => {
  for (const rawTarget of [
    "/v1/models?client_version=0.144.2",
    "/backend-api/codex/models?client_version=codex-cli+0.144.2",
  ]) {
    const normalized = normalizeProxyRoute({ method: "GET", rawTarget });
    assert.match(normalized.upstream_target, /\?client_version=/);
  }
  for (const rawTarget of [
    "/v1/models?other=value",
    "/v1/models?client_version=1&client_version=2",
    "/v1/models?client_version=1%2E0",
    "/v1/models?client_version=contains space",
    "/v1/responses?client_version=1",
    "/backend-api/codex/alpha/search?client_version=1",
  ]) {
    assert.throws(
      () => normalizeProxyRoute({ method: rawTarget.includes("responses") || rawTarget.includes("search") ? "POST" : "GET", rawTarget }),
      (error) => error.code === "query_not_allowed" || error.code === "invalid_query",
    );
  }
});

test("rejects method mismatches with a bounded allow list", () => {
  for (const [method, rawTarget] of [
    ["GET", "/v1/responses"],
    ["POST", "/v1/models"],
    ["GET", "/backend-api/codex/alpha/search"],
    ["CONNECT", "/v1/responses"],
  ]) {
    assert.throws(
      () => normalizeProxyRoute({ method, rawTarget }),
      (error) =>
        error instanceof ProxyRouteError &&
        error.code === "method_not_allowed" &&
        error.statusCode === 405 &&
        Array.isArray(error.allowedMethods),
    );
  }
});

test("rejects absolute-form, authority-form, traversal, encoded, fragment, and control targets", () => {
  const hostileTargets = [
    "https://example.invalid/v1/responses",
    "//example.invalid/v1/responses",
    "example.invalid:443",
    "*",
    "/v1/../responses",
    "/v1/%2e%2e/responses",
    "/v1\\responses",
    "/v1/responses#fragment",
    "/v1/responses\u0000",
    `/${"a".repeat(2_100)}`,
  ];
  for (const rawTarget of hostileTargets) {
    assert.throws(
      () => normalizeProxyRoute({ method: "POST", rawTarget }),
      (error) => error instanceof ProxyRouteError && error.code === "invalid_request_target",
    );
  }
});

test("never echoes a rejected target or constructs an upstream origin", () => {
  const secretCanary = "fixture-private-target-value";
  let caught;
  try {
    normalizeProxyRoute({
      method: "POST",
      rawTarget: `https://example.invalid/v1/responses?value=${secretCanary}`,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProxyRouteError);
  assert.doesNotMatch(caught.message, new RegExp(secretCanary));
  assert.doesNotMatch(JSON.stringify(caught), new RegExp(secretCanary));

  const normalized = normalizeProxyRoute({ method: "POST", rawTarget: "/v1/responses" });
  assert.doesNotMatch(JSON.stringify(normalized), /https?:\/\/|host|origin|authority/i);
});

test("route registry is frozen and synchronized with the checked-in contract", async () => {
  const routes = listProxyRoutes();
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(routes.every((route) => Object.isFrozen(route) && Object.isFrozen(route.inbound_paths)), true);
  const contractUrl = new URL("../../../contracts/proxy-routes.json", import.meta.url);
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));
  assert.equal(contract.version, 1);
  assert.deepEqual(contract.routes, routes);
  assert.doesNotMatch(JSON.stringify(contract), /credential|authorization|cookie|token|email/i);
});
