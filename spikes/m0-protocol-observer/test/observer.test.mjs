import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createObserver } from "../src/observer.mjs";
import { describeJsonShape, describeUrl, sanitizePath } from "../src/shape.mjs";

const nodeListen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

const nodeClose = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

function websocketTextFrame(value) {
  const payload = Buffer.from(value, "utf8");
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

test("describes protocol fields without persisting values", () => {
  const canary = "fixture-sensitive-user-content";
  const shape = describeJsonShape({
    model: "fixture-model",
    input: [{ role: "user", content: [{ type: "input_text", text: canary }] }],
    metadata: { [canary]: canary },
  });
  const serialized = JSON.stringify(shape);

  assert.match(serialized, /\$\.model/);
  assert.match(serialized, /\$\.input\[\]\.content\[\]\.text/);
  assert.match(serialized, /unknown_field_/);
  assert.doesNotMatch(serialized, new RegExp(canary));
});

test("redacts dynamic path identifiers and query values", () => {
  assert.equal(sanitizePath("/v1/responses/resp_12345678901234567890"), "/v1/responses/:id");
  assert.deepEqual(describeUrl("/v1/models?client_version=fixture-secret&limit=20"), {
    path: "/v1/models",
    query_keys: ["client_version", "limit"],
  });
});

test("proxies fixtures while logging only request and SSE shape", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "m0-observer-test-"));
  const logPath = path.join(temporaryDirectory, "protocol.jsonl");
  const userCanary = "fixture-sensitive-user-content";
  const authCanary = "fixture-auth-value";
  const cookieCanary = "fixture-cookie-value";
  const received = [];

  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    received.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    if (request.url?.startsWith("/v1/responses")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "response.created", id: userCanary })}\n\n`);
      response.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: userCanary })}\n\n`,
      );
      response.end(`data: ${JSON.stringify({ type: "response.completed" })}\n\n`);
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ fixture: userCanary }));
  });

  await nodeListen(upstream);
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  const observer = await createObserver({
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    logPath,
  });

  context.after(async () => {
    await observer.close();
    await nodeClose(upstream);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const authorization = ["Bearer", authCanary].join(" ");
  const response = await fetch(`http://127.0.0.1:${observer.address.port}/v1/responses`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      authorization,
      "content-type": "application/json",
      cookie: cookieCanary,
    },
    body: JSON.stringify({
      model: "fixture-model",
      input: [{ role: "user", content: [{ type: "input_text", text: userCanary }] }],
      stream: true,
    }),
  });
  await response.text();
  await observer.flush();

  assert.equal(received[0].authorization, authorization);
  assert.equal(received[0].cookie, cookieCanary);
  assert.match(received[0].body, new RegExp(userCanary));

  const log = await fs.readFile(logPath, "utf8");
  assert.doesNotMatch(log, new RegExp(userCanary));
  assert.doesNotMatch(log, new RegExp(authCanary));
  assert.doesNotMatch(log, new RegExp(cookieCanary));
  assert.match(log, /"path":"\/v1\/responses"/);
  assert.match(log, /"sensitive_header_names_present":\["authorization","cookie"\]/);
  assert.match(log, /"path":"\$\.previous_response_id"|"path":"\$\.input/);
  assert.match(log, /"event_type":"response.created"/);
  assert.match(log, /"event_type":"response.output_text.delta"/);
  assert.match(log, /"event_type":"response.completed"/);

  for (const endpoint of [
    ["GET", "/v1/models?client_version=fixture-value"],
    ["POST", "/v1/responses/compact"],
    ["GET", "/memory/list?cursor=fixture-value"],
    ["POST", "/search"],
  ]) {
    const syntheticResponse = await fetch(
      `http://127.0.0.1:${observer.address.port}${endpoint[1]}`,
      {
        method: endpoint[0],
        headers: endpoint[0] === "POST" ? { "content-type": "application/json" } : {},
        body: endpoint[0] === "POST" ? JSON.stringify({ input: userCanary }) : undefined,
      },
    );
    await syntheticResponse.text();
  }
  await observer.flush();

  const expandedLog = await fs.readFile(logPath, "utf8");
  assert.doesNotMatch(expandedLog, new RegExp(userCanary));
  assert.match(expandedLog, /"path":"\/v1\/models"/);
  assert.match(expandedLog, /"path":"\/v1\/responses\/compact"/);
  assert.match(expandedLog, /"path":"\/memory\/list"/);
  assert.match(expandedLog, /"path":"\/search"/);
});

test("rejects non-loopback bind hosts and credential-bearing upstream URLs", async () => {
  await assert.rejects(
    createObserver({
      upstreamOrigin: "http://127.0.0.1:1",
      logPath: path.join(os.tmpdir(), "unused-observer.log"),
      host: "0.0.0.0",
    }),
    /must bind to 127\.0\.0\.1/,
  );

  await assert.rejects(
    createObserver({
      upstreamOrigin: "https://user:password@example.test",
      logPath: path.join(os.tmpdir(), "unused-observer.log"),
    }),
    /without credentials/,
  );
});

test("proxies WebSocket Responses while logging frame shape only", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "m0-observer-ws-test-"));
  const logPath = path.join(temporaryDirectory, "protocol.jsonl");
  const canary = "fixture-websocket-sensitive-content";
  const upstreamSockets = new Set();
  const upstream = http.createServer();

  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  upstream.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    socket.once("data", () => {
      socket.write(
        websocketTextFrame(JSON.stringify({ type: "response.created", payload: canary })),
      );
    });
  });

  await nodeListen(upstream);
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  const observer = await createObserver({
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    logPath,
  });

  context.after(async () => {
    await observer.close();
    for (const socket of upstreamSockets) {
      socket.destroy();
    }
    await nodeClose(upstream);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const webSocket = new WebSocket(
    `ws://127.0.0.1:${observer.address.port}/backend-api/codex/responses`,
  );
  await new Promise((resolve, reject) => {
    webSocket.addEventListener("open", resolve, { once: true });
    webSocket.addEventListener("error", reject, { once: true });
  });
  webSocket.send(
    JSON.stringify({
      type: "response.create",
      response: { input: [{ role: "user", content: canary }] },
    }),
  );
  await new Promise((resolve, reject) => {
    webSocket.addEventListener("message", resolve, { once: true });
    webSocket.addEventListener("error", reject, { once: true });
  });
  webSocket.close();
  await observer.flush();

  const log = await fs.readFile(logPath, "utf8");
  assert.doesNotMatch(log, new RegExp(canary));
  assert.match(log, /"kind":"websocket_upgrade_request"/);
  assert.match(log, /"path":"\/backend-api\/codex\/responses"/);
  assert.match(log, /"kind":"websocket_message_shape"/);
  assert.match(log, /"message_type":"response.create"/);
  assert.match(log, /"kind":"websocket_event"/);
  assert.match(log, /"event_type":"response.created"/);
});
