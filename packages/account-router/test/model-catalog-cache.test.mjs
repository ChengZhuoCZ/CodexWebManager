import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalogCache } from "../src/model-catalog-cache.mjs";

function route(clientVersion = null) {
  return Object.freeze({
    route_id: "codex_models",
    upstream_target: clientVersion === null
      ? "/backend-api/codex/models"
      : `/backend-api/codex/models?client_version=${clientVersion}`,
  });
}

function response(body) {
  return {
    statusCode: 200,
    headers: {
      "cache-control": "private, max-age=0",
      "content-type": "application/json; charset=utf-8",
      etag: '"fixture-models"',
      "last-modified": "Wed, 29 Jul 2026 00:00:00 GMT",
      "request-id": "must-not-cache",
      "x-oai-request-id": "must-not-cache",
      "x-ratelimit-remaining-requests": "must-not-cache",
      authorization: "Bearer fixture-private-cache-value",
      "set-cookie": "must-not-cache",
    },
    body,
  };
}

test("isolates fresh model catalogs by account and normalized client-version target", () => {
  let currentTime = 1_000;
  const cache = createModelCatalogCache({
    ttlMs: 5_000,
    now: () => currentTime,
  });
  const body = Buffer.from('{"models":[{"slug":"fixture-a"}]}');
  const fixtureResponse = response(body);
  assert.equal(cache.write({
    accountId: "A",
    route: route("0.145.0"),
    ...fixtureResponse,
  }), true);

  body.fill(0);
  const first = cache.read({ accountId: "A", route: route("0.145.0") });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.toString("utf8"), '{"models":[{"slug":"fixture-a"}]}');
  assert.deepEqual({ ...first.headers }, {
    "cache-control": "private, max-age=0",
    "content-length": "33",
    "content-type": "application/json; charset=utf-8",
    etag: '"fixture-models"',
    "last-modified": "Wed, 29 Jul 2026 00:00:00 GMT",
  });
  assert.equal(first.headers["x-oai-request-id"], undefined);
  assert.equal(first.headers["x-ratelimit-remaining-requests"], undefined);
  assert.equal(first.headers.authorization, undefined);
  assert.equal(first.headers["set-cookie"], undefined);

  first.body.fill(0);
  assert.equal(
    cache.read({ accountId: "A", route: route("0.145.0") }).body.toString("utf8"),
    '{"models":[{"slug":"fixture-a"}]}',
  );
  assert.equal(cache.read({ accountId: "B", route: route("0.145.0") }), null);
  assert.equal(cache.read({ accountId: "A", route: route("0.145.1") }), null);

  currentTime += 5_000;
  assert.equal(cache.read({ accountId: "A", route: route("0.145.0") }), null);
  assert.equal(cache.size, 0);
});

test("stores only bounded successful JSON model responses", () => {
  const cache = createModelCatalogCache({ maxBodyBytes: 64 });
  const valid = {
    accountId: "fixture-account",
    route: route(),
    ...response(Buffer.from('{"models":[]}')),
  };
  const rejected = [
    { ...valid, accountId: "../escape" },
    { ...valid, route: { route_id: "codex_search", upstream_target: "/backend-api/codex/models" } },
    { ...valid, route: { route_id: "codex_models", upstream_target: "/backend-api/codex/models?x=1" } },
    { ...valid, statusCode: 429 },
    { ...valid, headers: { "content-type": "text/plain" } },
    { ...valid, headers: { "content-type": "application/json", etag: "bad\nvalue" } },
    { ...valid, body: Buffer.from("{") },
    { ...valid, body: Buffer.alloc(65, 0x20) },
  ];
  for (const candidate of rejected) assert.equal(cache.write(candidate), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.write(valid), true);
  assert.equal(cache.size, 1);
  assert.equal(String(cache), "[ModelCatalogCache]");
  assert.equal(JSON.stringify(cache), '"[ModelCatalogCache]"');
});

test("enforces deterministic least-recently-used entry bounds", () => {
  const cache = createModelCatalogCache({ maxEntries: 2 });
  const firstRoute = route("0.145.0");
  const secondRoute = route("0.145.1");
  const body = Buffer.from('{"models":[]}');
  assert.equal(cache.write({ accountId: "A", route: firstRoute, ...response(body) }), true);
  assert.equal(cache.write({ accountId: "A", route: secondRoute, ...response(body) }), true);

  assert.notEqual(cache.read({ accountId: "A", route: firstRoute }), null);
  assert.equal(cache.write({ accountId: "B", route: firstRoute, ...response(body) }), true);

  assert.equal(cache.size, 2);
  assert.notEqual(cache.read({ accountId: "A", route: firstRoute }), null);
  assert.equal(cache.read({ accountId: "A", route: secondRoute }), null);
  assert.notEqual(cache.read({ accountId: "B", route: firstRoute }), null);
});

test("rejects unsafe cache bounds and clocks", () => {
  assert.throws(() => createModelCatalogCache({ ttlMs: 0 }), /ttlMs/);
  assert.throws(() => createModelCatalogCache({ maxEntries: 0 }), /maxEntries/);
  assert.throws(() => createModelCatalogCache({ maxBodyBytes: 0 }), /maxBodyBytes/);
  assert.throws(() => createModelCatalogCache({ now: null }), /now/);
});
