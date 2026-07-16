import assert from "node:assert/strict";
import test from "node:test";
import { createAccountCatalog } from "../src/accounts.mjs";
import { createQuotaSnapshotAdapter } from "../src/quota-snapshot.mjs";
import { createDeterministicScheduler } from "../src/scheduler.mjs";

const NOW = Date.parse("2026-07-16T08:00:00.000Z");
const NOW_ISO = "2026-07-16T08:00:00.000Z";

function availableWindow(remainingRatio, confidence = "high") {
  return Object.freeze({
    status: "available",
    remaining_ratio: remainingRatio,
    resets_at: "2026-07-17T00:00:00.000Z",
    confidence,
    reason: null,
  });
}

function unavailableWindow(reason = "source_unavailable") {
  return Object.freeze({
    status: "unavailable",
    remaining_ratio: null,
    resets_at: null,
    confidence: "unknown",
    reason,
  });
}

function quota({
  fiveHour = 0.5,
  weekly = 0.5,
  confidence = "high",
  staleness = "fresh",
  sourceState = "available",
} = {}) {
  const unknown = sourceState === "unavailable";
  return Object.freeze({
    adapter: "fixture-quota",
    source_state: sourceState,
    attempted_at: NOW_ISO,
    observed_at: unknown ? null : NOW_ISO,
    staleness: unknown ? "unknown" : staleness,
    age_ms: unknown ? null : staleness === "stale" ? 300_000 : 0,
    stale_after_ms: 300_000,
    confidence: unknown ? "unknown" : confidence,
    windows: Object.freeze({
      five_hour: unknown ? unavailableWindow() : availableWindow(fiveHour, confidence),
      weekly: unknown ? unavailableWindow() : availableWindow(weekly, confidence),
    }),
  });
}

function account(id, { enabled = true, priority = 0, maxConcurrency = 2 } = {}) {
  return Object.freeze({
    id,
    alias: id.toUpperCase(),
    enabled,
    priority,
    max_concurrency: maxConcurrency,
    provider: "openai-codex",
  });
}

function candidate(id, {
  accountOptions,
  activeRequests = 0,
  cooldownUntil = null,
  quotaSnapshot = quota(),
} = {}) {
  return Object.freeze({
    account: account(id, accountOptions),
    active_requests: activeRequests,
    cooldown_until: cooldownUntil,
    quota: quotaSnapshot,
  });
}

test("selects equal candidates deterministically regardless of input order", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const a = candidate("account-a");
  const b = candidate("account-b");
  const c = candidate("account-c");
  for (const candidates of [[c, a, b], [b, c, a], [a, b, c]]) {
    const decision = scheduler.select(candidates);
    assert.equal(decision.status, "selected");
    assert.equal(decision.selected_account_id, "account-a");
    assert.equal(decision.selected_alias, "ACCOUNT-A");
    assert.deepEqual(decision.evaluations.map(({ account_id }) => account_id), [
      "account-a",
      "account-b",
      "account-c",
    ]);
  }
});

test("uses the conservative remaining quota and explicit confidence", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const decision = scheduler.select([
    candidate("account-a-less", { quotaSnapshot: quota({ fiveHour: 0.9, weekly: 0.2 }) }),
    candidate("account-z-more", { quotaSnapshot: quota({ fiveHour: 0.4, weekly: 0.4 }) }),
  ]);
  assert.equal(decision.selected_account_id, "account-z-more");
  assert.equal(decision.evaluations[0].remaining_ratio, 0.4);
  assert.equal(decision.evaluations[1].remaining_ratio, 0.2);

  const confidenceDecision = scheduler.select([
    candidate("account-a-low-confidence", {
      quotaSnapshot: quota({ fiveHour: 0.5, weekly: 0.5, confidence: "low" }),
    }),
    candidate("account-z-high-confidence", {
      quotaSnapshot: quota({ fiveHour: 0.5, weekly: 0.5, confidence: "high" }),
    }),
  ]);
  assert.equal(confidenceDecision.selected_account_id, "account-z-high-confidence");
});

test("represents operator priority before quota within the same certainty tier", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const decision = scheduler.select([
    candidate("account-default", { quotaSnapshot: quota({ fiveHour: 0.8, weekly: 0.8 }) }),
    candidate("account-priority", {
      accountOptions: { priority: 10 },
      quotaSnapshot: quota({ fiveHour: 0.2, weekly: 0.2 }),
    }),
  ]);
  assert.equal(decision.selected_account_id, "account-priority");
  assert.equal(decision.evaluations[0].priority, 10);
});

test("excludes active cooldowns and full accounts while preferring lower concurrency", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const decision = scheduler.select([
    candidate("account-cooling", { cooldownUntil: "2026-07-16T08:00:01.000Z" }),
    candidate("account-full", { activeRequests: 2 }),
    candidate("account-busy", { activeRequests: 1 }),
    candidate("account-free", { activeRequests: 0 }),
  ]);
  assert.equal(decision.selected_account_id, "account-free");
  const byId = Object.fromEntries(decision.evaluations.map((evaluation) => [evaluation.account_id, evaluation]));
  assert.equal(byId["account-cooling"].reason, "cooldown");
  assert.equal(byId["account-full"].reason, "concurrency_limit");
  assert.equal(byId["account-busy"].eligible, true);

  const boundary = scheduler.select([
    candidate("account-expired-cooldown", { cooldownUntil: NOW_ISO }),
  ]);
  assert.equal(boundary.selected_account_id, "account-expired-cooldown");
});

test("returns all_accounts_unavailable when every fresh snapshot is exhausted", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const decision = scheduler.select([
    candidate("account-a", { quotaSnapshot: quota({ fiveHour: 0, weekly: 0.8 }) }),
    candidate("account-b", { quotaSnapshot: quota({ fiveHour: 0.6, weekly: 0 }) }),
  ]);
  assert.equal(decision.status, "all_accounts_unavailable");
  assert.equal(decision.selected_account_id, null);
  assert.equal(decision.selected_alias, null);
  assert.equal(decision.evaluations.every(({ reason }) => reason === "quota_exhausted"), true);
});

test("lowers stale and unavailable quota to an explicit fallback tier without guessing", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const stale = candidate("account-stale", {
    accountOptions: { priority: 100 },
    quotaSnapshot: quota({ fiveHour: 1, weekly: 1, staleness: "stale" }),
  });
  const fresh = candidate("account-fresh", {
    quotaSnapshot: quota({ fiveHour: 0.01, weekly: 0.01 }),
  });
  const preferred = scheduler.select([stale, fresh]);
  assert.equal(preferred.selected_account_id, "account-fresh");
  const staleEvaluation = preferred.evaluations.find(({ account_id }) => account_id === "account-stale");
  assert.equal(staleEvaluation.quota_basis, "stale");
  assert.equal(staleEvaluation.remaining_ratio, null);

  const unknown = candidate("account-unknown", {
    quotaSnapshot: quota({ sourceState: "unavailable" }),
  });
  const fallback = scheduler.select([unknown, stale]);
  assert.equal(fallback.status, "selected");
  assert.equal(fallback.selected_account_id, "account-stale");
  for (const evaluation of fallback.evaluations) {
    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.remaining_ratio, null);
    assert.equal(["stale", "unavailable"].includes(evaluation.quota_basis), true);
  }
});

test("re-evaluates snapshot staleness against the scheduler clock", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW + 300_000 });
  const decision = scheduler.select([candidate("account-aged")]);
  assert.equal(decision.status, "selected");
  assert.equal(decision.evaluations[0].quota_staleness, "stale");
  assert.equal(decision.evaluations[0].quota_basis, "stale");
  assert.equal(decision.evaluations[0].remaining_ratio, null);
});

test("accepts the M1.2 public account and M2.1 canonical snapshot boundaries", async () => {
  const catalog = createAccountCatalog([{
    id: "fixture-account",
    alias: "Fixture Account",
    enabled: true,
    priority: 0,
    max_concurrency: 1,
    provider: "openai-codex",
    secret_provider: "file",
    credential_ref: "fixture-private-binding",
  }]);
  const adapter = createQuotaSnapshotAdapter({
    name: "fixture-quota",
    now: () => NOW,
    observe: async () => ({
      observed_at: NOW_ISO,
      five_hour: {
        status: "available",
        remaining_ratio: 0.5,
        confidence: "high",
      },
      weekly: {
        status: "available",
        remaining_ratio: 0.5,
        confidence: "high",
      },
    }),
  });
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const decision = scheduler.select([{
    account: catalog.getPublic("fixture-account"),
    active_requests: 0,
    cooldown_until: null,
    quota: await adapter.read(),
  }]);
  assert.equal(decision.selected_account_id, "fixture-account");
  assert.doesNotMatch(JSON.stringify(decision), /fixture-private-binding|credential_ref|secret_provider/);
});

test("represents disabled and explicitly excluded accounts", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const decision = scheduler.select([
    candidate("account-disabled", { accountOptions: { enabled: false } }),
    candidate("account-excluded"),
    candidate("account-selected"),
  ], { excludeAccountIds: ["account-excluded"] });
  assert.equal(decision.selected_account_id, "account-selected");
  const byId = Object.fromEntries(decision.evaluations.map((evaluation) => [evaluation.account_id, evaluation]));
  assert.equal(byId["account-disabled"].reason, "disabled");
  assert.equal(byId["account-excluded"].reason, "excluded");
});

test("rejects duplicate, malformed, or secret-bearing candidate inputs", () => {
  const scheduler = createDeterministicScheduler({ now: () => NOW });
  const a = candidate("account-a");
  assert.throws(() => scheduler.select([a, a]), /duplicate/);
  assert.throws(() => scheduler.select("not-an-array"), /array/);
  assert.throws(
    () => scheduler.select([{ ...a, credential_ref: "fixture-private-reference" }]),
    /unsupported candidate field/,
  );
  assert.throws(
    () => scheduler.select([{ ...a, active_requests: -1 }]),
    /active_requests/,
  );
  assert.throws(
    () => scheduler.select([{ ...a, quota: { ...a.quota, confidence: "certain" } }]),
    /quota snapshot/,
  );
  assert.throws(
    () => scheduler.select([a], { excludeAccountIds: ["missing"] }),
    /unknown excluded account/,
  );
  assert.throws(
    () => scheduler.select([a], { credential_ref: "fixture-private-reference" }),
    /unsupported scheduler selection option field/,
  );
});
