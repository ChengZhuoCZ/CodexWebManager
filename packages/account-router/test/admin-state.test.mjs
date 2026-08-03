import assert from "node:assert/strict";
import test from "node:test";
import { createAccountCatalog } from "../src/accounts.mjs";
import { createAdminState } from "../src/admin-state.mjs";
import { createEventBroker } from "../src/event-broker.mjs";

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
    {
      id: "account-b",
      alias: "Fixture B",
      enabled: false,
      priority: 1,
      max_concurrency: 1,
      provider: "openai-codex",
      secret_provider: "file",
      credential_ref: "fixture-credential-b",
    },
  ]);
}

test("returns sanitized account status and explicit LIMITED_MODE state", () => {
  const state = createAdminState({ accountCatalog: fixtureCatalog() });
  const snapshot = state.snapshot();
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.architecture_mode, "LIMITED_MODE");
  assert.equal(snapshot.cross_account_e2e_verified, false);
  assert.equal(snapshot.active_streams, 0);
  assert.equal(snapshot.active_requests, 0);
  assert.equal(snapshot.current_route, null);
  assert.deepEqual(snapshot.accounts.map(({ alias, state: accountState }) => [alias, accountState]), [
    ["Fixture A", "unknown"],
    ["Fixture B", "disabled"],
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /fixture-credential|credential_ref|secret_provider|email|token/i);
});

test("restores only the sanitized current-route projection without publishing a switch", () => {
  const state = createAdminState({
    accountCatalog: fixtureCatalog(),
    initialCurrentAccountId: "account-a",
  });
  assert.deepEqual(state.snapshot().current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });
  assert.equal(state.snapshot().accounts[0].last_switch_reason, null);
  assert.doesNotMatch(JSON.stringify(state.snapshot()), /account-a|credential|secret/i);
});

test("updates bounded runtime fields without exposing account IDs or credential bindings", () => {
  const state = createAdminState({ accountCatalog: fixtureCatalog() });
  state.updateAccountStatus("account-a", {
    state: "healthy",
    five_hour_remaining_ratio: 0.5,
    weekly_remaining_ratio: null,
    snapshot_observed_at: "2026-07-16T00:00:00.000Z",
    cooldown_until: null,
    last_switch_reason: "startup",
  });
  state.setActiveStreams(2);
  state.setActiveRequests(1);
  const snapshot = state.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.active_streams, 2);
  assert.equal(snapshot.active_requests, 1);
  assert.equal(snapshot.accounts[0].state, "healthy");
  assert.equal(snapshot.accounts[0].five_hour_remaining_ratio, 0.5);
  assert.equal(snapshot.accounts[0].id, undefined);
});

test("records sanitized switch events as explicit new backend sessions", () => {
  const broker = createEventBroker({ now: () => "2026-07-16T00:00:00.000Z" });
  const state = createAdminState({ accountCatalog: fixtureCatalog(), eventBroker: broker });
  const event = state.recordSwitch({
    fromAccountId: null,
    toAccountId: "account-a",
    reason: "manual",
  });
  assert.equal(event.type, "router.switch");
  assert.deepEqual(event.data, {
    from_alias: null,
    to_alias: "Fixture A",
    reason: "manual",
    attempts: 1,
    stage: "route_committed",
    continuity: "new_backend_session",
    architecture_mode: "LIMITED_MODE",
  });
  assert.deepEqual(state.snapshot().current_route, {
    account_alias: "Fixture A",
    continuity: "new_backend_session",
  });
  assert.doesNotMatch(JSON.stringify(event), /account-a|credential|secret/i);
});

test("rejects unsafe account state, stream counts, routes, and switch reasons", () => {
  const state = createAdminState({ accountCatalog: fixtureCatalog() });
  assert.throws(
    () => createAdminState({
      accountCatalog: fixtureCatalog(),
      initialCurrentAccountId: "missing",
    }),
    /initial current account/,
  );
  assert.throws(
    () => createAdminState({
      accountCatalog: fixtureCatalog(),
      initialCurrentAccountId: "account-b",
    }),
    /initial current account/,
  );
  assert.throws(() => state.setActiveStreams(-1), /active stream/);
  assert.throws(() => state.setActiveRequests(-1), /active request/);
  assert.throws(() => state.updateAccountStatus("missing", { state: "healthy" }), /unknown account/);
  assert.throws(() => state.updateAccountStatus("account-a", { state: "invented" }), /account state/);
  assert.throws(
    () => state.recordSwitch({ fromAccountId: null, toAccountId: "missing", reason: "manual" }),
    /unknown account/,
  );
  assert.throws(
    () => state.recordSwitch({ fromAccountId: null, toAccountId: "account-a", reason: "raw user text" }),
    /switch reason/,
  );
  assert.throws(
    () => state.recordSwitch({
      fromAccountId: null,
      toAccountId: "account-a",
      reason: "manual",
      attempts: 0,
    }),
    /switch attempts/,
  );
});
