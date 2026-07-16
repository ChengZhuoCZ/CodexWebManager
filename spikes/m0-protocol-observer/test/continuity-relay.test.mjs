import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContinuityRelay } from "../src/continuity-relay.mjs";
import {
  createTextMessageAssembler,
  createWebSocketFrameParser,
  encodeWebSocketFrame,
  isSemanticResponseEvent,
} from "../src/websocket-frames.mjs";

const nodeListen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

const nodeClose = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function createMockUpstream() {
  const sockets = new Set();
  const connections = [];
  const messages = [];
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const authorization = request.headers.authorization;
    const alias =
      authorization === "Bearer fixture-auth-a"
        ? "account-a"
        : authorization === "Bearer fixture-auth-b"
          ? "account-b"
          : "unknown";
    connections.push(alias);
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    const assembler = createTextMessageAssembler((rawText) => {
      const message = JSON.parse(rawText);
      messages.push({
        alias,
        previous_response_id_present: Object.hasOwn(message, "previous_response_id"),
      });
      const ordinal = messages.length;
      for (const event of [
        { type: "response.created", id: `fixture-response-${ordinal}` },
        { type: "response.output_text.delta", delta: "fixture-output-canary" },
        { type: "response.completed", response: { id: `fixture-response-${ordinal}` } },
      ]) {
        socket.write(encodeWebSocketFrame(JSON.stringify(event), { masked: false }));
      }
    });
    const parser = createWebSocketFrameParser({
      expectMasked: true,
      onFrame(frame) {
        if (frame.opcode === 0x9) {
          socket.write(encodeWebSocketFrame(frame.payload, { opcode: 0xa, masked: false }));
          return;
        }
        assembler(frame);
      },
    });
    socket.on("data", (chunk) => parser.push(chunk));
  });

  return {
    server,
    sockets,
    connections,
    messages,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await nodeClose(server);
    },
  };
}

function openWebSocket(url) {
  const webSocket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    webSocket.addEventListener("open", () => resolve(webSocket), { once: true });
    webSocket.addEventListener("error", reject, { once: true });
  });
}

function sendAndWaitForEvent(webSocket, message, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expectedType}`)), 5_000);
    const onMessage = (event) => {
      const parsed = JSON.parse(String(event.data));
      if (parsed.type === expectedType) {
        clearTimeout(timeout);
        webSocket.removeEventListener("message", onMessage);
        resolve(parsed);
      }
    };
    webSocket.addEventListener("message", onMessage);
    webSocket.send(JSON.stringify(message));
  });
}

function waitForClose(webSocket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for WebSocket close")), 5_000);
    webSocket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

async function primeIdentity(relay, alias, authorization, accountId) {
  const response = await fetch(
    `http://127.0.0.1:${relay.address.port}/${alias}/backend-api/codex/models`,
    {
      headers: {
        authorization,
        "chatgpt-account-id": accountId,
      },
    },
  );
  assert.equal(response.status, 200);
  await response.text();
}

async function createFixture(routePlan) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "m0-continuity-relay-"));
  const logPath = path.join(temporaryDirectory, "relay-redacted.jsonl");
  const upstream = createMockUpstream();
  await nodeListen(upstream.server);
  const upstreamAddress = upstream.server.address();
  assert.equal(typeof upstreamAddress, "object");
  const relay = await createContinuityRelay({
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    logPath,
    routePlan,
  });

  return {
    temporaryDirectory,
    logPath,
    upstream,
    relay,
    async primeBoth() {
      await primeIdentity(relay, "account-a", "Bearer fixture-auth-a", "fixture-account-a");
      await primeIdentity(relay, "account-b", "Bearer fixture-auth-b", "fixture-account-b");
    },
    async close() {
      await relay.close();
      await upstream.close();
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

test("WebSocket frame codec handles masking, extended lengths, and semantic boundaries", () => {
  for (const length of [5, 126, 70_000]) {
    const payload = Buffer.alloc(length, 0x61);
    let parsed;
    const parser = createWebSocketFrameParser({
      expectMasked: true,
      maxPayloadBytes: 100_000,
      onFrame(frame) {
        parsed = frame;
      },
    });
    parser.push(encodeWebSocketFrame(payload, { masked: true }));
    assert.deepEqual(parsed.payload, payload);
  }
  assert.equal(isSemanticResponseEvent("response.created"), false);
  assert.equal(isSemanticResponseEvent("response.output_text.delta"), true);
  assert.equal(isSemanticResponseEvent("response.function_call_arguments.delta"), true);
});

test("routes consecutive response.create messages A-to-B without logging values", async (context) => {
  const fixture = await createFixture([
    { accountAlias: "account-a" },
    { accountAlias: "account-b" },
  ]);
  context.after(() => fixture.close());
  await fixture.primeBoth();

  assert.deepEqual(fixture.relay.identityStatus(), {
    account_a_captured: true,
    account_b_captured: true,
    distinct: true,
  });
  const webSocket = await openWebSocket(
    `ws://127.0.0.1:${fixture.relay.address.port}/account-a/backend-api/codex/responses`,
  );
  await sendAndWaitForEvent(
    webSocket,
    { type: "response.create", input: "fixture-user-content" },
    "response.completed",
  );
  await sendAndWaitForEvent(
    webSocket,
    {
      type: "response.create",
      previous_response_id: "fixture-previous-response-id",
      input: "fixture-user-content",
    },
    "response.completed",
  );
  webSocket.close();
  await fixture.relay.flush();

  assert.deepEqual(
    fixture.upstream.messages.map(({ alias, previous_response_id_present }) => ({
      alias,
      previous_response_id_present,
    })),
    [
      { alias: "account-a", previous_response_id_present: false },
      { alias: "account-b", previous_response_id_present: true },
    ],
  );
  const log = await fs.readFile(fixture.logPath, "utf8");
  for (const forbidden of [
    "fixture-auth-a",
    "fixture-auth-b",
    "fixture-account-a",
    "fixture-account-b",
    "fixture-user-content",
    "fixture-previous-response-id",
    "fixture-output-canary",
  ]) {
    assert.doesNotMatch(log, new RegExp(forbidden));
  }
  assert.match(log, /"account_alias":"account-b"/);
  assert.match(log, /"previous_response_id_present_after":true/);
});

test("can remove previous_response_id before forwarding", async (context) => {
  const fixture = await createFixture([
    { accountAlias: "account-b", omitPreviousResponseId: true },
  ]);
  context.after(() => fixture.close());
  await fixture.primeBoth();
  const webSocket = await openWebSocket(
    `ws://127.0.0.1:${fixture.relay.address.port}/account-a/backend-api/codex/responses`,
  );
  await sendAndWaitForEvent(
    webSocket,
    {
      type: "response.create",
      previous_response_id: "fixture-previous-response-id",
      input: "fixture-user-content",
    },
    "response.completed",
  );
  webSocket.close();
  assert.deepEqual(fixture.upstream.messages, [
    { alias: "account-b", previous_response_id_present: false },
  ]);
});

test("replays only a pre-semantic injected failure on the fallback account", async (context) => {
  const fixture = await createFixture([
    {
      accountAlias: "account-a",
      injectFailureBeforeSemantic: true,
      fallbackAlias: "account-b",
    },
  ]);
  context.after(() => fixture.close());
  await fixture.primeBoth();
  const webSocket = await openWebSocket(
    `ws://127.0.0.1:${fixture.relay.address.port}/account-a/backend-api/codex/responses`,
  );
  await sendAndWaitForEvent(
    webSocket,
    { type: "response.create", input: "fixture-user-content" },
    "response.completed",
  );
  webSocket.close();
  assert.deepEqual(fixture.upstream.connections, ["account-a", "account-b"]);
  assert.deepEqual(fixture.upstream.messages, [
    { alias: "account-b", previous_response_id_present: false },
  ]);
  await fixture.relay.flush();
  const log = await fs.readFile(fixture.logPath, "utf8");
  assert.match(log, /"boundary":"before_first_semantic_event"/);
  assert.match(log, /"replay_allowed":true/);
});

test("blocks replay after the first semantic event", async (context) => {
  const fixture = await createFixture([
    { accountAlias: "account-a", cutAfterSemantic: true },
  ]);
  context.after(() => fixture.close());
  await fixture.primeBoth();

  const firstSocket = await openWebSocket(
    `ws://127.0.0.1:${fixture.relay.address.port}/account-a/backend-api/codex/responses`,
  );
  const firstClosed = waitForClose(firstSocket);
  firstSocket.send(JSON.stringify({ type: "response.create", input: "fixture-user-content" }));
  await firstClosed;
  assert.equal(fixture.upstream.messages.length, 1);

  const secondSocket = await openWebSocket(
    `ws://127.0.0.1:${fixture.relay.address.port}/account-a/backend-api/codex/responses`,
  );
  const secondClosed = waitForClose(secondSocket);
  secondSocket.send(JSON.stringify({ type: "response.create", input: "fixture-user-content" }));
  await secondClosed;
  assert.equal(fixture.upstream.messages.length, 1);

  await fixture.relay.flush();
  const log = await fs.readFile(fixture.logPath, "utf8");
  assert.match(log, /"boundary":"after_first_semantic_event"/);
  assert.match(log, /"replay_allowed":false/);
  assert.match(log, /"kind":"replay_blocked"/);
});

test("rejects non-loopback binds and non-allowlisted paths", async () => {
  await assert.rejects(
    createContinuityRelay({
      upstreamOrigin: "http://127.0.0.1:1",
      logPath: path.join(os.tmpdir(), "unused-continuity-relay.jsonl"),
      host: "0.0.0.0",
    }),
    /must bind to 127\.0\.0\.1/,
  );
});
