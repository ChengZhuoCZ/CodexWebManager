import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createAdminAuthenticator } from "../src/admin-auth.mjs";
import { createRuntimeComposition } from "../src/runtime-composition.mjs";
import {
  defineSecretProvider,
  SecretLease,
  SecretProviderRegistry,
} from "../src/secrets.mjs";

const ADMIN_TOKEN = "fixture-admin-token-0123456789";

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

function account() {
  return {
    id: "fixture-account-a",
    alias: "Primary fixture",
    enabled: true,
    priority: 10,
    max_concurrency: 2,
    provider: "openai-codex",
    secret_provider: "fixture-secret",
    credential_ref: "account-a",
  };
}

function routedAccount(id, alias, priority) {
  return {
    id: `fixture-account-${id}`,
    alias,
    enabled: true,
    priority,
    max_concurrency: 2,
    provider: "openai-codex",
    secret_provider: "fixture-secret",
    credential_ref: `account-${id}`,
  };
}

function fixtureRegistry({
  leases,
  acquisitions,
  accountIdFromReference = false,
  failedReferences = new Set(),
}) {
  return new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      acquisitions.push(reference);
      if (failedReferences.has(reference)) {
        throw new Error("fixture credential unavailable");
      }
      const lease = SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: "Bearer fixture-runtime-upstream",
        account_id: accountIdFromReference
          ? `fixture-upstream-${reference}`
          : "fixture-upstream-account",
      }));
      leases.push(lease);
      return lease;
    },
  }));
}

async function adminJson(origin, path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  return { response, value: await response.json() };
}

test("starts loopback admin and model services and routes one account through a secret lease", async (context) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      account: request.headers["chatgpt-account-id"],
      authorization: request.headers.authorization,
      clientAuthorization: request.headers["x-client-authorization-canary"],
      cookie: request.headers.cookie,
      path: request.url,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const leases = [];
  const acquisitions = [];
  const runtime = createRuntimeComposition({
    accounts: [account()],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    modelPort: 0,
    secretRegistry: fixtureRegistry({ leases, acquisitions }),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  assert.equal(addresses.admin.address, "127.0.0.1");
  assert.equal(addresses.model.address, "127.0.0.1");
  assert.notEqual(addresses.admin.port, addresses.model.port);
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;
  const modelOrigin = `http://127.0.0.1:${addresses.model.port}`;

  const ready = await fetch(`${adminOrigin}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).usable_accounts, 1);
  const models = await fetch(`${modelOrigin}/backend-api/codex/models?client_version=0.144.2`, {
    headers: {
      authorization: "Bearer fixture-client-credential",
      cookie: "fixture-client-cookie=hidden",
      "x-client-authorization-canary": "hidden",
    },
  });
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { models: [{ slug: "fixture-model" }] });
  assert.deepEqual(observed, {
    account: "fixture-upstream-account",
    authorization: "Bearer fixture-runtime-upstream",
    clientAuthorization: undefined,
    cookie: undefined,
    path: "/backend-api/codex/models?client_version=0.144.2",
  });
  assert.deepEqual(acquisitions, ["account-a"]);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].disposed, true);

  const status = await adminJson(adminOrigin, "/v1/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.value.status, "ready");
  assert.equal(status.value.cross_account_e2e_verified, false);
  assert.deepEqual(status.value.accounts, [{
    alias: "Primary fixture",
    state: "healthy",
    enabled: true,
    five_hour_remaining_ratio: null,
    weekly_remaining_ratio: null,
    snapshot_observed_at: null,
    cooldown_until: null,
    last_switch_reason: "startup",
  }]);
  assert.doesNotMatch(JSON.stringify(status.value), /fixture-account-a|account-a|upstream|Bearer/i);
});

test("opens the single account circuit on quota failure and fails subsequent selection closed", async (context) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    request.resume();
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"error":{"type":"quota_exhausted"}}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const leases = [];
  const acquisitions = [];
  const runtime = createRuntimeComposition({
    accounts: [account()],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    failoverOptions: {
      maxAttempts: 1,
      totalDeadlineMs: 1_000,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    modelPort: 0,
    secretRegistry: fixtureRegistry({ leases, acquisitions }),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;
  const modelUrl = `http://127.0.0.1:${addresses.model.port}/backend-api/codex/models`;

  const first = await fetch(modelUrl);
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error.type, "all_accounts_unavailable");
  const second = await fetch(modelUrl);
  assert.equal(second.status, 503);
  assert.equal((await second.json()).error.type, "all_accounts_unavailable");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(acquisitions, ["account-a"]);
  assert.equal(leases[0].disposed, true);

  const ready = await fetch(`${adminOrigin}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).usable_accounts, 0);
  const status = await adminJson(adminOrigin, "/v1/status");
  assert.equal(status.value.accounts[0].state, "quota_exhausted");
  assert.match(status.value.accounts[0].cooldown_until, /^\d{4}-\d{2}-\d{2}T/);
});

test("production runtime accepts a safe manual preference and routes the next new request to it", async (context) => {
  const upstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    upstreamAccounts.push(request.headers["chatgpt-account-id"]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const leases = [];
  const acquisitions = [];
  const runtime = createRuntimeComposition({
    accounts: [
      routedAccount("a", "Fixture A", 10),
      routedAccount("b", "Fixture B", 0),
    ],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    modelPort: 0,
    secretRegistry: fixtureRegistry({
      leases,
      acquisitions,
      accountIdFromReference: true,
    }),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;
  const modelOrigin = `http://127.0.0.1:${addresses.model.port}`;

  const first = await fetch(`${modelOrigin}/backend-api/codex/models?client_version=0.144.1`);
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  assert.deepEqual(upstreamAccounts, ["fixture-upstream-account-a"]);
  assert.deepEqual((await adminJson(adminOrigin, "/v1/status")).value.current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });

  const switched = await fetch(`${adminOrigin}/v1/switch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: '{"account_alias":"Fixture B","reason":"manual"}',
  });
  assert.equal(switched.status, 200);
  assert.deepEqual(await switched.json(), {
    accepted: true,
    account_alias: "Fixture B",
    continuity: "new_backend_session",
    architecture_mode: "LIMITED_MODE",
  });

  const second = await fetch(`${modelOrigin}/backend-api/codex/models?client_version=0.144.2`);
  assert.equal(second.status, 200);
  await second.arrayBuffer();
  assert.deepEqual(upstreamAccounts, [
    "fixture-upstream-account-a",
    "fixture-upstream-account-b",
  ]);
  const status = (await adminJson(adminOrigin, "/v1/status")).value;
  assert.deepEqual(status.current_route, {
    account_alias: "Fixture B",
    continuity: "new_backend_session",
  });
  assert.equal(status.accounts[1].last_switch_reason, "manual");
});

test("production runtime clears an unavailable manual preference before selecting a fallback", async (context) => {
  const upstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    upstreamAccounts.push(request.headers["chatgpt-account-id"]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const leases = [];
  const acquisitions = [];
  const failedReferences = new Set();
  const runtime = createRuntimeComposition({
    accounts: [
      routedAccount("a", "Fixture A", 10),
      routedAccount("b", "Fixture B", 0),
    ],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    modelPort: 0,
    secretRegistry: fixtureRegistry({
      leases,
      acquisitions,
      accountIdFromReference: true,
      failedReferences,
    }),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;
  const modelOrigin = `http://127.0.0.1:${addresses.model.port}`;

  const first = await fetch(`${modelOrigin}/backend-api/codex/models?client_version=0.144.1`);
  assert.equal(first.status, 200);
  await first.arrayBuffer();

  const switched = await fetch(`${adminOrigin}/v1/switch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: '{"account_alias":"Fixture B","reason":"manual"}',
  });
  assert.equal(switched.status, 200);
  await switched.arrayBuffer();
  failedReferences.add("account-b");

  const second = await fetch(`${modelOrigin}/backend-api/codex/models?client_version=0.144.2`);
  assert.equal(second.status, 200);
  await second.arrayBuffer();
  assert.deepEqual(acquisitions, ["account-a", "account-b", "account-a"]);
  assert.deepEqual(upstreamAccounts, [
    "fixture-upstream-account-a",
    "fixture-upstream-account-a",
  ]);
  const status = (await adminJson(adminOrigin, "/v1/status")).value;
  assert.deepEqual(status.current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });
  assert.equal(status.accounts[0].last_switch_reason, "auth_expired");
  assert.equal(status.accounts[1].state, "auth_expired");
});

test("production runtime blocks a manual switch during a real semantic stream", async (context) => {
  let finishStream;
  let announceStream;
  const streamOpened = new Promise((resolve) => { announceStream = resolve; });
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
    response.write(
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\n",
    );
    finishStream = () => {
      response.end(
        "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
      );
    };
    announceStream();
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const leases = [];
  const acquisitions = [];
  const runtime = createRuntimeComposition({
    accounts: [
      routedAccount("a", "Fixture A", 10),
      routedAccount("b", "Fixture B", 0),
    ],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    modelPort: 0,
    secretRegistry: fixtureRegistry({
      leases,
      acquisitions,
      accountIdFromReference: true,
    }),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;
  const modelOrigin = `http://127.0.0.1:${addresses.model.port}`;

  const responsePromise = fetch(`${modelOrigin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  await streamOpened;
  const streamResponse = await responsePromise;
  try {
    assert.equal(streamResponse.status, 200);
    assert.equal((await adminJson(adminOrigin, "/v1/status")).value.active_streams, 1);

    const denied = await fetch(`${adminOrigin}/v1/switch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: '{"account_alias":"Fixture B","reason":"manual"}',
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, "active_semantic_stream");
  } finally {
    finishStream();
    await streamResponse.text();
  }
  assert.equal((await adminJson(adminOrigin, "/v1/status")).value.active_streams, 0);
  const accepted = await fetch(`${adminOrigin}/v1/switch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: '{"account_alias":"Fixture B","reason":"manual"}',
  });
  assert.equal(accepted.status, 200);
});

test("production runtime publishes the automatic route selected after pre-semantic quota failure", async (context) => {
  const upstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    const accountId = request.headers["chatgpt-account-id"];
    upstreamAccounts.push(accountId);
    if (accountId === "fixture-upstream-account-a") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":{"type":"quota_exhausted"}}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"slug":"fixture-model"}]}');
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const leases = [];
  const acquisitions = [];
  const runtime = createRuntimeComposition({
    accounts: [
      routedAccount("a", "Fixture A", 10),
      routedAccount("b", "Fixture B", 0),
    ],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    failoverOptions: {
      maxAttempts: 2,
      totalDeadlineMs: 2_000,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    modelPort: 0,
    secretRegistry: fixtureRegistry({
      leases,
      acquisitions,
      accountIdFromReference: true,
    }),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;
  const modelOrigin = `http://127.0.0.1:${addresses.model.port}`;

  const response = await fetch(`${modelOrigin}/backend-api/codex/models`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(upstreamAccounts, [
    "fixture-upstream-account-a",
    "fixture-upstream-account-b",
  ]);
  const status = (await adminJson(adminOrigin, "/v1/status")).value;
  assert.deepEqual(status.current_route, {
    account_alias: "Fixture B",
    continuity: "new_backend_session",
  });
  assert.equal(status.accounts[0].state, "quota_exhausted");
  assert.equal(status.accounts[1].last_switch_reason, "quota_exhausted");
});

test("validates runtime composition and stops both listeners together", async () => {
  const registry = new SecretProviderRegistry();
  for (const options of [
    {},
    { accounts: [], secretRegistry: registry, upstreamOrigin: "https://example.invalid/path" },
    { accounts: [], secretRegistry: registry, upstreamOrigin: "http://user@example.invalid" },
    { accounts: [], secretRegistry: {}, upstreamOrigin: "https://example.invalid" },
    {
      accounts: [],
      manualSwitchDeadlineMs: 0,
      secretRegistry: registry,
      upstreamOrigin: "https://example.invalid",
    },
    {
      accounts: [],
      manualSwitchDeadlineMs: 60_001,
      secretRegistry: registry,
      upstreamOrigin: "https://example.invalid",
    },
    {
      accounts: [],
      manualSwitchDeadlineMs: 1.5,
      secretRegistry: registry,
      upstreamOrigin: "https://example.invalid",
    },
    {
      accounts: [],
      shutdownDeadlineMs: 0,
      secretRegistry: registry,
      upstreamOrigin: "https://example.invalid",
    },
    {
      accounts: [],
      shutdownDeadlineMs: 60_001,
      secretRegistry: registry,
      upstreamOrigin: "https://example.invalid",
    },
    {
      accounts: [],
      shutdownDeadlineMs: 1.5,
      secretRegistry: registry,
      upstreamOrigin: "https://example.invalid",
    },
  ]) {
    assert.throws(() => createRuntimeComposition(options));
  }
});
