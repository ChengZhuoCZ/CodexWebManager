import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPrivateFileTokenConsumer,
  createStatusBridge,
  StatusBridgeError,
} from "../src/status-bridge.mjs";

const ADMIN_TOKEN = "fixture-admin-token-0123456789";

function safeStatus(extra = {}) {
  return {
    status: "ready",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: 0,
    current_route: {
      account_alias: "Fixture A",
      continuity: "new_backend_session",
      internal_id: "must-not-pass",
    },
    accounts: [
      {
        alias: "Fixture A",
        state: "healthy",
        enabled: true,
        five_hour_remaining_ratio: 0.75,
        weekly_remaining_ratio: null,
        snapshot_observed_at: "2026-07-16T00:00:00.000Z",
        cooldown_until: null,
        last_switch_reason: "startup",
        credential_ref: "must-not-pass",
      },
    ],
    token: "must-not-pass",
    ...extra,
  };
}

function tokenConsumer(token = ADMIN_TOKEN) {
  return async (callback) => callback(token);
}

test("is inert when no router bridge configuration is present", async () => {
  let requests = 0;
  const bridge = createStatusBridge({
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(bridge.enabled, false);
  assert.deepEqual(await bridge.getStatus(), { enabled: false });
  assert.equal(requests, 0);
  await assert.rejects(
    bridge.followEvents({ onEvent() {} }),
    (error) => error instanceof StatusBridgeError && error.code === "bridge_disabled",
  );
});

test("requires a complete, exact-loopback bridge configuration", () => {
  for (const adminOrigin of [
    "https://127.0.0.1:18318",
    "http://example.test:18318",
    "http://0.0.0.0:18318",
    "http://127.0.0.1:18318/v1",
    "http://user:password@127.0.0.1:18318",
    "http://127.0.0.1",
  ]) {
    assert.throws(
      () => createStatusBridge({ adminOrigin, withAdminToken: tokenConsumer() }),
      /bridge configuration is invalid/,
    );
  }
  assert.throws(
    () => createStatusBridge({ adminOrigin: "http://127.0.0.1:18318" }),
    /bridge configuration is incomplete/,
  );
  assert.throws(
    () => createStatusBridge({ withAdminToken: tokenConsumer() }),
    /bridge configuration is incomplete/,
  );
});

test("fetches status with the admin token server-side and returns an exact whitelist", async () => {
  let observedAuthorization = null;
  const bridge = createStatusBridge({
    adminOrigin: "http://127.0.0.1:18318",
    withAdminToken: tokenConsumer(),
    async fetchImpl(url, options) {
      assert.equal(url, "http://127.0.0.1:18318/v1/status");
      observedAuthorization = options.headers.authorization;
      return new Response(JSON.stringify(safeStatus()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await bridge.getStatus();
  assert.equal(observedAuthorization, `Bearer ${ADMIN_TOKEN}`);
  assert.deepEqual(result, {
    enabled: true,
    router: {
      status: "ready",
      architecture_mode: "LIMITED_MODE",
      cross_account_e2e_verified: false,
      active_streams: 0,
      current_route: {
        account_alias: "Fixture A",
        continuity: "new_backend_session",
      },
      accounts: [
        {
          alias: "Fixture A",
          state: "healthy",
          enabled: true,
          five_hour_remaining_ratio: 0.75,
          weekly_remaining_ratio: null,
          snapshot_observed_at: "2026-07-16T00:00:00.000Z",
          cooldown_until: null,
          last_switch_reason: "startup",
        },
      ],
    },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /must-not-pass|credential_ref|internal_id|token/i);
  assert.doesNotMatch(serialized, new RegExp(ADMIN_TOKEN));
});

test("fails closed with stable errors for invalid, oversized, or slow status responses", async () => {
  const cases = [
    async () => new Response("{}", { status: 401 }),
    async () => new Response("not-json", { status: 200 }),
    async () => new Response(JSON.stringify(safeStatus({ active_streams: -1 })), { status: 200 }),
    async () => new Response("x".repeat(1_025), { status: 200 }),
    async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ];

  for (const [index, fetchImpl] of cases.entries()) {
    const bridge = createStatusBridge({
      adminOrigin: "http://127.0.0.1:18318",
      withAdminToken: tokenConsumer(),
      fetchImpl,
      requestTimeoutMs: 20,
      maxStatusBytes: 1_024,
    });
    await assert.rejects(bridge.getStatus(), (error) => {
      assert.ok(error instanceof StatusBridgeError, `case ${index}`);
      assert.equal(error.code, "router_status_unavailable", `case ${index}`);
      assert.doesNotMatch(error.message, new RegExp(ADMIN_TOKEN));
      return true;
    });
  }
});

test("sanitizes the switch-event stream and propagates cancellation", async () => {
  const stream = [
    ": connected",
    "",
    "id: 7",
    "event: router.switch",
    `data: ${JSON.stringify({
      from_alias: null,
      to_alias: "Fixture A",
      reason: "manual",
      continuity: "new_backend_session",
      architecture_mode: "LIMITED_MODE",
      credential_ref: "must-not-pass",
      timestamp: "2026-07-16T00:00:01.000Z",
      token: "must-not-pass",
    })}`,
    "",
    "",
  ].join("\n");
  let observedCursor = null;
  const bridge = createStatusBridge({
    adminOrigin: "http://127.0.0.1:18318",
    withAdminToken: tokenConsumer(),
    async fetchImpl(url, options) {
      assert.equal(url, "http://127.0.0.1:18318/v1/events");
      observedCursor = options.headers["last-event-id"];
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
  const events = [];
  await bridge.followEvents({ afterId: "6", onEvent: (event) => events.push(event) });

  assert.equal(observedCursor, "6");
  assert.deepEqual(events, [
    {
      id: "7",
      type: "router.switch",
      data: {
        from_alias: null,
        to_alias: "Fixture A",
        reason: "manual",
        continuity: "new_backend_session",
        architecture_mode: "LIMITED_MODE",
        timestamp: "2026-07-16T00:00:01.000Z",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /must-not-pass|credential_ref|token/i);
});

test("rejects malformed cursors, event types, fields, and oversized frames", async () => {
  const streams = [
    "id: 1\nevent: account.secret\ndata: {}\n\n",
    "id: 1\nevent: router.switch\ndata: not-json\n\n",
    `id: 1\nevent: router.switch\ndata: ${"x".repeat(1_025)}\n\n`,
  ];
  for (const body of streams) {
    const bridge = createStatusBridge({
      adminOrigin: "http://127.0.0.1:18318",
      withAdminToken: tokenConsumer(),
      maxEventBytes: 1_024,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    await assert.rejects(
      bridge.followEvents({ onEvent() {} }),
      (error) => error instanceof StatusBridgeError && error.code === "router_events_unavailable",
    );
  }
  const bridge = createStatusBridge();
  await assert.rejects(
    bridge.followEvents({ afterId: "-1", onEvent() {} }),
    (error) => error instanceof StatusBridgeError && error.code === "invalid_event_cursor",
  );
});

test("private token consumer rejects symlinks and permissive token files", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "status-bridge-token-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.chmod(directory, 0o700);
  const tokenFile = path.join(directory, "admin-token");
  await fs.writeFile(tokenFile, ADMIN_TOKEN, { mode: 0o600 });
  await fs.chmod(tokenFile, 0o600);
  const consumer = createPrivateFileTokenConsumer({ tokenFile });
  assert.equal(await consumer(async (token) => token.length), ADMIN_TOKEN.length);

  await fs.chmod(tokenFile, 0o644);
  await assert.rejects(consumer(async () => undefined), /admin token is unavailable/);
  await fs.chmod(tokenFile, 0o600);
  const link = path.join(directory, "linked-token");
  await fs.symlink(tokenFile, link);
  const linkedConsumer = createPrivateFileTokenConsumer({ tokenFile: link });
  await assert.rejects(linkedConsumer(async () => undefined), /admin token is unavailable/);
});

test("bridge works against the real loopback admin status contract", async (context) => {
  let observedAuthorization = null;
  const server = http.createServer((request, response) => {
    observedAuthorization = request.headers.authorization ?? null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(safeStatus()));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const bridge = createStatusBridge({
    adminOrigin: `http://127.0.0.1:${address.port}`,
    withAdminToken: tokenConsumer(),
  });
  const result = await bridge.getStatus();
  assert.equal(result.enabled, true);
  assert.equal(result.router.accounts[0].alias, "Fixture A");
  assert.equal(observedAuthorization, `Bearer ${ADMIN_TOKEN}`);
});
