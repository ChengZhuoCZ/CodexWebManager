import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import test from "node:test";
import { createQuotaSnapshotAdapter } from "../src/quota-snapshot.mjs";

const OBSERVED_AT = "2026-07-16T08:00:00.000Z";

function completeObservation() {
  return {
    observed_at: OBSERVED_AT,
    five_hour: {
      status: "available",
      remaining_ratio: 0.6,
      resets_at: "2026-07-16T10:00:00.000Z",
      confidence: "high",
    },
    weekly: {
      status: "available",
      remaining_ratio: 0.4,
      resets_at: "2026-07-20T00:00:00.000Z",
      confidence: "medium",
    },
  };
}

test("normalizes five-hour and weekly quota windows with observation metadata", async () => {
  const contexts = [];
  const adapter = createQuotaSnapshotAdapter({
    name: "fixture-quota",
    now: () => Date.parse("2026-07-16T08:02:00.000Z"),
    staleAfterMs: 5 * 60_000,
    async observe(context) {
      contexts.push(context);
      return completeObservation();
    },
  });
  const context = Object.freeze({ accountId: "fixture-account-a" });
  const snapshot = await adapter.read(context);

  assert.deepEqual(contexts, [context]);
  assert.equal(snapshot.adapter, "fixture-quota");
  assert.equal(snapshot.source_state, "available");
  assert.equal(snapshot.observed_at, OBSERVED_AT);
  assert.equal(snapshot.attempted_at, "2026-07-16T08:02:00.000Z");
  assert.equal(snapshot.staleness, "fresh");
  assert.equal(snapshot.age_ms, 120_000);
  assert.equal(snapshot.stale_after_ms, 300_000);
  assert.equal(snapshot.confidence, "medium");
  assert.deepEqual(snapshot.windows.five_hour, {
    status: "available",
    remaining_ratio: 0.6,
    resets_at: "2026-07-16T10:00:00.000Z",
    confidence: "high",
    reason: null,
  });
  assert.deepEqual(snapshot.windows.weekly, {
    status: "available",
    remaining_ratio: 0.4,
    resets_at: "2026-07-20T00:00:00.000Z",
    confidence: "medium",
    reason: null,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.windows), true);
  assert.equal(Object.isFrozen(snapshot.windows.five_hour), true);
});

test("re-evaluates staleness with a virtual clock without changing observed quota", async () => {
  let clock = Date.parse("2026-07-16T08:04:59.999Z");
  const adapter = createQuotaSnapshotAdapter({
    name: "fixture-quota",
    now: () => clock,
    staleAfterMs: 300_000,
    observe: async () => completeObservation(),
  });
  const fresh = await adapter.read();
  assert.equal(fresh.staleness, "fresh");
  assert.equal(fresh.age_ms, 299_999);

  clock = Date.parse("2026-07-16T08:05:00.000Z");
  const stale = adapter.refreshStaleness(fresh);
  assert.notEqual(stale, fresh);
  assert.equal(stale.staleness, "stale");
  assert.equal(stale.age_ms, 300_000);
  assert.equal(stale.observed_at, fresh.observed_at);
  assert.deepEqual(stale.windows, fresh.windows);
  assert.equal(fresh.staleness, "fresh");
});

test("represents a missing window as unknown instead of zero or full", async () => {
  const observation = completeObservation();
  delete observation.weekly;
  const adapter = createQuotaSnapshotAdapter({
    name: "fixture-quota",
    now: () => Date.parse(OBSERVED_AT),
    observe: async () => observation,
  });
  const snapshot = await adapter.read();
  assert.equal(snapshot.source_state, "partial");
  assert.equal(snapshot.confidence, "unknown");
  assert.equal(snapshot.windows.five_hour.remaining_ratio, 0.6);
  assert.deepEqual(snapshot.windows.weekly, {
    status: "unavailable",
    remaining_ratio: null,
    resets_at: null,
    confidence: "unknown",
    reason: "not_reported",
  });
});

test("represents unavailable and throwing sources without leaking or guessing", async () => {
  const unavailable = createQuotaSnapshotAdapter({
    name: "fixture-unavailable",
    now: () => Date.parse(OBSERVED_AT),
    observe: async () => null,
  });
  const missing = await unavailable.read();
  assert.equal(missing.source_state, "unavailable");
  assert.equal(missing.observed_at, null);
  assert.equal(missing.staleness, "unknown");
  assert.equal(missing.age_ms, null);
  assert.equal(missing.confidence, "unknown");
  for (const window of Object.values(missing.windows)) {
    assert.equal(window.remaining_ratio, null);
    assert.equal(window.confidence, "unknown");
    assert.equal(window.reason, "source_unavailable");
  }

  const secretCanary = "fixture-upstream-private-response";
  const throwing = createQuotaSnapshotAdapter({
    name: "fixture-error",
    now: () => Date.parse(OBSERVED_AT),
    observe: async () => { throw new Error(secretCanary); },
  });
  const failed = await throwing.read();
  assert.equal(failed.source_state, "unavailable");
  assert.equal(failed.windows.five_hour.reason, "source_error");
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(secretCanary));
});

test("fails closed on ambiguous percentages and malformed observations", async () => {
  const observations = [
    { observed_at: OBSERVED_AT, five_hour: { used_percent: 40 } },
    {
      ...completeObservation(),
      five_hour: { ...completeObservation().five_hour, remaining_ratio: -0.1 },
    },
    {
      ...completeObservation(),
      weekly: { ...completeObservation().weekly, confidence: "certain" },
    },
    { ...completeObservation(), observed_at: "not-a-time" },
    { ...completeObservation(), observed_at: "2026-02-30T08:00:00.000Z" },
    { ...completeObservation(), observed_at: "2026-07-16T08:00:31.000Z" },
    { ...completeObservation(), raw_upstream_payload: { remaining: 99 } },
  ];
  for (const observation of observations) {
    const adapter = createQuotaSnapshotAdapter({
      name: "fixture-invalid",
      now: () => Date.parse(OBSERVED_AT),
      observe: async () => observation,
    });
    const snapshot = await adapter.read();
    assert.equal(snapshot.source_state, "unavailable");
    assert.equal(snapshot.windows.five_hour.remaining_ratio, null);
    assert.equal(snapshot.windows.weekly.remaining_ratio, null);
    assert.equal(snapshot.windows.five_hour.reason, "invalid_observation");
  }
});

test("accepts explicit unavailable windows and rejects unsafe adapter configuration", async () => {
  const adapter = createQuotaSnapshotAdapter({
    name: "fixture-quota",
    now: () => Date.parse(OBSERVED_AT),
    observe: async () => ({
      observed_at: OBSERVED_AT,
      five_hour: { status: "unavailable", reason: "unsupported" },
      weekly: { status: "unavailable", reason: "not_reported" },
    }),
  });
  const snapshot = await adapter.read();
  assert.equal(snapshot.source_state, "unavailable");
  assert.equal(snapshot.windows.five_hour.reason, "unsupported");
  assert.equal(snapshot.windows.weekly.reason, "not_reported");

  for (const options of [
    {},
    { name: "bad name", observe: async () => null },
    { name: "fixture", observe: "not-a-function" },
    { name: "fixture", observe: async () => null, staleAfterMs: 0 },
  ]) {
    assert.throws(() => createQuotaSnapshotAdapter(options));
  }
  assert.throws(() => adapter.refreshStaleness({}), /snapshot/);
  assert.doesNotMatch(inspect(adapter), /observe|fixture-upstream-private-response/);
});

test("quota snapshot JSON schema matches nullable unknown-window semantics", async () => {
  const schemaUrl = new URL("../../../contracts/quota-snapshot.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.deepEqual(schema.required, [
    "adapter",
    "source_state",
    "attempted_at",
    "observed_at",
    "staleness",
    "age_ms",
    "stale_after_ms",
    "confidence",
    "windows",
  ]);
  const windowSchema = schema.$defs.window;
  assert.deepEqual(windowSchema.properties.remaining_ratio.type, ["number", "null"]);
  assert.ok(windowSchema.properties.confidence.enum.includes("unknown"));
  assert.equal(schema.properties.windows.required.includes("five_hour"), true);
  assert.equal(schema.properties.windows.required.includes("weekly"), true);
  assert.doesNotMatch(JSON.stringify(schema), /credential|token|authorization|email/i);
});
