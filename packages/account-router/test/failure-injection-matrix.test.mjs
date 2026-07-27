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

function successfulSse(response, marker) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
  response.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: marker,
    })}\n\n`,
  );
  response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
}

async function injectFailure(context, firstAccount, expectedKind) {
  const servers = [];
  const origins = new Map();
  for (const [accountId, listener] of Object.entries({
    A: firstAccount,
    B(_request, response) { successfulSse(response, `recovered-${expectedKind}`); },
  })) {
    const server = http.createServer(listener);
    servers.push(server);
    context.after(() => close(server));
    origins.set(accountId, await listen(server));
  }

  const resolverCalls = [];
  const failures = [];
  const releases = [];
  const accounts = [...origins.keys()];
  const proxyHandler = createProxyHandler({
    async resolveUpstream(_route, selection) {
      resolverCalls.push([...selection.excludeAccountIds]);
      const accountId = accounts.find((candidate) => !selection.excludeAccountIds.includes(candidate));
      if (!accountId) return null;
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
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"failure-matrix-fixture"}',
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(`recovered-${expectedKind}`));
  assert.deepEqual(resolverCalls, [[], ["A"]]);
  assert.deepEqual(releases, ["A", "B"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].accountId, "A");
  assert.equal(failures[0].kind, expectedKind);
  return failures[0];
}

test("failure matrix: quota exhaustion before semantic output fails over", async (context) => {
  await injectFailure(context, (_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"error":{"type":"quota_exhausted"}}');
  }, "quota_exhausted");
});

test("failure matrix: generic HTTP 429 is bounded and fails over", async (context) => {
  const failure = await injectFailure(context, (_request, response) => {
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "999999999",
    });
    response.end('{"error":{"type":"rate_limit"}}');
  }, "rate_limited");
  assert.equal(failure.retryAfterMs, 30 * 24 * 60 * 60_000);
});

test("failure matrix: authentication rejection before semantic output fails over", async (context) => {
  await injectFailure(context, (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":{"type":"invalid_auth"}}');
  }, "auth_expired");
});

test("failure matrix: network disconnect before headers fails over", async (context) => {
  await injectFailure(context, (request) => {
    request.socket.destroy();
  }, "network_error");
});

test("failure matrix: upstream 5xx before semantic output fails over", async (context) => {
  await injectFailure(context, (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":{"type":"fixture_unavailable"}}');
  }, "upstream_5xx");
});

test("failure matrix: truncated pre-semantic SSE is discarded before failover", async (context) => {
  await injectFailure(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
    response.end("data: {\"type\":\"response.output_text.delta\"");
  }, "network_error");
});
