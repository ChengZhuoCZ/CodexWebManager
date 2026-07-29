import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import {
  createWeeklyQuotaTracker,
  parseRateLimitSseEvent,
} from "../src/weekly-quota-tracker.mjs";

const OBSERVED_AT_MS = Date.parse("2026-07-28T00:00:00.000Z");

function weeklyEvent({
  usedPercent = 25,
  resetAt = 1_785_196_800,
  slot = "secondary",
} = {}) {
  return {
    type: "codex.rate_limits",
    rate_limits: {
      [slot]: {
        used_percent: usedPercent,
        window_minutes: 10_080,
        reset_at: resetAt,
      },
    },
  };
}

test("records only the documented weekly Codex window as a sanitized observation", () => {
  const tracker = createWeeklyQuotaTracker({
    accountIds: ["account-a"],
    now: () => OBSERVED_AT_MS,
  });

  assert.equal(tracker.observe("account-a", weeklyEvent()), true);
  assert.deepEqual(tracker.read("account-a"), {
    observed_at: "2026-07-28T00:00:00.000Z",
    five_hour: { status: "unavailable", reason: "unsupported" },
    weekly: {
      status: "available",
      remaining_ratio: 0.75,
      resets_at: "2026-07-28T00:00:00.000Z",
      confidence: "high",
    },
  });
  assert.equal(Object.isFrozen(tracker.read("account-a")), true);
  assert.doesNotMatch(inspect(tracker), /rate_limits|used_percent|reset_at/);
});

test("accepts a weekly primary slot and a one-minute duration normalization", () => {
  const tracker = createWeeklyQuotaTracker({
    accountIds: ["account-a"],
    now: () => OBSERVED_AT_MS,
  });
  const event = weeklyEvent({ slot: "primary", usedPercent: 40, resetAt: null });
  event.rate_limits.primary.window_minutes = 10_079;

  assert.equal(tracker.observe("account-a", event), true);
  assert.deepEqual(tracker.read("account-a").weekly, {
    status: "available",
    remaining_ratio: 0.6,
    resets_at: null,
    confidence: "high",
  });
});

test("exports and restores only deterministic sanitized weekly state", () => {
  const tracker = createWeeklyQuotaTracker({
    accountIds: ["account-b", "account-a"],
    initialState: [
      {
        account_id: "account-a",
        observed_at: "2026-07-27T08:00:00.000Z",
        remaining_ratio: 0,
        resets_at: "2026-07-28T00:00:00.000Z",
      },
    ],
    now: () => OBSERVED_AT_MS,
  });
  tracker.observe("account-b", weeklyEvent({ usedPercent: 25 }));
  assert.deepEqual(tracker.exportState(), [
    {
      account_id: "account-a",
      observed_at: "2026-07-27T08:00:00.000Z",
      remaining_ratio: 0,
      resets_at: "2026-07-28T00:00:00.000Z",
    },
    {
      account_id: "account-b",
      observed_at: "2026-07-28T00:00:00.000Z",
      remaining_ratio: 0.75,
      resets_at: "2026-07-28T00:00:00.000Z",
    },
  ]);
  assert.equal(tracker.read("account-a").weekly.remaining_ratio, 0);
  assert.doesNotMatch(
    JSON.stringify(tracker.exportState()),
    /credential|secret|authorization|token|email/i,
  );

  assert.throws(
    () => createWeeklyQuotaTracker({
      accountIds: ["account-a"],
      initialState: [{
        account_id: "account-a",
        observed_at: "2026-07-27T08:00:00.000Z",
        remaining_ratio: 0,
        resets_at: "2026-07-28T00:00:00.000Z",
        credential_ref: "fixture-private-reference",
      }],
    }),
    /weekly quota state/,
  );
});

test("extracts only a codex.rate_limits JSON object from bounded SSE bytes", () => {
  const event = weeklyEvent({ usedPercent: 100 });
  const bytes = Buffer.from(
    `event: codex.rate_limits\ndata: ${JSON.stringify(event)}\n\n`,
  );
  assert.deepEqual(parseRateLimitSseEvent(bytes), event);
  assert.equal(
    parseRateLimitSseEvent(Buffer.from(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"private"}\n\n',
    )),
    null,
  );
});

test("keeps the last valid weekly observation when later events are malformed or unrelated", () => {
  const tracker = createWeeklyQuotaTracker({
    accountIds: ["account-a"],
    now: () => OBSERVED_AT_MS,
  });
  assert.equal(tracker.observe("account-a", weeklyEvent({ usedPercent: 10 })), true);
  const valid = tracker.read("account-a");

  for (const event of [
    null,
    { type: "response.created" },
    { ...weeklyEvent(), metered_limit_name: "codex_other" },
    weeklyEvent({ usedPercent: -1 }),
    weeklyEvent({ usedPercent: 101 }),
    {
      type: "codex.rate_limits",
      rate_limits: {
        primary: {
          used_percent: 50,
          window_minutes: 300,
          reset_at: 1_785_196_800,
        },
      },
    },
    {
      type: "codex.rate_limits",
      rate_limits: {
        primary: weeklyEvent().rate_limits.secondary,
        secondary: weeklyEvent().rate_limits.secondary,
      },
    },
  ]) {
    assert.equal(tracker.observe("account-a", event), false);
    assert.equal(tracker.read("account-a"), valid);
  }
});

test("rejects unknown accounts and unsafe tracker configuration without retaining events", () => {
  const tracker = createWeeklyQuotaTracker({
    accountIds: ["account-a"],
    now: () => OBSERVED_AT_MS,
  });
  assert.throws(() => tracker.observe("missing", weeklyEvent()), /unknown account/);
  assert.equal(tracker.read("account-a"), null);
  assert.throws(() => tracker.read("missing"), /unknown account/);

  for (const options of [
    {},
    { accountIds: ["bad id"] },
    { accountIds: ["account-a", "account-a"] },
    { accountIds: ["account-a"], now: "not-a-function" },
  ]) {
    assert.throws(() => createWeeklyQuotaTracker(options));
  }
});
