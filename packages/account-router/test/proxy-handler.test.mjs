import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createModelProxyService } from "../src/model-service.mjs";
import { createProxyHandler } from "../src/proxy-handler.mjs";

const FIXTURE_UPSTREAM_AUTH = "Bearer fixture-upstream-authorization";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function fixture(context, upstreamListener, proxyOptions = {}) {
  const upstream = http.createServer(upstreamListener);
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const calls = [];
  const proxyHandler = createProxyHandler({
    async resolveUpstream(route) {
      calls.push(route);
      return {
        origin: upstreamOrigin,
        headers: {
          authorization: FIXTURE_UPSTREAM_AUTH,
          "chatgpt-account-id": "fixture-selected-account",
        },
      };
    },
    requestBodyLimitBytes: 1_024,
    responseBodyLimitBytes: 4 * 1024 * 1024,
    upstreamHeadersTimeoutMs: 2_000,
    requestTotalTimeoutMs: 5_000,
    ...proxyOptions,
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();
  return { calls, origin: `http://127.0.0.1:${address.port}`, upstream };
}

test("passes through a bounded non-streaming Responses request and filters credentials", async (context) => {
  let observed;
  const { origin, calls } = await fixture(context, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    observed = {
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      cookie: request.headers.cookie,
      clientSecret: request.headers["x-api-key"],
      body: Buffer.concat(chunks).toString("utf8"),
      path: request.url,
    };
    const body = JSON.stringify({ id: "fixture-response", ok: true });
    response.writeHead(201, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "set-cookie": "fixture-private-cookie=hidden",
      "x-request-id": "fixture-request-id",
      "x-upstream-private": "hidden",
    });
    response.end(body);
  });
  const body = JSON.stringify({ model: "fixture-model", input: "fixture-input" });
  const result = await fetch(`${origin}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-client-credential",
      cookie: "fixture-client-cookie=hidden",
      "content-type": "application/json",
      "x-api-key": "fixture-client-key",
      "x-client-request-id": "fixture-client-request",
    },
    body,
  });
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), { id: "fixture-response", ok: true });
  assert.equal(result.headers.get("x-request-id"), "fixture-request-id");
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("x-upstream-private"), null);
  assert.deepEqual(observed, {
    authorization: FIXTURE_UPSTREAM_AUTH,
    account: "fixture-selected-account",
    cookie: undefined,
    clientSecret: undefined,
    body,
    path: "/v1/responses",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route_id, "responses_http");
});

test("streams SSE incrementally in order without buffering the complete response", async (context) => {
  let releaseCompletion;
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve; });
  const { origin } = await fixture(context, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write("event: response.created\ndata: {}\n\n");
    await completionGate;
    response.write("event: response.output_text.delta\ndata: {\"delta\":\"fixture\"}\n\n");
    response.end("event: response.completed\ndata: {}\n\n");
  });

  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /response\.created/);
  releaseCompletion();
  let remainder = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    remainder += decoder.decode(next.value, { stream: true });
  }
  assert.match(remainder, /response\.output_text\.delta[\s\S]*response\.completed/);
});

test("propagates downstream backpressure while preserving every response byte", async (context) => {
  let backpressureSeen = false;
  let drainCount = 0;
  const chunks = 256;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const { origin } = await fixture(context, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    for (let index = 0; index < chunks; index += 1) {
      if (!response.write(chunk)) {
        backpressureSeen = true;
        drainCount += 1;
        await once(response, "drain");
      }
    }
    response.end();
  }, { responseBodyLimitBytes: 32 * 1024 * 1024 });

  const received = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    request.on("response", (response) => {
      let bytes = 0;
      response.pause();
      setTimeout(() => response.resume(), 30);
      response.on("data", (part) => { bytes += part.length; });
      response.on("end", () => resolve(bytes));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(received, chunks * chunk.length);
  assert.equal(backpressureSeen, true);
  assert.ok(drainCount > 0);
});

test("propagates client cancellation to an active upstream SSE response", async (context) => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  const { origin } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: response.created\ndata: {}\n\n");
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 10);
    response.once("close", () => {
      clearInterval(timer);
      upstreamClosedResolve();
    });
  });

  await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    request.on("response", (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    request.on("error", reject);
    request.end("{}");
  });
  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("upstream did not close")), 2_000)),
  ]);
});

test("rejects declared and chunked oversized request bodies with bounded errors", async (context) => {
  let upstreamRequests = 0;
  let upstreamBytes = 0;
  const { origin } = await fixture(context, async (request, response) => {
    upstreamRequests += 1;
    for await (const chunk of request) upstreamBytes += chunk.length;
    response.end("unexpected");
  }, { requestBodyLimitBytes: 32 });

  const declared = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(64),
  });
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).error, "request_body_too_large");
  assert.equal(upstreamRequests, 0);

  const chunkedStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
    });
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.write("x".repeat(24));
    request.end("y".repeat(24));
  });
  assert.equal(chunkedStatus, 413);
  assert.ok(upstreamBytes <= 32);
});

test("rejects oversized non-streaming upstream bodies but does not total-limit SSE", async (context) => {
  const { origin } = await fixture(context, (request, response) => {
    if (request.headers["x-client-request-id"] === "fixture-sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: fixture\ndata: ${"s".repeat(128)}\n\n`);
      return;
    }
    const body = Buffer.alloc(128, 0x61);
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": body.length,
    });
    response.end(body);
  }, { responseBodyLimitBytes: 64 });
  const response = await fetch(`${origin}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "upstream_response_too_large");

  const sse = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "x-client-request-id": "fixture-sse" },
    body: "{}",
  });
  assert.equal(sse.status, 200);
  assert.match(await sse.text(), /^event: fixture\ndata: s{128}\n\n$/);
});

test("fails closed before resolving an upstream for unallowlisted routes", async (context) => {
  const { origin, calls } = await fixture(context, (_request, response) => response.end("unexpected"));
  const response = await fetch(`${origin}/proxy?url=https://example.invalid`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "route_not_allowed");
  assert.equal(calls.length, 0);
});

test("releases an acquired lease when injected upstream headers are invalid", async (context) => {
  let released = 0;
  const proxyHandler = createProxyHandler({
    async resolveUpstream() {
      return {
        origin: "http://127.0.0.1:9",
        headers: { host: "forbidden.example" },
        release() { released += 1; },
      };
    },
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "upstream_unavailable");
  assert.equal(released, 1);
});
