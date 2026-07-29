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
const NOW = Date.parse("2026-07-28T00:00:00.000Z");

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

function account(id, alias, priority) {
  return {
    id,
    alias,
    enabled: true,
    priority,
    max_concurrency: 1,
    provider: "openai-codex",
    secret_provider: "fixture-secret",
    credential_ref: id,
  };
}

function registry() {
  return new SecretProviderRegistry().register(defineSecretProvider({
    name: "fixture-secret",
    async acquire(reference) {
      return SecretLease.fromUtf8(JSON.stringify({
        version: 1,
        authorization: `Bearer fixture-${reference}`,
        account_id: reference,
      }));
    },
  }));
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

async function modelRequest(origin) {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"input":"fixture"}',
  });
  assert.equal(response.status, 200);
  await response.text();
}

test("production runtime stops scheduling an account after a fresh weekly-only quota reaches zero", async (context) => {
  const upstreamAccounts = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    const accountId = request.headers["chatgpt-account-id"];
    upstreamAccounts.push(accountId);
    quotaSse(response, accountId === "account-a" ? 100 : 25);
  });
  context.after(() => close(upstream));
  const upstreamOrigin = await listen(upstream);
  const runtime = createRuntimeComposition({
    accounts: [
      account("account-a", "Account A", 10),
      account("account-b", "Account B", 0),
    ],
    adminAuthenticator: createAdminAuthenticator({ token: ADMIN_TOKEN }),
    adminPort: 0,
    modelPort: 0,
    now: () => NOW,
    secretRegistry: registry(),
    upstreamOrigin,
  });
  context.after(() => runtime.stop());
  const addresses = await runtime.start();
  const modelOrigin = `http://127.0.0.1:${addresses.model.port}`;
  const adminOrigin = `http://127.0.0.1:${addresses.admin.port}`;

  await modelRequest(modelOrigin);
  await modelRequest(modelOrigin);
  assert.deepEqual(upstreamAccounts, ["account-a", "account-b"]);

  const statusResponse = await fetch(`${adminOrigin}/v1/status`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status.accounts, [
    {
      alias: "Account A",
      state: "quota_exhausted",
      enabled: true,
      five_hour_remaining_ratio: null,
      weekly_remaining_ratio: 0,
      snapshot_observed_at: "2026-07-28T00:00:00.000Z",
      cooldown_until: "2026-07-28T01:00:00.000Z",
      last_switch_reason: "quota_exhausted",
    },
    {
      alias: "Account B",
      state: "healthy",
      enabled: true,
      five_hour_remaining_ratio: null,
      weekly_remaining_ratio: 0.75,
      snapshot_observed_at: "2026-07-28T00:00:00.000Z",
      cooldown_until: null,
      last_switch_reason: "quota_exhausted",
    },
  ]);
});
