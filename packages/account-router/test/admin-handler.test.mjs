import assert from "node:assert/strict";
import test from "node:test";
import { createAccountCatalog } from "../src/accounts.mjs";
import { createAdminAuthenticator } from "../src/admin-auth.mjs";
import { createAdminHandler } from "../src/admin-handler.mjs";
import { createAdminState } from "../src/admin-state.mjs";
import { createEventBroker } from "../src/event-broker.mjs";
import { createRouterService } from "../src/service.mjs";

const ADMIN_TOKEN = "fixture-admin-token-0123456789";
const AUTHORIZATION = { authorization: `Bearer ${ADMIN_TOKEN}` };

function fixtureCatalog() {
  return createAccountCatalog([
    {
      id: "account-a",
      alias: "Fixture A",
      enabled: true,
      priority: 0,
      max_concurrency: 1,
      provider: "openai-codex",
      secret_provider: "file",
      credential_ref: "fixture-credential-a",
    },
  ]);
}

async function createFixture(
  context,
  { onStatusRequest, onSwitchRequest, authenticator = undefined } = {},
) {
  const catalog = fixtureCatalog();
  const broker = createEventBroker();
  const state = createAdminState({ accountCatalog: catalog, eventBroker: broker });
  const adminHandler = createAdminHandler({
    authenticator:
      authenticator === undefined ? createAdminAuthenticator({ token: ADMIN_TOKEN }) : authenticator,
    state,
    eventBroker: broker,
    onStatusRequest,
    onSwitchRequest,
    requestBodyLimitBytes: 1_024,
    heartbeatMs: 0,
  });
  const service = createRouterService({
    adminPort: 0,
    getUsableAccountCount: () => 1,
    adminHandler,
  });
  context.after(() => service.stop());
  const address = await service.start();
  return { broker, state, origin: `http://127.0.0.1:${address.port}` };
}

test("keeps health public while protecting every admin JSON endpoint", async (context) => {
  const { origin } = await createFixture(context);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/readyz`)).status, 200);

  const missing = await fetch(`${origin}/v1/status`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="codex-router-admin"');

  const proxyCredential = await fetch(`${origin}/v1/status`, {
    headers: { "x-codex-proxy-token": ADMIN_TOKEN },
  });
  assert.equal(proxyCredential.status, 401);

  const status = await fetch(`${origin}/v1/status`, { headers: AUTHORIZATION });
  assert.equal(status.status, 200);
  const payload = await status.json();
  assert.equal(payload.architecture_mode, "LIMITED_MODE");
  assert.equal(payload.cross_account_e2e_verified, false);
  assert.equal(payload.accounts[0].alias, "Fixture A");
  assert.doesNotMatch(JSON.stringify(payload), /credential|secret|authorization|token|email/i);

  const accounts = await fetch(`${origin}/v1/accounts`, { headers: AUTHORIZATION });
  assert.equal(accounts.status, 200);
  assert.deepEqual((await accounts.json()).accounts.map(({ alias }) => alias), ["Fixture A"]);
});

test("returns 503 for admin endpoints when admin authentication is not configured", async (context) => {
  const { origin } = await createFixture(context, { authenticator: null });
  const response = await fetch(`${origin}/v1/status`, { headers: AUTHORIZATION });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "admin_auth_not_configured");
});

test("refreshes protected status lazily and fails closed when refresh fails", async (context) => {
  let refreshes = 0;
  const { origin } = await createFixture(context, {
    onStatusRequest() {
      refreshes += 1;
    },
  });
  assert.equal((await fetch(`${origin}/v1/status`, { headers: AUTHORIZATION })).status, 200);
  assert.equal((await fetch(`${origin}/v1/accounts`, { headers: AUTHORIZATION })).status, 200);
  assert.equal(refreshes, 2);

  const failing = await createFixture(context, {
    onStatusRequest() {
      throw new Error("fixture refresh failure");
    },
  });
  const response = await fetch(`${failing.origin}/v1/status`, { headers: AUTHORIZATION });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "status_refresh_failed" });
});

test("validates and records an injected manual switch without claiming seamless continuity", async (context) => {
  const calls = [];
  const { origin, state } = await createFixture(context, {
    async onSwitchRequest(request) {
      calls.push(request);
      return { accepted: true, fromAccountId: null, toAccountId: "account-a", reason: "manual" };
    },
  });
  const response = await fetch(`${origin}/v1/switch`, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json" },
    body: JSON.stringify({
      account_alias: "Fixture A",
      routing_session_id: "fixture-session",
      reason: "manual",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    accepted: true,
    account_alias: "Fixture A",
    continuity: "new_backend_session",
    architecture_mode: "LIMITED_MODE",
  });
  assert.deepEqual(calls, [
    {
      accountAlias: "Fixture A",
      routingSessionId: "fixture-session",
      reason: "manual",
    },
  ]);
  assert.equal(state.snapshot().current_route.account_alias, "Fixture A");
});

test("rejects manual switch during active streams and fails closed on invalid bodies", async (context) => {
  let called = false;
  const { origin, state } = await createFixture(context, {
    async onSwitchRequest() {
      called = true;
      return { accepted: false };
    },
  });
  state.setActiveStreams(1);
  const active = await fetch(`${origin}/v1/switch`, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json" },
    body: '{"account_alias":"Fixture A","reason":"manual"}',
  });
  assert.equal(active.status, 409);
  assert.equal((await active.json()).error, "active_semantic_stream");
  assert.equal(called, false);
  state.setActiveStreams(0);

  const secretCanary = "fixture-secret-reference";
  const unknownField = await fetch(`${origin}/v1/switch`, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json" },
    body: JSON.stringify({ account_alias: "Fixture A", reason: "manual", credential_ref: secretCanary }),
  });
  assert.equal(unknownField.status, 400);
  assert.doesNotMatch(await unknownField.text(), new RegExp(secretCanary));

  const oversized = await fetch(`${origin}/v1/switch`, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json" },
    body: JSON.stringify({ account_alias: "A".repeat(2_000), reason: "manual" }),
  });
  assert.equal(oversized.status, 413);
});

test("streams sanitized switch events and releases the subscriber on cancellation", async (context) => {
  const { origin, state, broker } = await createFixture(context);
  const controller = new AbortController();
  const response = await fetch(`${origin}/v1/events`, {
    headers: AUTHORIZATION,
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });
  state.recordSwitch({ fromAccountId: null, toAccountId: "account-a", reason: "manual" });
  const deadline = Date.now() + 2_000;
  while (!text.includes("router.switch") && Date.now() < deadline) {
    const next = await reader.read();
    text += decoder.decode(next.value, { stream: true });
  }
  assert.match(text, /event: router\.switch/);
  assert.match(text, /new_backend_session/);
  assert.doesNotMatch(text, /fixture-credential|secret_provider|credential_ref/);
  controller.abort();
  await assert.rejects(reader.read(), /abort|terminated|closed/i);
  const cleanupDeadline = Date.now() + 2_000;
  while (broker.subscriberCount !== 0 && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.subscriberCount, 0);
});
