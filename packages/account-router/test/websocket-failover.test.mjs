import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createFailoverStateMachine } from "../src/failover-state-machine.mjs";
import { createModelProxyService } from "../src/model-service.mjs";
import { createProxyHandler } from "../src/proxy-handler.mjs";
import {
  createTextMessageAssembler,
  createWebSocketFrameParser,
  encodeWebSocketFrame,
} from "../src/websocket-frames.mjs";

function acceptFor(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address();
}

async function close(server, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(() => resolve()));
}

function createUpstream(onMessage, onUpgrade = null) {
  const sockets = new Set();
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (onUpgrade?.(request, socket) === true) {
      return;
    }
    const key = request.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
    );
    const assemble = createTextMessageAssembler({
      onMessage(payload) { onMessage(JSON.parse(payload.toString("utf8")), socket, request); },
    });
    const parser = createWebSocketFrameParser({
      expectMasked: true,
      onFrame(frame) { assemble(frame); },
    });
    socket.on("data", (chunk) => parser.push(chunk));
    if (head.length > 0) parser.push(head);
  });
  return { server, sockets };
}

function sendEvent(socket, message) {
  socket.write(encodeWebSocketFrame(JSON.stringify(message), { opcode: 0x1 }));
}

function sendCompleted(socket, text = "fixture") {
  sendEvent(socket, { type: "response.created" });
  sendEvent(socket, { type: "response.output_text.delta", delta: text });
  sendEvent(socket, { type: "response.completed" });
}

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(marker);
      if (index !== -1) {
        cleanup();
        resolve({
          before: buffer.subarray(0, index + marker.length),
          after: buffer.subarray(index + marker.length),
        });
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function collectMessages(socket, initial = Buffer.alloc(0)) {
  const messages = [];
  const events = new EventEmitter();
  const assemble = createTextMessageAssembler({
    onMessage(payload) {
      const message = JSON.parse(payload.toString("utf8"));
      messages.push(message);
      events.emit("message", message);
    },
  });
  const parser = createWebSocketFrameParser({
    expectMasked: false,
    onFrame(frame) { assemble(frame); },
  });
  socket.on("data", (chunk) => parser.push(chunk));
  if (initial.length > 0) parser.push(initial);
  return {
    messages,
    async waitFor(predicate, timeoutMs = 2_000) {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          events.off("message", onMessage);
        };
        const onMessage = (message) => {
          if (!predicate(message)) return;
          cleanup();
          resolve(message);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("timed out waiting for WebSocket message"));
        }, timeoutMs);
        events.on("message", onMessage);
      });
    },
  };
}

async function fixture(context, accountListeners, options = {}) {
  const {
    upstreamUpgradeHandlers = {},
    ...proxyOptions
  } = options;
  const origins = new Map();
  for (const [accountId, listener] of Object.entries(accountListeners)) {
    const upstream = createUpstream(
      listener,
      upstreamUpgradeHandlers[accountId] ?? null,
    );
    context.after(() => close(upstream.server, upstream.sockets));
    const address = await listen(upstream.server);
    origins.set(accountId, `http://127.0.0.1:${address.port}`);
  }
  const accounts = [...origins.keys()];
  const resolverCalls = [];
  const releases = [];
  const proxyHandler = createProxyHandler({
    failoverStateMachine: createFailoverStateMachine({
      maxAttempts: 3,
      totalDeadlineMs: 2_000,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
    }),
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
    upstreamHeadersTimeoutMs: 500,
    requestTotalTimeoutMs: 2_000,
    ...proxyOptions,
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();

  const client = net.connect(address.port, "127.0.0.1");
  client.on("error", () => undefined);
  context.after(() => client.destroy());
  await once(client, "connect");
  const key = Buffer.from("0123456789abcdef").toString("base64");
  client.write(
    "GET /backend-api/codex/responses HTTP/1.1\r\n" +
    `Host: 127.0.0.1:${address.port}\r\n` +
    "Connection: Upgrade\r\n" +
    "Upgrade: websocket\r\n" +
    `Sec-WebSocket-Key: ${key}\r\n` +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  const handshake = await readUntil(client, Buffer.from("\r\n\r\n"));
  const handshakeText = handshake.before.toString("latin1");
  assert.match(handshakeText, /^HTTP\/1\.1 101/);
  assert.ok(handshakeText.includes(acceptFor(key)));
  const collector = collectMessages(client, handshake.after);
  return { client, collector, releases, resolverCalls };
}

function sendCreate(client, extra = {}) {
  client.write(encodeWebSocketFrame(
    JSON.stringify({ type: "response.create", input: [], ...extra }),
    { masked: true, opcode: 0x1 },
  ));
}

test("publishes only a sanitized weekly quota observation from WebSocket events", async (context) => {
  const observations = [];
  const { client, collector } = await fixture(context, {
    A(_message, socket) {
      sendEvent(socket, {
        type: "codex.rate_limits",
        rate_limits: {
          secondary: {
            used_percent: 40,
            window_minutes: 10_080,
            reset_at: 1_785_196_800,
          },
        },
        credits: { balance: "must-not-pass" },
      });
      sendCompleted(socket, "fixture");
    },
  }, {
    quotaNow: () => Date.parse("2026-07-28T00:00:00.000Z"),
    onWeeklyQuotaObservation(value) { observations.push(value); },
  });
  sendCreate(client);
  await collector.waitFor((message) => message.type === "response.completed");
  assert.deepEqual(observations, [{
    accountId: "A",
    observation: {
      observed_at: "2026-07-28T00:00:00.000Z",
      five_hour: { status: "unavailable", reason: "unsupported" },
      weekly: {
        status: "available",
        remaining_ratio: 0.6,
        resets_at: "2026-07-28T00:00:00.000Z",
        confidence: "high",
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(observations), /credits|balance|must-not-pass/);
});

test("reconnects and replays an initial WebSocket request only before semantic output", async (context) => {
  const { client, collector, releases, resolverCalls } = await fixture(context, {
    A(_message, socket) {
      sendEvent(socket, { type: "response.created" });
      setImmediate(() => socket.destroy());
    },
    B(_message, socket) { sendCompleted(socket, "from-b"); },
  });
  sendCreate(client);
  try {
    await collector.waitFor((message) => message.type === "response.completed", 2_000);
  } catch (error) {
    client.destroy();
    throw new Error(
      `${error.message}; resolver=${JSON.stringify(resolverCalls)}; ` +
      `releases=${JSON.stringify(releases)}; messages=${JSON.stringify(collector.messages)}`,
    );
  }
  assert.equal(collector.messages.filter((message) => message.type === "response.created").length, 1);
  assert.equal(
    collector.messages.find((message) => message.type === "response.output_text.delta")?.delta,
    "from-b",
  );
  assert.deepEqual(resolverCalls, [[], ["A"]]);
  assert.deepEqual(releases, ["A", "B"]);
});

test("applies bounded Retry-After backoff to a pre-semantic WebSocket upgrade 429", async (context) => {
  const arrivalTimes = [];
  const failures = [];
  const { client, collector, resolverCalls } = await fixture(context, {
    A() {
      throw new Error("primary upgrade rejection must not reach a WebSocket message");
    },
    B(_message, socket) {
      arrivalTimes.push(Date.now());
      sendCompleted(socket, "retry-after-secondary");
    },
  }, {
    upstreamUpgradeHandlers: {
      A(_request, socket) {
        arrivalTimes.push(Date.now());
        socket.end(
          "HTTP/1.1 429 Too Many Requests\r\n" +
          "Connection: close\r\n" +
          "Retry-After: 1\r\n" +
          "Content-Length: 0\r\n\r\n",
        );
        return true;
      },
    },
    failoverStateMachine: createFailoverStateMachine({
      maxAttempts: 2,
      totalDeadlineMs: 1_000,
      baseBackoffMs: 20,
      maxBackoffMs: 200,
    }),
    async onAttemptFailure(failure) {
      failures.push(failure);
    },
  });
  sendCreate(client);
  await collector.waitFor(
    (message) => message.type === "response.completed",
    2_000,
  );
  assert.deepEqual(resolverCalls, [[], ["A"]]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "rate_limited");
  assert.equal(failures[0].retryAfterMs, 1_000);
  assert.equal(arrivalTimes.length, 2);
  assert.ok(arrivalTimes[1] - arrivalTimes[0] >= 150);
  assert.ok(arrivalTimes[1] - arrivalTimes[0] < 900);
});

test("emits unsafe_to_replay and never selects B after WebSocket semantic output", async (context) => {
  const semanticTransitions = [];
  const { client, collector, resolverCalls } = await fixture(context, {
    A(_message, socket) {
      sendEvent(socket, { type: "response.created" });
      sendEvent(socket, { type: "response.function_call_arguments.delta", delta: "fixture" });
      setImmediate(() => socket.destroy());
    },
    B(_message, socket) { sendCompleted(socket, "must-not-run"); },
  }, {
    onSemanticStreamStart() { semanticTransitions.push("start"); },
    onSemanticStreamEnd() { semanticTransitions.push("end"); },
  });
  sendCreate(client);
  const error = await collector.waitFor((message) => message.type === "error");
  assert.equal(error.error.type, "unsafe_to_replay");
  assert.equal(error.error.semantic_output, true);
  assert.ok(collector.messages.some((message) =>
    message.type === "response.function_call_arguments.delta"));
  assert.deepEqual(resolverCalls, [[]]);
  assert.deepEqual(semanticTransitions, ["start", "end"]);
});

test("keeps a continuation on its existing WebSocket and refuses replacement after failure", async (context) => {
  let requests = 0;
  const { client, collector, resolverCalls } = await fixture(context, {
    A(_message, socket) {
      requests += 1;
      if (requests === 1) {
        sendCompleted(socket, "first");
      } else {
        sendEvent(socket, { type: "response.created" });
        setImmediate(() => socket.destroy());
      }
    },
    B(_message, socket) { sendCompleted(socket, "must-not-run"); },
  });
  sendCreate(client);
  await collector.waitFor((message) => message.type === "response.completed");
  sendCreate(client, { previous_response_id: "fixture-prior" });
  const error = await collector.waitFor((message) => message.type === "error");
  assert.equal(error.error.type, "unsafe_to_replay");
  assert.equal(error.error.reason, "continuation_connection_not_portable");
  assert.equal(error.error.semantic_output, false);
  assert.equal(requests, 2);
  assert.deepEqual(resolverCalls, [[]]);
});

test("switches only for an explicitly classified WebSocket account failure", async (context) => {
  const { client, collector, resolverCalls } = await fixture(context, {
    A(_message, socket) {
      sendEvent(socket, { type: "error", error: { type: "rate_limit" } });
    },
    B(_message, socket) { sendCompleted(socket, "from-b"); },
  });
  sendCreate(client);
  await collector.waitFor((message) => message.type === "response.completed");
  assert.deepEqual(resolverCalls, [[], ["A"]]);
  assert.equal(collector.messages.some((message) => message.type === "error"), false);
});

test("forwards an unclassified response.failed instead of guessing that it is retryable", async (context) => {
  const { client, collector, resolverCalls } = await fixture(context, {
    A(_message, socket) {
      sendEvent(socket, { type: "response.created" });
      sendEvent(socket, { type: "response.failed", response: { error: { type: "fixture" } } });
    },
    B(_message, socket) { sendCompleted(socket, "must-not-run"); },
  });
  sendCreate(client);
  const failed = await collector.waitFor((message) => message.type === "response.failed");
  assert.equal(failed.response.error.type, "fixture");
  assert.deepEqual(resolverCalls, [[]]);
});
