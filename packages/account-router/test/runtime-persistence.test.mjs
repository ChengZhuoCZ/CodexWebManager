import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdminAuthenticator } from "../src/admin-auth.mjs";
import { createRuntimeComposition } from "../src/runtime-composition.mjs";
import { defineSecretProvider, SecretLease, SecretProviderRegistry } from "../src/secrets.mjs";
import { createCircuitStateStore } from "../src/state-store.mjs";

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

function account() {
  return {
    id: "fixture-account-a",
    alias: "Fixture A",
    enabled: true,
    priority: 1,
    max_concurrency: 1,
    provider: "openai-codex",
    secret_provider: "fixture-secret",
    credential_ref: "fixture-a",
  };
}

function registry() {
  return new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire() {
      return SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: "Bearer fixture-upstream-token",
        account_id: "fixture-upstream-account",
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

async function adminStatus(runtime) {
  const response = await fetch(`http://127.0.0.1:${runtime.addresses.admin.port}/v1/status`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

function runtimeOptions({ circuitStateStore, initialCircuitState, upstreamOrigin }) {
  return {
    accounts: [account()],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    circuitStateStore,
    failoverOptions: {
      maxAttempts: 1,
      totalDeadlineMs: 1_000,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    },
    initialCircuitState,
    modelPort: 0,
    now: () => NOW,
    secretRegistry: registry(),
    upstreamOrigin,
  };
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
