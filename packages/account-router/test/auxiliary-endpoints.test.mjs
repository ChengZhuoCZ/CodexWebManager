import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import {
  getAuxiliaryEndpointPolicy,
  listAuxiliaryEndpointPolicies,
} from "../src/auxiliary-endpoints.mjs";
import { createFailoverStateMachine } from "../src/failover-state-machine.mjs";
import { createModelProxyService } from "../src/model-service.mjs";
import { createProxyHandler } from "../src/proxy-handler.mjs";

const FIXTURE_UPSTREAM_AUTHORIZATION = "Bearer fixture-auxiliary-upstream";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function fixture(context, upstreamListener, proxyOptions = {}) {
  const upstream = http.createServer(upstreamListener);
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const resolverCalls = [];
  const releases = [];
  const proxyHandler = createProxyHandler({
    async resolveUpstream(route) {
      resolverCalls.push(route);
      return {
        accountId: "fixture-auxiliary-account",
        origin: upstreamOrigin,
        headers: {
          authorization: FIXTURE_UPSTREAM_AUTHORIZATION,
          "chatgpt-account-id": "fixture-auxiliary-account",
        },
        release() { releases.push(route.route_id); },
      };
    },
    requestBodyLimitBytes: 1_024,
    responseBodyLimitBytes: 4_096,
    upstreamHeadersTimeoutMs: 500,
    requestTotalTimeoutMs: 2_000,
    ...proxyOptions,
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    releases,
    resolverCalls,
  };
}

async function rawRequest(origin, { body = Buffer.alloc(0), headers = {}, method, path }) {
  return await new Promise((resolve, reject) => {
    const request = http.request(`${origin}${path}`, { method, headers });
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        statusCode: response.statusCode,
      }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

function parseJsonBody(result) {
  return JSON.parse(result.body.toString("utf8"));
}

test("policy exactly covers the M0.2-observed auxiliary HTTP endpoints", async () => {
  const evidenceUrl = new URL("../../../evidence/M0.2-protocol-redacted.jsonl", import.meta.url);
  const records = (await readFile(evidenceUrl, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const observedRequests = records
    .filter((record) => record.kind === "request_shape")
    .map((record) => ({
      contentType: record.headers.safe_values["content-type"] ?? null,
      method: record.method,
      path: record.path,
      queryKeys: record.query_keys,
    }));
  assert.deepEqual(observedRequests, [
    {
      contentType: null,
      method: "GET",
      path: "/backend-api/codex/models",
      queryKeys: ["client_version"],
    },
    {
      contentType: "application/json",
      method: "POST",
      path: "/backend-api/codex/alpha/search",
      queryKeys: [],
    },
  ]);
  const requestByObservation = new Map(
    records
      .filter((record) => record.kind === "request_shape")
      .map((record) => [record.observation_id, record]),
  );
  const observedResponses = records
    .filter((record) => record.kind === "response_shape")
    .filter((record) => requestByObservation.has(record.observation_id))
    .map((record) => ({
      contentType: record.headers.safe_values["content-type"] ?? null,
      path: requestByObservation.get(record.observation_id).path,
      status: record.status,
    }));
  assert.deepEqual(observedResponses, [
    {
      contentType: "application/json",
      path: "/backend-api/codex/models",
      status: 200,
    },
    {
      contentType: "application/json",
      path: "/backend-api/codex/alpha/search",
      status: 200,
    },
  ]);

  const policies = listAuxiliaryEndpointPolicies();
  assert.deepEqual(policies, [
    {
      route_id: "codex_models",
      method: "GET",
      canonical_path: "/backend-api/codex/models",
      allowed_query_keys: ["client_version"],
      forwarded_client_headers: ["accept", "originator", "user-agent", "version"],
      request_body: "empty",
      response_body: "json",
    },
    {
      route_id: "codex_search",
      method: "POST",
      canonical_path: "/backend-api/codex/alpha/search",
      allowed_query_keys: [],
      forwarded_client_headers: ["accept", "content-type", "originator", "user-agent", "version"],
      request_body: "observed_search_json",
      response_body: "json",
    },
  ]);
  assert.equal(Object.isFrozen(policies), true);
  assert.equal(policies.every((policy) => Object.isFrozen(policy)), true);
  assert.equal(policies.every((policy) => (
    Object.isFrozen(policy.allowed_query_keys) &&
    Object.isFrozen(policy.forwarded_client_headers)
  )), true);
  assert.equal(getAuxiliaryEndpointPolicy({ route_id: "models_http" }), null);
});

test("passes the observed models request and bounded JSON response without client credentials", async (context) => {
  let observed;
  const responseBody = Buffer.from(JSON.stringify({ models: [{ slug: "fixture-model" }] }));
  const { origin, releases, resolverCalls } = await fixture(context, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      accept: request.headers.accept,
      account: request.headers["chatgpt-account-id"],
      authorization: request.headers.authorization,
      bodyBytes: Buffer.concat(chunks).length,
      clientAuthorization: request.headers["x-client-authorization-canary"],
      cookie: request.headers.cookie,
      host: request.headers.host,
      openaiBeta: request.headers["openai-beta"],
      originator: request.headers.originator,
      path: request.url,
      sessionId: request.headers["session-id"],
      userAgent: request.headers["user-agent"],
      version: request.headers.version,
      xClientRequestId: request.headers["x-client-request-id"],
    };
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": responseBody.length,
      etag: "fixture-etag",
      "set-cookie": "fixture-private-cookie=hidden",
      "x-oai-request-id": "fixture-models-request-id",
      "x-private-upstream": "hidden",
    });
    response.end(responseBody);
  });
  const result = await fetch(`${origin}/backend-api/codex/models?client_version=0.144.2`, {
    headers: {
      accept: "*/*",
      authorization: "Bearer fixture-client-credential",
      cookie: "fixture-client-cookie=hidden",
      "openai-beta": "responses=v1",
      originator: "codex_cli_rs",
      "session-id": "fixture-session",
      "user-agent": "fixture-codex/0.144.2",
      version: "0.144.2",
      "x-client-request-id": "fixture-responses-only-header",
      "x-client-authorization-canary": "hidden",
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { models: [{ slug: "fixture-model" }] });
  assert.equal(result.headers.get("etag"), "fixture-etag");
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("x-oai-request-id"), "fixture-models-request-id");
  assert.equal(result.headers.get("x-private-upstream"), null);
  const { host: observedHost, ...observedWithoutHost } = observed;
  assert.match(observedHost, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(observedWithoutHost, {
    accept: "*/*",
    account: "fixture-auxiliary-account",
    authorization: FIXTURE_UPSTREAM_AUTHORIZATION,
    bodyBytes: 0,
    clientAuthorization: undefined,
    cookie: undefined,
    openaiBeta: undefined,
    originator: "codex_cli_rs",
    path: "/backend-api/codex/models?client_version=0.144.2",
    sessionId: undefined,
    userAgent: "fixture-codex/0.144.2",
    version: "0.144.2",
    xClientRequestId: undefined,
  });
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].route_id, "codex_models");
  assert.deepEqual(releases, ["codex_models"]);
});

test("passes the observed search JSON bytes and a bounded JSON response", async (context) => {
  let observed;
  const body = Buffer.from(JSON.stringify({
    id: "fixture-search",
    input: [{ role: "user", content: [{ type: "input_text", text: "fixture-query" }] }],
    max_output_tokens: 128,
    model: "fixture-model",
    fixture_unknown_config: { enabled: true },
  }));
  const { origin, releases, resolverCalls } = await fixture(context, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      accept: request.headers.accept,
      account: request.headers["chatgpt-account-id"],
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks),
      contentLength: request.headers["content-length"],
      contentType: request.headers["content-type"],
      cookie: request.headers.cookie,
      host: request.headers.host,
      openaiBeta: request.headers["openai-beta"],
      originator: request.headers.originator,
      path: request.url,
      sessionId: request.headers["session-id"],
      userAgent: request.headers["user-agent"],
      version: request.headers.version,
      xCodexMetadata: request.headers["x-codex-turn-metadata"],
    };
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": "fixture-private-cookie=hidden",
      "x-oai-request-id": "fixture-search-request-id",
    });
    response.end('{"results":[{"title":"fixture-result"}]}');
  });
  const result = await fetch(`${origin}/backend-api/codex/alpha/search`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-client-credential",
      cookie: "fixture-client-cookie=hidden",
      accept: "*/*",
      "content-type": "application/json; charset=utf-8",
      "openai-beta": "responses=v1",
      originator: "codex_cli_rs",
      "session-id": "fixture-session",
      "user-agent": "fixture-codex/0.144.2",
      version: "0.144.2",
      "x-codex-turn-metadata": "fixture-responses-only-header",
    },
    body,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { results: [{ title: "fixture-result" }] });
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("x-oai-request-id"), "fixture-search-request-id");
  const { host: observedHost, ...observedWithoutHost } = observed;
  assert.match(observedHost, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(observedWithoutHost, {
    accept: "*/*",
    account: "fixture-auxiliary-account",
    authorization: FIXTURE_UPSTREAM_AUTHORIZATION,
    body,
    contentLength: String(body.length),
    contentType: "application/json; charset=utf-8",
    cookie: undefined,
    openaiBeta: undefined,
    originator: "codex_cli_rs",
    path: "/backend-api/codex/alpha/search",
    sessionId: undefined,
    userAgent: "fixture-codex/0.144.2",
    version: "0.144.2",
    xCodexMetadata: undefined,
  });
  assert.equal(resolverCalls.length, 1);
  assert.deepEqual(releases, ["codex_search"]);
});

test("rejects malformed auxiliary requests before resolving an account", async (context) => {
  const { origin, resolverCalls } = await fixture(context, (_request, response) => {
    response.end("must-not-run");
  });
  const cases = [
    {
      expectedCode: "auxiliary_request_body_not_allowed",
      expectedStatus: 400,
      request: {
        body: Buffer.from("fixture-body"),
        headers: { "content-length": "12" },
        method: "GET",
        path: "/backend-api/codex/models",
      },
    },
    {
      expectedCode: "auxiliary_unsupported_media_type",
      expectedStatus: 415,
      request: {
        body: Buffer.from("fixture"),
        headers: { "content-type": "text/plain" },
        method: "POST",
        path: "/backend-api/codex/alpha/search",
      },
    },
    {
      expectedCode: "invalid_auxiliary_request",
      expectedStatus: 400,
      request: {
        body: Buffer.from("{"),
        headers: { "content-type": "application/json" },
        method: "POST",
        path: "/backend-api/codex/alpha/search",
      },
    },
    {
      expectedCode: "invalid_auxiliary_request",
      expectedStatus: 400,
      request: {
        body: Buffer.from('{"id":"fixture","input":[],"max_output_tokens":"128","model":"fixture"}'),
        headers: { "content-type": "application/json" },
        method: "POST",
        path: "/backend-api/codex/alpha/search",
      },
    },
  ];
  for (const fixtureCase of cases) {
    const result = await rawRequest(origin, fixtureCase.request);
    assert.equal(result.statusCode, fixtureCase.expectedStatus);
    assert.deepEqual(parseJsonBody(result), { error: fixtureCase.expectedCode });
  }
  const oversized = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/backend-api/codex/alpha/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        body: Buffer.concat(chunks),
        statusCode: response.statusCode,
      }));
    });
    request.once("error", reject);
    request.write("x".repeat(700));
    request.end("y".repeat(700));
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(parseJsonBody(oversized), { error: "request_body_too_large" });
  assert.equal(resolverCalls.length, 0);
});

test("buffers successful auxiliary responses and fails closed on invalid JSON", async (context) => {
  const privateCanary = "fixture-private-invalid-json";
  const { origin, releases } = await fixture(context, (request, response) => {
    request.resume();
    if (request.url.includes("invalid-content-type")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(privateCanary);
      return;
    }
    if (request.url.includes("oversized")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: "x".repeat(8_192) }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"partial":"${privateCanary}"`);
  });
  for (const [clientVersion, expectedError] of [
    ["invalid-content-type", "invalid_auxiliary_response"],
    ["invalid-json", "invalid_auxiliary_response"],
    ["oversized", "upstream_response_too_large"],
  ]) {
    const result = await fetch(
      `${origin}/backend-api/codex/models?client_version=${clientVersion}`,
    );
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: expectedError });
  }
  assert.deepEqual(releases, ["codex_models", "codex_models", "codex_models"]);
});

test("keeps both observed auxiliary endpoints compatible when failover mode is enabled", async (context) => {
  const requestBodies = [];
  const { origin, releases, resolverCalls } = await fixture(context, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBodies.push({ path: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url.includes("/models")
      ? '{"models":[]}'
      : '{"results":[]}');
  }, {
    failoverStateMachine: createFailoverStateMachine({
      maxAttempts: 1,
      totalDeadlineMs: 1_000,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    }),
  });
  const models = await fetch(`${origin}/backend-api/codex/models?client_version=0.144.2`);
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { models: [] });

  const searchBody = JSON.stringify({
    id: "fixture-search",
    input: [],
    max_output_tokens: 32,
    model: "fixture-model",
  });
  const search = await fetch(`${origin}/backend-api/codex/alpha/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: searchBody,
  });
  assert.equal(search.status, 200);
  assert.deepEqual(await search.json(), { results: [] });
  assert.deepEqual(requestBodies, [
    { path: "/backend-api/codex/models?client_version=0.144.2", body: "" },
    { path: "/backend-api/codex/alpha/search", body: searchBody },
  ]);
  assert.deepEqual(resolverCalls.map((route) => route.route_id), ["codex_models", "codex_search"]);
  assert.deepEqual(releases, ["codex_models", "codex_search"]);
});

test("returns explicit errors for every unsupported auxiliary route variant before resolution", async (context) => {
  const { origin, resolverCalls } = await fixture(context, (_request, response) => {
    response.end("must-not-run");
  });
  const cases = [
    {
      method: "GET",
      path: "/backend-api/codex/memory",
      statusCode: 404,
      expectedBody: { error: "route_not_allowed", status_code: 404, allowed_methods: [] },
    },
    {
      method: "GET",
      path: "/backend-api/codex/alpha/search",
      statusCode: 405,
      allow: "POST",
      expectedBody: { error: "method_not_allowed", status_code: 405, allowed_methods: ["POST"] },
    },
    {
      method: "POST",
      path: "/backend-api/codex/alpha/search?client_version=0.144.2",
      statusCode: 400,
      expectedBody: { error: "query_not_allowed", status_code: 400, allowed_methods: [] },
    },
    {
      method: "GET",
      path: "/backend-api/codex/responses",
      statusCode: 426,
      allow: "GET",
      expectedBody: { error: "websocket_required", status_code: 426, allowed_methods: ["GET"] },
    },
  ];
  for (const fixtureCase of cases) {
    const result = await rawRequest(origin, {
      method: fixtureCase.method,
      path: fixtureCase.path,
    });
    assert.equal(result.statusCode, fixtureCase.statusCode);
    assert.deepEqual(parseJsonBody(result), fixtureCase.expectedBody);
    if (fixtureCase.allow) assert.equal(result.headers.allow, fixtureCase.allow);
  }
  assert.equal(resolverCalls.length, 0);
});
