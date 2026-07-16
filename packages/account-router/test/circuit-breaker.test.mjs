import assert from "node:assert/strict";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";

const START = Date.parse("2026-07-16T08:00:00.000Z");

function fixtureBreaker(overrides = {}) {
  let clock = START;
  const breaker = createCircuitBreaker({
    now: () => clock,
    cooldowns: {
      quota_exhausted: 1_000,
      auth_expired: 2_000,
      rate_limited: 3_000,
      network_error: 4_000,
      upstream_5xx: 5_000,
    },
    maxCooldownMs: 10_000,
    halfOpenMaxProbes: 1,
    ...overrides,
  });
  return {
    breaker,
    setClock(value) {
      clock = value;
    },
  };
}

test("applies distinct bounded cooldowns for quota, auth, 429, network, and 5xx", () => {
  const expected = {
    quota_exhausted: 1_000,
    auth_expired: 2_000,
    rate_limited: 3_000,
    network_error: 4_000,
    upstream_5xx: 5_000,
  };
  for (const [kind, duration] of Object.entries(expected)) {
    const { breaker } = fixtureBreaker();
    const state = breaker.recordFailure(`account-${kind}`, { kind });
    assert.equal(state.phase, "open");
    assert.equal(state.last_failure_kind, kind);
    assert.equal(Date.parse(state.cooldown_until) - START, duration);
    assert.equal(state.consecutive_failures, 1);
  }

  const { breaker } = fixtureBreaker();
  const clamped = breaker.recordFailure("account-rate", {
    kind: "rate_limited",
    retryAfterMs: 60_000,
  });
  assert.equal(Date.parse(clamped.cooldown_until) - START, 10_000);
  assert.throws(
    () => breaker.recordFailure("account-network", { kind: "network_error", retryAfterMs: 1_000 }),
    /retryAfterMs/,
  );
});

test("opens, denies during cooldown, and grants a bounded half-open probe", () => {
  const { breaker, setClock } = fixtureBreaker();
  breaker.recordFailure("account-a", { kind: "network_error" });
  const denied = breaker.tryAcquire("account-a");
  assert.deepEqual(denied, {
    allowed: false,
    probe: false,
    probe_token: null,
    phase: "open",
    reason: "cooldown",
    cooldown_until: "2026-07-16T08:00:04.000Z",
  });

  setClock(START + 4_000);
  const first = breaker.tryAcquire("account-a");
  assert.equal(first.allowed, true);
  assert.equal(first.probe, true);
  assert.equal(typeof first.probe_token, "string");
  assert.equal(first.phase, "half_open");
  const second = breaker.tryAcquire("account-a");
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "half_open_limit");
  assert.equal(breaker.snapshot("account-a").half_open_in_flight, 1);

  assert.equal(breaker.releaseProbe("account-a", first.probe_token), true);
  assert.equal(breaker.snapshot("account-a").half_open_in_flight, 0);
  const replacement = breaker.tryAcquire("account-a");
  assert.notEqual(replacement.probe_token, first.probe_token);
  assert.throws(() => breaker.releaseProbe("account-a", first.probe_token), /probe token/);
});

test("closes on a successful half-open probe and rejects stale completions", () => {
  const { breaker, setClock } = fixtureBreaker();
  breaker.recordFailure("account-a", { kind: "upstream_5xx" });
  setClock(START + 5_000);
  const probe = breaker.tryAcquire("account-a");
  const closed = breaker.recordSuccess("account-a", { probeToken: probe.probe_token });
  assert.equal(closed.phase, "closed");
  assert.equal(closed.cooldown_until, null);
  assert.equal(closed.consecutive_failures, 0);
  assert.equal(closed.last_success_at, "2026-07-16T08:00:05.000Z");
  assert.throws(
    () => breaker.recordFailure("account-a", { kind: "network_error", probeToken: probe.probe_token }),
    /probe token/,
  );
  assert.equal(breaker.recordSuccess("account-a").phase, "closed");
});

test("reopens after a failed half-open probe and invalidates every outstanding lease", () => {
  const { breaker, setClock } = fixtureBreaker({ halfOpenMaxProbes: 2 });
  breaker.recordFailure("account-a", { kind: "network_error" });
  setClock(START + 4_000);
  const first = breaker.tryAcquire("account-a");
  const second = breaker.tryAcquire("account-a");
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  const reopened = breaker.recordFailure("account-a", {
    kind: "upstream_5xx",
    probeToken: first.probe_token,
  });
  assert.equal(reopened.phase, "open");
  assert.equal(reopened.last_failure_kind, "upstream_5xx");
  assert.equal(reopened.half_open_in_flight, 0);
  assert.throws(
    () => breaker.recordSuccess("account-a", { probeToken: second.probe_token }),
    /probe token/,
  );
});

test("exports deterministic secret-free state and restores with no in-flight probes", () => {
  const { breaker, setClock } = fixtureBreaker();
  breaker.recordFailure("account-b", { kind: "auth_expired" });
  breaker.recordFailure("account-a", { kind: "quota_exhausted" });
  setClock(START + 1_000);
  const probe = breaker.tryAcquire("account-a");
  assert.equal(probe.probe, true);
  const document = breaker.exportState();
  assert.deepEqual(document.accounts.map(({ account_id }) => account_id), ["account-a", "account-b"]);
  assert.doesNotMatch(JSON.stringify(document), /probe_token|credential|secret|authorization|email/i);

  const restored = createCircuitBreaker({
    now: () => START + 1_000,
    cooldowns: {
      quota_exhausted: 1_000,
      auth_expired: 2_000,
      rate_limited: 3_000,
      network_error: 4_000,
      upstream_5xx: 5_000,
    },
    maxCooldownMs: 10_000,
    halfOpenMaxProbes: 1,
    initialState: document,
  });
  assert.equal(restored.snapshot("account-a").phase, "half_open");
  assert.equal(restored.snapshot("account-a").half_open_in_flight, 0);
  assert.equal(restored.snapshot("account-b").phase, "open");
  assert.equal(restored.tryAcquire("account-a").probe, true);

  const rolledBack = createCircuitBreaker({
    now: () => START,
    cooldowns: {
      quota_exhausted: 1_000,
      auth_expired: 2_000,
      rate_limited: 3_000,
      network_error: 4_000,
      upstream_5xx: 5_000,
    },
    maxCooldownMs: 10_000,
    initialState: document,
  });
  const rollbackDecision = rolledBack.tryAcquire("account-a");
  assert.equal(rollbackDecision.allowed, false);
  assert.equal(rollbackDecision.reason, "cooldown");
});

test("rejects malformed identifiers, failure types, policy, and restored documents", () => {
  const { breaker } = fixtureBreaker();
  assert.throws(() => breaker.tryAcquire("bad account"), /account id/);
  assert.throws(() => breaker.recordFailure("account-a", { kind: "invented" }), /failure kind/);
  assert.throws(() => breaker.recordSuccess("account-missing", { probeToken: "invented" }), /probe token/);
  assert.throws(() => createCircuitBreaker({ now: "clock" }), /clock/);
  assert.throws(() => createCircuitBreaker({ cooldowns: {} }), /cooldown/);
  assert.throws(
    () => createCircuitBreaker({ initialState: { version: 1, saved_at: "bad", accounts: [] } }),
    /state document/,
  );
  assert.throws(
    () => createCircuitBreaker({
      initialState: {
        version: 1,
        saved_at: "2026-07-16T08:00:00.000Z",
        accounts: [{
          account_id: "account-a",
          phase: "half_open",
          last_failure_kind: "network_error",
          opened_at: "2026-07-16T08:00:00.000Z",
          cooldown_until: "2026-07-16T08:00:01.000Z",
          consecutive_failures: 1,
          last_failure_at: "2026-07-16T08:00:00.000Z",
          last_success_at: null,
          generation: 1,
        }],
      },
    }),
    /state document/,
  );
});
