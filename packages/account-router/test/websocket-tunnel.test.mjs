import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createModelProxyService } from "../src/model-service.mjs";
import { createProxyHandler } from "../src/proxy-handler.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address();
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(marker);
      if (index !== -1) {
        cleanup();
        resolve({
          before: buffer.subarray(0, index + marker.length),
          after: buffer.subarray(index + marker.length),
        });
      }
    }
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

test("tunnels the observed Codex WebSocket upgrade and raw bytes with filtered headers", async (context) => {
  let observedHeaders;
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  let leaseReleasedResolve;
  const leaseReleased = new Promise((resolve) => { leaseReleasedResolve = resolve; });
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket, head) => {
    observedHeaders = request.headers;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Accept: fixture-accept\r\n" +
      "Set-Cookie: fixture-private-cookie=hidden\r\n\r\n",
    );
    if (head.length > 0) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => undefined);
    socket.once("close", upstreamClosedResolve);
  });
  context.after(() => close(upstream));
  const upstreamAddress = await listen(upstream);

  const proxyHandler = createProxyHandler({
    resolveUpstream: async () => ({
      origin: `http://127.0.0.1:${upstreamAddress.port}`,
      headers: {
        authorization: "Bearer fixture-upstream-authorization",
        "chatgpt-account-id": "fixture-selected-account",
      },
      release: leaseReleasedResolve,
    }),
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();

  const client = net.connect(address.port, "127.0.0.1");
  context.after(() => client.destroy());
  await once(client, "connect");
  client.write(
    "GET /backend-api/codex/responses HTTP/1.1\r\n" +
    `Host: 127.0.0.1:${address.port}\r\n` +
    "Connection: Upgrade\r\n" +
    "Upgrade: websocket\r\n" +
    "Sec-WebSocket-Key: Zml4dHVyZS13ZWJzb2NrZXQta2V5\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Extensions: permessage-deflate\r\n" +
    "Authorization: Bearer fixture-client-credential\r\n\r\n",
  );
  const handshake = await readUntil(client, Buffer.from("\r\n\r\n"));
  const headerText = handshake.before.toString("latin1");
  assert.match(headerText, /^HTTP\/1\.1 101/);
  assert.match(headerText, /Sec-WebSocket-Accept: fixture-accept/i);
  assert.doesNotMatch(headerText, /set-cookie|fixture-private-cookie/i);
  assert.equal(observedHeaders.authorization, "Bearer fixture-upstream-authorization");
  assert.equal(observedHeaders["chatgpt-account-id"], "fixture-selected-account");
  assert.equal(observedHeaders["sec-websocket-extensions"], undefined);

  const payload = Buffer.from("fixture-raw-websocket-bytes");
  const echoPromise = new Promise((resolve, reject) => {
    function onData(chunk) {
      if (chunk.includes(payload)) {
        cleanup();
        resolve();
      }
    }
    function cleanup() {
      client.off("data", onData);
      client.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    client.on("data", onData);
    client.on("error", onError);
  });
  client.write(payload);
  await echoPromise;
  client.destroy();
  await Promise.race([
    leaseReleased,
    new Promise((_, reject) => setTimeout(() => reject(new Error("lease was not released")), 2_000)),
  ]);
  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("tunnel did not close")), 2_000)),
  ]);
});

test("rejects non-allowlisted upgrade paths before upstream resolution", async (context) => {
  let resolved = false;
  const proxyHandler = createProxyHandler({
    async resolveUpstream() {
      resolved = true;
      throw new Error("must not run");
    },
  });
  const service = createModelProxyService({ modelPort: 0, proxyHandler });
  context.after(() => service.stop());
  const address = await service.start();
  const client = net.connect(address.port, "127.0.0.1");
  context.after(() => client.destroy());
  await once(client, "connect");
  client.write(
    "GET /proxy HTTP/1.1\r\n" +
    `Host: 127.0.0.1:${address.port}\r\n` +
    "Connection: Upgrade\r\n" +
    "Upgrade: websocket\r\n" +
    "Sec-WebSocket-Key: Zml4dHVyZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  const response = await readUntil(client, Buffer.from("\r\n\r\n"));
  assert.match(response.before.toString("latin1"), /^HTTP\/1\.1 404/);
  assert.equal(resolved, false);
});
