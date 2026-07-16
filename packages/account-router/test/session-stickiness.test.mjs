import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { createSessionStickiness } from "../src/session-stickiness.mjs";

const START = Date.parse("2026-07-16T08:00:00.000Z");

function fixtureStore(options = {}) {
  let clock = START;
  const store = createSessionStickiness({
    now: () => clock,
    ttlMs: 10_000,
    maxEntries: 3,
    maxActiveStreamsPerSession: 1,
    ...options,
  });
  return {
    store,
    setClock(value) {
      clock = value;
    },
  };
}

function assign(store, {
  routingSessionId = "route-a",
  accountId = "account-a",
  backendSessionId = "backend-a",
} = {}) {
  return store.assign({ routingSessionId, accountId, backendSessionId });
}

test("keeps an account and backend session immutable during an active semantic stream", () => {
  const { store } = fixtureStore();
  const initial = assign(store);
  assert.equal(initial.transition, "initial_backend_session");
  assert.equal(initial.continuity, "new_backend_session");
  assert.equal(initial.architecture_mode, "LIMITED_MODE");
  assert.equal(initial.cross_account_e2e_verified, false);

  const lease = store.beginSemanticStream("route-a");
  assert.equal(lease.account_id, "account-a");
  assert.equal(lease.backend_session_id, "backend-a");
  assert.equal(lease.continuity, "existing_backend_session");
  assert.throws(
    () => assign(store, { accountId: "account-b", backendSessionId: "backend-b" }),
    /active semantic stream/,
  );
  assert.throws(
    () => assign(store, { backendSessionId: "backend-new" }),
    /active semantic stream/,
  );
  assert.deepEqual(
    [store.resolve("route-a").account_id, store.resolve("route-a").backend_session_id],
    ["account-a", "backend-a"],
  );
  assert.equal(store.endSemanticStream(lease.stream_token), true);
});

test("switches only at a safe boundary and labels LIMITED_MODE as a new backend session", () => {
  const { store } = fixtureStore();
  assign(store);
  const changed = assign(store, {
    accountId: "account-b",
    backendSessionId: "backend-b",
  });
  assert.equal(changed.transition, "limited_mode_new_session");
  assert.equal(changed.continuity, "new_backend_session");
  assert.equal(changed.route.account_id, "account-b");
  assert.equal(changed.route.backend_session_id, "backend-b");
  assert.throws(
    () => assign(store, { accountId: "account-c", backendSessionId: "backend-b" }),
    /new backend session/,
  );

  const sticky = assign(store, { accountId: "account-b", backendSessionId: "backend-b" });
  assert.equal(sticky.transition, "sticky_backend_session");
  assert.equal(sticky.continuity, "existing_backend_session");
});

test("expires inactive mappings at the exact TTL boundary", () => {
  const { store, setClock } = fixtureStore();
  assign(store);
  setClock(START + 9_999);
  assert.equal(store.resolve("route-a").account_id, "account-a");
  setClock(START + 10_000);
  assert.equal(store.resolve("route-a"), null);
  assert.equal(store.size, 0);
});

test("does not expire an active stream and restarts TTL after completion", () => {
  const { store, setClock } = fixtureStore();
  assign(store);
  const lease = store.beginSemanticStream("route-a");
  setClock(START + 60_000);
  assert.equal(store.prune(), 0);
  assert.equal(store.resolve("route-a").active_semantic_streams, 1);
  store.endSemanticStream(lease.stream_token);
  assert.equal(store.resolve("route-a").expires_at, "2026-07-16T08:01:10.000Z");
  setClock(START + 70_000);
  assert.equal(store.resolve("route-a"), null);
});

test("bounds storage with deterministic inactive LRU eviction and never evicts active mappings", () => {
  const { store, setClock } = fixtureStore({ maxEntries: 2 });
  assign(store, { routingSessionId: "route-a", backendSessionId: "backend-a" });
  setClock(START + 1);
  assign(store, { routingSessionId: "route-b", backendSessionId: "backend-b" });
  setClock(START + 2);
  assign(store, { routingSessionId: "route-c", backendSessionId: "backend-c" });
  assert.equal(store.resolve("route-a"), null);
  assert.deepEqual(store.listSnapshots().map(({ routing_session_id }) => routing_session_id), [
    "route-b",
    "route-c",
  ]);

  const b = store.beginSemanticStream("route-b");
  const c = store.beginSemanticStream("route-c");
  assert.throws(
    () => assign(store, { routingSessionId: "route-d", backendSessionId: "backend-d" }),
    /capacity/,
  );
  store.endSemanticStream(b.stream_token);
  store.endSemanticStream(c.stream_token);
});

test("bounds semantic stream leases and rejects stale or foreign tokens", () => {
  const { store } = fixtureStore({ maxActiveStreamsPerSession: 1 });
  assign(store);
  const lease = store.beginSemanticStream("route-a");
  assert.throws(() => store.beginSemanticStream("route-a"), /stream limit/);
  assert.throws(() => store.endSemanticStream("invented-token"), /stream token/);
  assert.equal(store.endSemanticStream(lease.stream_token), true);
  assert.throws(() => store.endSemanticStream(lease.stream_token), /stream token/);
});

test("rejects previous-response state, secret-bearing fields, duplicate backend ownership, and unsafe IDs", () => {
  const { store } = fixtureStore();
  assign(store);
  assert.throws(
    () => store.assign({
      routingSessionId: "route-b",
      accountId: "account-b",
      backendSessionId: "backend-b",
      previous_response_id: "fixture-upstream-response",
    }),
    /unsupported assignment field/,
  );
  assert.throws(
    () => store.assign({
      routingSessionId: "route-b",
      accountId: "account-b",
      backendSessionId: "backend-b",
      credential_ref: "fixture-private-reference",
    }),
    /unsupported assignment field/,
  );
  assert.throws(
    () => assign(store, { routingSessionId: "route-b", backendSessionId: "backend-a" }),
    /backend session.*assigned/,
  );
  assert.throws(
    () => assign(store, { routingSessionId: "bad route" }),
    /routing session/,
  );
  assert.doesNotMatch(JSON.stringify(store.listSnapshots()), /credential|secret|previous_response/i);
  assert.doesNotMatch(inspect(store), /fixture-private-reference|previous_response/);
});

test("deletes only inactive mappings and reports bounded configuration errors", () => {
  const { store } = fixtureStore();
  assign(store);
  const lease = store.beginSemanticStream("route-a");
  assert.throws(() => store.deleteSession("route-a"), /active semantic stream/);
  store.endSemanticStream(lease.stream_token);
  assert.equal(store.deleteSession("route-a"), true);
  assert.equal(store.deleteSession("route-a"), false);
  for (const options of [
    { now: "not-a-function" },
    { ttlMs: 0 },
    { maxEntries: 0 },
    { maxActiveStreamsPerSession: 0 },
  ]) {
    assert.throws(() => createSessionStickiness(options));
  }
});
