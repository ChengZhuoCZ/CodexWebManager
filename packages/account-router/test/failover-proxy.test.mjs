import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createFailoverStateMachine } from "../src/failover-state-machine.mjs";
import { createModelProxyService } from "../src/model-service.mjs";
import { createProxyHandler } from "../src/proxy-handler.mjs";

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

async function fixture(context, listeners, options = {}) {
  const { onUpstreamServer = null, ...handlerOptions } = options;
  const origins = new Map();
  for (const [accountId, listener] of Object.entries(listeners)) {
    const server = http.createServer(listener);
    onUpstreamServer?.(accountId, server);
    context.after(() => close(server));
    origins.set(accountId, await listen(server));
  }
  const resolverCalls = [];
  const releases = [];
  const failures = [];
  const accounts = [...origins.keys()];
  const proxyHandler = createProxyHandler({
    async resolveUpstream(_route, selection = {}) {
      resolverCalls.push({
        attempt: selection.attempt,
        excluded: [...(selection.excludeAccountIds ?? [])],
      });
      const accountId = accounts.find((candidate) => !selection.excludeAccountIds?.includes(candidate));
      if (!accountId) throw new Error("no fixture account");
      return {
        accountId,
        origin: origins.get(accountId),
        headers: { "x-fixture-account": accountId },
        release() { releases.push(accountId); },
      };
    },
    failoverStateMachine: createFailoverStateMachine({
      maxAttempts: 3,
      totalDeadlineMs: 2_000,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
    }),
    async onAttemptFailure(failure) { failures.push(failure); },
    requestBodyLimitBytes: 1_024,
    responseBodyLimitBytes: 4_096,
    upstreamHeadersTimeoutMs: 500,
    requestTotalTimeoutMs: 2_000,
    ...handlerOptions,
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();
  return {
    failures,
    origin: `http://127.0.0.1:${address.port}`,
    releases,
    resolverCalls,
  };
}

test("reuses a completed upstream HTTP connection across sequential requests", async (context) => {
  let connectionCount = 0;
  const { origin } = await fixture(
    context,
    {
      A(_request, response) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      },
    },
    {
      onUpstreamServer(_accountId, server) {
        server.on("connection", () => {
          connectionCount += 1;
        });
      },
    },
  );

  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"fixture"}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }

  assert.equal(connectionCount, 1);
});

function completeSse(response, text = "fixture") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
  response.write(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${text}"}\n\n`);
  response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
}

test("publishes only a sanitized weekly quota observation from HTTP SSE", async (context) => {
  const observations = [];
  const { origin } = await fixture(context, {
    A(_request, response) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: codex.rate_limits\ndata: {"type":"codex.rate_limits","rate_limits":{"secondary":{"used_percent":25,"window_minutes":10080,"reset_at":1785196800}},"credits":{"balance":"must-not-pass"}}\n\n',
      );
      response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
    },
  }, {
    quotaNow: () => Date.parse("2026-07-28T00:00:00.000Z"),
    onWeeklyQuotaObservation(value) { observations.push(value); },
  });

  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(observations, [{
    accountId: "A",
    observation: {
      observed_at: "2026-07-28T00:00:00.000Z",
      five_hour: { status: "unavailable", reason: "unsupported" },
      weekly: {
        status: "available",
        remaining_ratio: 0.75,
        resets_at: "2026-07-28T00:00:00.000Z",
        confidence: "high",
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(observations), /credits|balance|must-not-pass/);
});

test("fails over a 429 before streaming and excludes the failed account", async (context) => {
  const requestBodies = [];
  const { origin, resolverCalls, releases, failures } = await fixture(context, {
    async A(request, response) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      response.end('{"error":{"type":"quota_exhausted"}}');
    },
    async B(request, response) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      completeSse(response);
    },
  });
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.output_text\.delta/);
  assert.doesNotMatch(body, /quota_exhausted/);
  assert.deepEqual(resolverCalls, [
    { attempt: 1, excluded: [] },
    { attempt: 2, excluded: ["A"] },
  ]);
  assert.deepEqual(releases, ["A", "B"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "quota_exhausted");
  assert.equal(failures[0].retryAfterMs, null);
  assert.deepEqual(requestBodies, ['{"input":"fixture"}', '{"input":"fixture"}']);
});

test("classifies rate limits separately and bounds a long Retry-After value", async (context) => {
  const { origin, failures } = await fixture(context, {
    A(_request, response) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "999999999" });
      response.end('{"error":{"type":"rate_limit"}}');
    },
    B(_request, response) { completeSse(response); },
  });
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "rate_limited");
  assert.equal(failures[0].retryAfterMs, 30 * 24 * 60 * 60_000);
});

test("discards preflight SSE from a failed account and emits one successful stream", async (context) => {
  const { origin, resolverCalls } = await fixture(context, {
    A(_request, response) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
      setImmediate(() => response.destroy());
    },
    B(_request, response) { completeSse(response, "from-b"); },
  });
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.match(/event: response\.created/g)?.length, 1);
  assert.match(body, /from-b/);
  assert.equal(resolverCalls.length, 2);
});

test("returns an in-stream unsafe_to_replay error after a semantic SSE event", async (context) => {
  const { origin, resolverCalls } = await fixture(context, {
    A(_request, response) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
      response.write("event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"fixture\"}\n\n");
      setImmediate(() => response.destroy());
    },
    B(_request, response) { completeSse(response, "must-not-run"); },
  });
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /response\.function_call_arguments\.delta/);
  assert.match(body, /event: error[\s\S]*unsafe_to_replay/);
  assert.equal(resolverCalls.length, 1);
});

test("does not replay a continuation body even before semantic output", async (context) => {
  const { origin, resolverCalls } = await fixture(context, {
    A(_request, response) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
      setImmediate(() => response.destroy());
    },
    B(_request, response) { completeSse(response, "must-not-run"); },
  });
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"previous_response_id":"fixture-prior","input":"fixture"}',
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      type: "unsafe_to_replay",
      reason: "continuation_connection_not_portable",
      attempts: 1,
      semantic_output: false,
    },
  });
  assert.equal(resolverCalls.length, 1);
});

test("bounds all-account exhaustion and retries non-streaming 5xx safely", async (context) => {
  const exhausted = await fixture(context, {
    A(_request, response) { response.writeHead(429).end(); },
    B(_request, response) { response.writeHead(429).end(); },
    C(_request, response) { response.writeHead(429).end(); },
  });
  const exhaustedResponse = await fetch(`${exhausted.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(exhaustedResponse.status, 503);
  const exhaustedBody = await exhaustedResponse.json();
  assert.equal(exhaustedBody.error.type, "all_accounts_unavailable");
  assert.equal(exhaustedBody.error.attempts, 3);
  assert.equal(exhausted.resolverCalls.length, 3);

  const recovered = await fixture(context, {
    A(_request, response) { response.writeHead(503).end("fixture unavailable"); },
    B(_request, response) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"ok":true}');
    },
  });
  const recoveredResponse = await fetch(`${recovered.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(recoveredResponse.status, 201);
  assert.deepEqual(await recoveredResponse.json(), { ok: true });
  assert.equal(recovered.resolverCalls.length, 2);
});

test("rejects a chunked oversized replay body before selecting any account", async (context) => {
  const scoped = await fixture(context, {
    A(_request, response) { response.end("must-not-run"); },
  });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(`${scoped.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        statusCode: response.statusCode,
      }));
    });
    request.once("error", reject);
    request.write("x".repeat(700));
    request.end("y".repeat(700));
  });
  assert.equal(result.statusCode, 413);
  assert.equal(JSON.parse(result.body).error, "request_body_too_large");
  assert.equal(scoped.resolverCalls.length, 0);
});
