import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdminAuthenticator } from "../src/admin-auth.mjs";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import { createRuntimeComposition } from "../src/runtime-composition.mjs";
import { defineSecretProvider, SecretLease, SecretProviderRegistry } from "../src/secrets.mjs";
import {
  createCircuitStateStore,
  createRoutingStateStore,
} from "../src/state-store.mjs";

const ADMIN_TOKEN = "fixture-admin-token-0123456789";
const NOW = Date.parse("2026-07-27T08:00:00.000Z");

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

function account({
  id = "fixture-account-a",
  alias = "Fixture A",
  priority = 1,
  credentialRef = "fixture-a",
} = {}) {
  return {
    id,
    alias,
    enabled: true,
    priority,
    max_concurrency: 1,
    provider: "openai-codex",
    secret_provider: "fixture-secret",
    credential_ref: credentialRef,
  };
}

function registry() {
  return new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      return SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: "Bearer fixture-upstream-token",
        account_id: reference,
      }));
    },
  }));
}

async function privateStateStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-persistence-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return createCircuitStateStore({ directory });
}

async function privateRoutingStateStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-routing-persistence-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return createRoutingStateStore({ directory });
}

async function adminStatus(runtime) {
  const response = await fetch(`http://127.0.0.1:${runtime.addresses.admin.port}/v1/status`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

function runtimeOptions({
  accounts = [account()],
  circuitStateStore,
  failoverOptions = {
    maxAttempts: 1,
    totalDeadlineMs: 1_000,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
  },
  initialCircuitState,
  routingStateStore,
  initialRoutingState,
  now = () => NOW,
  secretRegistry = registry(),
  upstreamOrigin,
}) {
  return {
    accounts,
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    circuitStateStore,
    failoverOptions,
    initialCircuitState,
    routingStateStore,
    initialRoutingState,
    modelPort: 0,
    now,
    secretRegistry,
    upstreamOrigin,
  };
}

function quotaSse(response, usedPercent) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `event: codex.rate_limits\ndata: ${JSON.stringify({
      type: "codex.rate_limits",
      rate_limits: {
        secondary: {
          used_percent: usedPercent,
          window_minutes: 10_080,
          reset_at: 1_785_196_800,
        },
      },
    })}\n\n`,
  );
  response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
}

test("a quota failure remains visible and blocks selection after a simulated process restart", async (context) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"error":{"type":"quota_exhausted"}}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const circuitStateStore = await privateStateStore(context);

  const first = createRuntimeComposition(runtimeOptions({
    circuitStateStore,
    initialCircuitState: await circuitStateStore.load(),
    upstreamOrigin,
  }));
  await first.start();
  const failed = await fetch(
    `http://127.0.0.1:${first.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(failed.status, 503);
  await first.stop();
  const saved = await circuitStateStore.load();
  assert.equal(saved.accounts[0].last_failure_kind, "quota_exhausted");

  const second = createRuntimeComposition(runtimeOptions({
    circuitStateStore,
    initialCircuitState: saved,
    upstreamOrigin,
  }));
  context.after(() => second.stop());
  await second.start();
  const status = await adminStatus(second);
  assert.deepEqual(status.accounts, [{
    alias: "Fixture A",
    state: "quota_exhausted",
    enabled: true,
    five_hour_remaining_ratio: null,
    weekly_remaining_ratio: null,
    snapshot_observed_at: null,
    cooldown_until: new Date(NOW + 60 * 60_000).toISOString(),
    last_switch_reason: "quota_exhausted",
  }]);
  const afterRestart = await fetch(
    `http://127.0.0.1:${second.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(afterRestart.status, 503);
  assert.equal(upstreamCalls, 1);
});

test("a fresh weekly exhaustion observation remains excluded after a simulated process restart", async (context) => {
  const upstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    const accountId = request.headers["chatgpt-account-id"];
    upstreamAccounts.push(accountId);
    quotaSse(response, accountId === "fixture-a" ? 100 : 25);
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const circuitStateStore = await privateStateStore(context);
  const accounts = [
    account({ priority: 10 }),
    account({
      id: "fixture-account-b",
      alias: "Fixture B",
      priority: 0,
      credentialRef: "fixture-b",
    }),
  ];

  const first = createRuntimeComposition(runtimeOptions({
    accounts,
    circuitStateStore,
    initialCircuitState: await circuitStateStore.load(),
    upstreamOrigin,
  }));
  await first.start();
  const exhausted = await fetch(
    `http://127.0.0.1:${first.addresses.model.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"fixture"}',
    },
  );
  assert.equal(exhausted.status, 200);
  await exhausted.text();
  await first.stop();

  const saved = await circuitStateStore.load();
  assert.equal(
    saved.accounts.find(({ account_id: accountId }) =>
      accountId === "fixture-account-a")?.last_failure_kind,
    "quota_exhausted",
  );
  assert.equal(
    saved.accounts.find(({ account_id: accountId }) =>
      accountId === "fixture-account-a")?.cooldown_until,
    "2026-07-28T00:00:00.000Z",
  );
  assert.deepEqual(saved.weekly_quota, [
    {
      account_id: "fixture-account-a",
      observed_at: "2026-07-27T08:00:00.000Z",
      remaining_ratio: 0,
      resets_at: "2026-07-28T00:00:00.000Z",
    },
  ]);

  const second = createRuntimeComposition(runtimeOptions({
    accounts,
    circuitStateStore,
    initialCircuitState: saved,
    upstreamOrigin,
  }));
  context.after(() => second.stop());
  await second.start();
  const restartedStatus = await adminStatus(second);
  assert.equal(restartedStatus.accounts[0].weekly_remaining_ratio, 0);
  assert.equal(
    restartedStatus.accounts[0].snapshot_observed_at,
    "2026-07-27T08:00:00.000Z",
  );
  const ready = await fetch(`http://127.0.0.1:${second.addresses.admin.port}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).usable_accounts, 1);
  const afterRestart = await fetch(
    `http://127.0.0.1:${second.addresses.model.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"fixture"}',
    },
  );
  assert.equal(afterRestart.status, 200);
  await afterRestart.text();
  assert.deepEqual(upstreamAccounts, ["fixture-a", "fixture-b"]);
  await second.stop();
});

test("restart discards a persisted weekly snapshot at its explicit reset boundary", async (context) => {
  const circuitStateStore = await privateStateStore(context);
  const breaker = createCircuitBreaker({ now: () => NOW });
  breaker.snapshot("fixture-account-a");
  await circuitStateStore.save({
    ...breaker.exportState(),
    weekly_quota: [{
      account_id: "fixture-account-a",
      observed_at: "2026-07-27T07:00:00.000Z",
      remaining_ratio: 0,
      resets_at: "2026-07-27T08:00:00.000Z",
    }],
  });

  const runtime = createRuntimeComposition(runtimeOptions({
    circuitStateStore,
    initialCircuitState: await circuitStateStore.load(),
    upstreamOrigin: "http://127.0.0.1:1",
  }));
  await runtime.start();
  const status = await adminStatus(runtime);
  assert.equal(status.accounts[0].weekly_remaining_ratio, null);
  assert.equal(status.accounts[0].snapshot_observed_at, null);
  await runtime.stop();
  assert.deepEqual((await circuitStateStore.load()).weekly_quota, []);
});

test("a running router clears persisted Weekly display at the explicit reset boundary", async (context) => {
  let currentTime = NOW;
  const circuitStateStore = await privateStateStore(context);
  const breaker = createCircuitBreaker({ now: () => currentTime });
  breaker.recordFailure("fixture-account-a", { kind: "quota_exhausted" });
  await circuitStateStore.save({
    ...breaker.exportState(),
    weekly_quota: [{
      account_id: "fixture-account-a",
      observed_at: "2026-07-27T07:00:00.000Z",
      remaining_ratio: 0,
      resets_at: "2026-07-27T08:00:01.000Z",
    }],
  });

  const runtime = createRuntimeComposition(runtimeOptions({
    circuitStateStore,
    initialCircuitState: await circuitStateStore.load(),
    now: () => currentTime,
    upstreamOrigin: "http://127.0.0.1:1",
  }));
  context.after(() => runtime.stop());
  await runtime.start();
  assert.equal((await adminStatus(runtime)).accounts[0].weekly_remaining_ratio, 0);

  currentTime = NOW + 1_000;
  const resetStatus = await adminStatus(runtime);
  assert.equal(resetStatus.accounts[0].weekly_remaining_ratio, null);
  assert.equal(resetStatus.accounts[0].snapshot_observed_at, null);
  assert.equal(resetStatus.accounts[0].state, "quota_exhausted");
  assert.equal(
    resetStatus.accounts[0].cooldown_until,
    "2026-07-27T09:00:00.000Z",
  );
  await runtime.stop();
  assert.deepEqual((await circuitStateStore.load()).weekly_quota, []);
});

test("an accepted manual next-request preference survives a simulated process restart", async (context) => {
  const upstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    upstreamAccounts.push(request.headers["chatgpt-account-id"]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const circuitStateStore = await privateStateStore(context);
  const routingStateStore = await privateRoutingStateStore(context);
  const accounts = [
    account({ priority: 10 }),
    account({
      id: "fixture-account-b",
      alias: "Fixture B",
      priority: 0,
      credentialRef: "fixture-b",
    }),
  ];

  const first = createRuntimeComposition(runtimeOptions({
    accounts,
    circuitStateStore,
    initialCircuitState: await circuitStateStore.load(),
    routingStateStore,
    initialRoutingState: await routingStateStore.load(),
    upstreamOrigin,
  }));
  await first.start();
  const switched = await fetch(
    `http://127.0.0.1:${first.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    },
  );
  assert.equal(switched.status, 200);
  await switched.arrayBuffer();
  await first.stop();

  const savedCircuit = await circuitStateStore.load();
  assert.equal(savedCircuit.routing, undefined);
  const saved = await routingStateStore.load();
  assert.deepEqual(saved.routing, {
    current_account_id: "fixture-account-b",
    preferred_account_id: "fixture-account-b",
  });

  const second = createRuntimeComposition(runtimeOptions({
    accounts,
    circuitStateStore,
    initialCircuitState: savedCircuit,
    routingStateStore,
    initialRoutingState: saved,
    upstreamOrigin,
  }));
  context.after(() => second.stop());
  await second.start();
  assert.deepEqual((await adminStatus(second)).current_route, {
    account_alias: "Fixture B",
    continuity: "new_backend_session",
  });

  const response = await fetch(
    `http://127.0.0.1:${second.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(upstreamAccounts, ["fixture-b"]);
});

test("does not contact an automatic route before private route persistence succeeds", async (context) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    routingStateStore: {
      async load() { return null; },
      async save() { throw new Error("fixture route state unavailable"); },
    },
    initialRoutingState: null,
    upstreamOrigin,
  }));
  context.after(async () => {
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const response = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      type: "protocol_error",
      reason: "selector_failed",
      attempts: 0,
      semantic_output: false,
    },
  });
  assert.equal(upstreamCalls, 0);
});

test("opens an automatic upstream attempt only after private route persistence completes", async (context) => {
  let announceSave;
  let releaseSave;
  const saveStarted = new Promise((resolve) => { announceSave = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    routingStateStore: {
      async load() { return null; },
      async save() {
        announceSave();
        await saveGate;
      },
    },
    initialRoutingState: null,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseSave();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const responsePromise = fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  await saveStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upstreamCalls, 0);

  releaseSave();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(upstreamCalls, 1);
  assert.deepEqual((await adminStatus(runtime)).current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });
});

test("fails closed and disposes the lease when automatic route persistence exceeds its deadline", async (context) => {
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let fixtureLease;
  const secretRegistry = new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      fixtureLease = SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: "Bearer fixture-upstream-token",
        account_id: reference,
      }));
      return fixtureLease;
    },
  }));
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    failoverOptions: {
      maxAttempts: 1,
      totalDeadlineMs: 25,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    routingStateStore: {
      async load() { return null; },
      async save() { await saveGate; },
    },
    initialRoutingState: null,
    secretRegistry,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseSave();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const response = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      type: "all_accounts_unavailable",
      reason: "total_deadline_exceeded",
      attempts: 0,
      semantic_output: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureLease.disposed, true);
  assert.equal(upstreamCalls, 0);

  const ready = await fetch(`http://127.0.0.1:${runtime.addresses.admin.port}/readyz`);
  assert.equal(ready.status, 503);
  releaseSave();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await adminStatus(runtime)).current_route, null);
});

test("releases the routing lock, half-open probe, and late credential lease after the deadline", async (context) => {
  let resolveFirstAcquire;
  const firstAcquireGate = new Promise((resolve) => { resolveFirstAcquire = resolve; });
  let firstLease = null;
  let acquireCalls = 0;
  const secretRegistry = new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      acquireCalls += 1;
      if (acquireCalls === 1) return firstAcquireGate;
      return SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: "Bearer fixture-upstream-token",
        account_id: reference,
      }));
    },
  }));
  const releaseFirstAcquire = () => {
    if (firstLease !== null) return;
    firstLease = SecretLease.fromUtf8(JSON.stringify({
      version: 1,
      authorization: "Bearer fixture-upstream-token",
      account_id: "fixture-a",
    }));
    resolveFirstAcquire(firstLease);
  };
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    failoverOptions: {
      maxAttempts: 1,
      totalDeadlineMs: 100,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    initialCircuitState: {
      version: 1,
      saved_at: new Date(NOW).toISOString(),
      accounts: [{
        account_id: "fixture-account-a",
        phase: "half_open",
        last_failure_kind: "network_error",
        opened_at: new Date(NOW - 1_000).toISOString(),
        cooldown_until: new Date(NOW).toISOString(),
        consecutive_failures: 1,
        last_failure_at: new Date(NOW - 1_000).toISOString(),
        last_success_at: null,
        generation: 1,
      }],
    },
    routingStateStore: {
      async load() { return null; },
      async save() {},
    },
    initialRoutingState: null,
    secretRegistry,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseFirstAcquire();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const timedOut = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    error: {
      type: "all_accounts_unavailable",
      reason: "total_deadline_exceeded",
      attempts: 0,
      semantic_output: false,
    },
  });
  assert.equal(upstreamCalls, 0);
  assert.equal(acquireCalls, 1);

  const recovered = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(recovered.status, 200);
  await recovered.arrayBuffer();
  assert.equal(acquireCalls, 2);
  assert.equal(upstreamCalls, 1);
  assert.equal((await adminStatus(runtime)).accounts[0].state, "healthy");

  releaseFirstAcquire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstLease.disposed, true);
});

test("releases the routing lock when auth-failure persistence outlives the deadline", async (context) => {
  let acquireCalls = 0;
  const leases = [];
  const secretRegistry = new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      acquireCalls += 1;
      const lease = SecretLease.fromUtf8(
        reference === "fixture-a"
          ? "{}"
          : JSON.stringify({
              version: 1,
              authorization: "Bearer fixture-upstream-token",
              account_id: reference,
            }),
      );
      leases.push(lease);
      return lease;
    },
  }));
  let rejectSave;
  let announceSave;
  const saveGate = new Promise((_, reject) => { rejectSave = reject; });
  const saveStarted = new Promise((resolve) => { announceSave = resolve; });
  let saveCalls = 0;
  const circuitStateStore = {
    async load() { return null; },
    async save() {
      saveCalls += 1;
      if (saveCalls !== 1) return;
      announceSave();
      await saveGate;
    },
  };
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    accounts: [
      account({ priority: 10 }),
      account({
        id: "fixture-account-b",
        alias: "Fixture B",
        priority: 0,
        credentialRef: "fixture-b",
      }),
    ],
    circuitStateStore,
    failoverOptions: {
      maxAttempts: 1,
      totalDeadlineMs: 100,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    secretRegistry,
    upstreamOrigin,
  }));
  context.after(async () => {
    rejectSave(new Error("fixture late circuit-state persistence failure"));
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const timedOutPromise = fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  await saveStarted;
  const timedOut = await timedOutPromise;
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    error: {
      type: "all_accounts_unavailable",
      reason: "total_deadline_exceeded",
      attempts: 0,
      semantic_output: false,
    },
  });
  assert.equal(acquireCalls, 1);
  assert.equal(leases[0].disposed, true);
  assert.equal(upstreamCalls, 0);

  const recovered = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(recovered.status, 200);
  await recovered.arrayBuffer();
  assert.equal(acquireCalls, 2);
  assert.equal(upstreamCalls, 1);
  assert.equal(leases.every(({ disposed }) => disposed), true);
  assert.equal((await adminStatus(runtime)).accounts[0].state, "auth_expired");

  rejectSave(new Error("fixture late circuit-state persistence failure"));
  await new Promise((resolve) => setImmediate(resolve));
  const ready = await fetch(`http://127.0.0.1:${runtime.addresses.admin.port}/readyz`);
  assert.equal(ready.status, 503);
  const unavailable = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), {
    error: {
      type: "protocol_error",
      reason: "selector_failed",
      attempts: 0,
      semantic_output: false,
    },
  });
  assert.equal(acquireCalls, 2);
  assert.equal(upstreamCalls, 1);
});

test("releases a half-open probe when its persistence checkpoint outlives the deadline", async (context) => {
  let acquireCalls = 0;
  const secretRegistry = new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      acquireCalls += 1;
      return SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: "Bearer fixture-upstream-token",
        account_id: reference,
      }));
    },
  }));
  let releaseSave;
  let announceSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { announceSave = resolve; });
  let saveCalls = 0;
  const circuitStateStore = {
    async load() { return null; },
    async save() {
      saveCalls += 1;
      if (saveCalls !== 1) return;
      announceSave();
      await saveGate;
    },
  };
  const selectedUpstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    selectedUpstreamAccounts.push(request.headers["chatgpt-account-id"]);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    accounts: [
      account({ priority: 10 }),
      account({
        id: "fixture-account-b",
        alias: "Fixture B",
        priority: 0,
        credentialRef: "fixture-b",
      }),
    ],
    circuitStateStore,
    initialCircuitState: {
      version: 1,
      saved_at: new Date(NOW).toISOString(),
      accounts: [{
        account_id: "fixture-account-a",
        phase: "half_open",
        last_failure_kind: "network_error",
        opened_at: new Date(NOW - 1_000).toISOString(),
        cooldown_until: new Date(NOW).toISOString(),
        consecutive_failures: 1,
        last_failure_at: new Date(NOW - 1_000).toISOString(),
        last_success_at: null,
        generation: 1,
      }],
    },
    failoverOptions: {
      maxAttempts: 1,
      totalDeadlineMs: 250,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    routingStateStore: {
      async load() { return null; },
      async save() {},
    },
    initialRoutingState: null,
    secretRegistry,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseSave();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const timedOutPromise = fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  await saveStarted;
  const timedOut = await timedOutPromise;
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    error: {
      type: "all_accounts_unavailable",
      reason: "total_deadline_exceeded",
      attempts: 0,
      semantic_output: false,
    },
  });
  assert.equal(acquireCalls, 0);
  assert.deepEqual(selectedUpstreamAccounts, []);

  const switchToBPromise = fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    },
  );
  const switchSettledBeforeSave = await Promise.race([
    switchToBPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(switchSettledBeforeSave, true);
  const switchedToB = await switchToBPromise;
  assert.equal(switchedToB.status, 200);
  await switchedToB.arrayBuffer();

  const routedToB = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(routedToB.status, 200);
  await routedToB.arrayBuffer();
  assert.deepEqual(selectedUpstreamAccounts, ["fixture-b"]);

  releaseSave();
  await new Promise((resolve) => setImmediate(resolve));
  const switchedToA = await fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture A","reason":"manual"}',
    },
  );
  assert.equal(switchedToA.status, 200);
  await switchedToA.arrayBuffer();

  const retriedProbe = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(retriedProbe.status, 200);
  await retriedProbe.arrayBuffer();
  assert.deepEqual(selectedUpstreamAccounts, ["fixture-b", "fixture-a"]);
  assert.equal(acquireCalls, 2);
  assert.equal((await adminStatus(runtime)).accounts[0].state, "healthy");
});

test("releases the routing lock when attempt-failure persistence outlives the deadline", async (context) => {
  let releaseSave;
  let announceSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { announceSave = resolve; });
  let saveCalls = 0;
  const circuitStateStore = {
    async load() { return null; },
    async save() {
      saveCalls += 1;
      if (saveCalls !== 1) return;
      announceSave();
      await saveGate;
    },
  };
  const selectedUpstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    const accountId = request.headers["chatgpt-account-id"];
    selectedUpstreamAccounts.push(accountId);
    request.resume();
    if (accountId === "fixture-a") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":{"type":"fixture_upstream_unavailable"}}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    accounts: [
      account({ priority: 10 }),
      account({
        id: "fixture-account-b",
        alias: "Fixture B",
        priority: 0,
        credentialRef: "fixture-b",
      }),
    ],
    circuitStateStore,
    failoverOptions: {
      maxAttempts: 2,
      totalDeadlineMs: 250,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    routingStateStore: {
      async load() { return null; },
      async save() {},
    },
    initialRoutingState: null,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseSave();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const timedOutPromise = fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  await saveStarted;
  const timedOut = await timedOutPromise;
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    error: {
      type: "all_accounts_unavailable",
      reason: "total_deadline_exceeded",
      attempts: 1,
      semantic_output: false,
    },
  });
  assert.deepEqual(selectedUpstreamAccounts, ["fixture-a"]);

  const switchToBPromise = fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    },
  );
  const switchSettledBeforeSave = await Promise.race([
    switchToBPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(switchSettledBeforeSave, true);
  const switchedToB = await switchToBPromise;
  assert.equal(switchedToB.status, 200);
  await switchedToB.arrayBuffer();

  const routedToB = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(routedToB.status, 200);
  await routedToB.arrayBuffer();
  assert.deepEqual(selectedUpstreamAccounts, ["fixture-a", "fixture-b"]);

  releaseSave();
  await new Promise((resolve) => setImmediate(resolve));
  const status = await adminStatus(runtime);
  assert.equal(status.accounts[0].state, "cooling_down");
  assert.equal(status.accounts[0].last_switch_reason, "upstream_5xx");
  assert.deepEqual(status.current_route, {
    account_alias: "Fixture B",
    continuity: "new_backend_session",
  });
});

test("rejects a no-op switch without waiting for queued route persistence", async (context) => {
  let releaseSave;
  let announceSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { announceSave = resolve; });
  let saveCalls = 0;
  const routingStateStore = {
    async load() { return null; },
    async save() {
      saveCalls += 1;
      if (saveCalls !== 2) return;
      announceSave();
      await saveGate;
    },
  };
  const upstream = http.createServer((request, response) => {
    request.resume();
    quotaSse(response, 25);
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition(runtimeOptions({
    routingStateStore,
    initialRoutingState: null,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseSave();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const first = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"fixture"}',
    },
  );
  assert.equal(first.status, 200);
  await first.text();
  await saveStarted;
  assert.equal(saveCalls, 2);
  assert.deepEqual((await adminStatus(runtime)).current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });

  const noOpSwitchPromise = fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture A","reason":"manual"}',
    },
  );
  const switchSettledBeforeSave = await Promise.race([
    noOpSwitchPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(switchSettledBeforeSave, true);
  const noOpSwitch = await noOpSwitchPromise;
  assert.equal(noOpSwitch.status, 409);
  assert.deepEqual(await noOpSwitch.json(), { error: "switch_rejected" });
  assert.equal(saveCalls, 2);
});

test("does not acknowledge a manual preference when private route persistence fails", async (context) => {
  const runtime = createRuntimeComposition(runtimeOptions({
    accounts: [
      account({ priority: 10 }),
      account({
        id: "fixture-account-b",
        alias: "Fixture B",
        priority: 0,
        credentialRef: "fixture-b",
      }),
    ],
    routingStateStore: {
      async load() { return null; },
      async save() { throw new Error("fixture route state unavailable"); },
    },
    initialRoutingState: null,
    upstreamOrigin: "http://127.0.0.1:1",
  }));
  context.after(async () => {
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const switched = await fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    },
  );
  assert.equal(switched.status, 503);
  assert.deepEqual(await switched.json(), { error: "switch_request_failed" });
  assert.equal((await adminStatus(runtime)).current_route, null);
});

test("acknowledges a manual preference only after private route persistence completes", async (context) => {
  let announceSave;
  let releaseSave;
  const saveStarted = new Promise((resolve) => { announceSave = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let saveCalls = 0;
  let savedDocument;
  const runtime = createRuntimeComposition(runtimeOptions({
    accounts: [
      account({ priority: 10 }),
      account({
        id: "fixture-account-b",
        alias: "Fixture B",
        priority: 0,
        credentialRef: "fixture-b",
      }),
    ],
    routingStateStore: {
      async load() { return null; },
      async save(document) {
        saveCalls += 1;
        savedDocument = document;
        if (saveCalls === 1) {
          announceSave();
          await saveGate;
        }
      },
    },
    initialRoutingState: null,
    upstreamOrigin: "http://127.0.0.1:1",
  }));
  context.after(async () => {
    releaseSave();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const switchResponse = fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    },
  );
  await saveStarted;
  const responseSettledBeforeSave = await Promise.race([
    switchResponse.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(responseSettledBeforeSave, false);
  assert.deepEqual(savedDocument.routing, {
    current_account_id: "fixture-account-b",
    preferred_account_id: "fixture-account-b",
  });

  releaseSave();
  const switched = await switchResponse;
  assert.equal(switched.status, 200);
  await switched.arrayBuffer();
  assert.deepEqual((await adminStatus(runtime)).current_route, {
    account_alias: "Fixture B",
    continuity: "new_backend_session",
  });
});

test("rolls back a persisted manual candidate if a semantic stream starts before acknowledgement", async (context) => {
  let announceUpstreamRequest;
  let triggerSemantic;
  let finishStream;
  const upstreamRequestStarted = new Promise((resolve) => {
    announceUpstreamRequest = resolve;
  });
  const upstream = http.createServer((request, response) => {
    request.resume();
    triggerSemantic = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
      response.write(
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\n",
      );
    };
    finishStream = () => {
      response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
    };
    announceUpstreamRequest();
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);

  let announceCandidateSave;
  let releaseCandidateSave;
  const candidateSaveStarted = new Promise((resolve) => {
    announceCandidateSave = resolve;
  });
  const candidateSaveGate = new Promise((resolve) => {
    releaseCandidateSave = resolve;
  });
  const savedRoutes = [];
  let saveCalls = 0;
  const runtime = createRuntimeComposition(runtimeOptions({
    accounts: [
      account({ priority: 10 }),
      account({
        id: "fixture-account-b",
        alias: "Fixture B",
        priority: 0,
        credentialRef: "fixture-b",
      }),
    ],
    routingStateStore: {
      async load() { return null; },
      async save(document) {
        saveCalls += 1;
        savedRoutes.push(structuredClone(document.routing));
        if (saveCalls === 2) {
          announceCandidateSave();
          await candidateSaveGate;
        }
      },
    },
    initialRoutingState: null,
    upstreamOrigin,
  }));
  context.after(async () => {
    releaseCandidateSave();
    finishStream?.();
    await runtime.stop().catch(() => undefined);
  });
  await runtime.start();

  const modelResponsePromise = fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"fixture"}',
    },
  );
  await upstreamRequestStarted;

  const switchResponsePromise = fetch(
    `http://127.0.0.1:${runtime.addresses.admin.port}/v1/switch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    },
  );
  await candidateSaveStarted;
  triggerSemantic();
  const modelResponse = await modelResponsePromise;
  assert.equal(modelResponse.status, 200);
  const reader = modelResponse.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  assert.equal((await adminStatus(runtime)).active_streams, 1);

  releaseCandidateSave();
  const switchResponse = await switchResponsePromise;
  assert.equal(switchResponse.status, 409);
  assert.deepEqual(await switchResponse.json(), { error: "switch_rejected" });
  assert.deepEqual(savedRoutes.at(-1), {
    current_account_id: "fixture-account-a",
    preferred_account_id: null,
  });
  assert.deepEqual((await adminStatus(runtime)).current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });

  finishStream();
  while (!(await reader.read()).done) {}
});

test("a persistence failure makes readiness and later selection fail closed", async () => {
  const failingRegistry = new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire() {
      throw new Error("fixture credential unavailable");
    },
  }));
  const runtime = createRuntimeComposition({
    accounts: [account()],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    circuitStateStore: {
      async load() { return null; },
      async save() { throw new Error("fixture state store unavailable"); },
    },
    modelPort: 0,
    now: () => NOW,
    secretRegistry: failingRegistry,
    upstreamOrigin: "http://127.0.0.1:1",
  });
  await runtime.start();
  const unavailable = await fetch(
    `http://127.0.0.1:${runtime.addresses.model.port}/backend-api/codex/models`,
  );
  assert.equal(unavailable.status, 502);
  const ready = await fetch(`http://127.0.0.1:${runtime.addresses.admin.port}/readyz`);
  assert.equal(ready.status, 503);
  await assert.rejects(runtime.stop(), /state persistence is unavailable/);
});
