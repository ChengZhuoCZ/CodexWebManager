import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeIdentitySyncController,
  createSanitizedIdentitySyncLogger,
  sanitizedEventStreamFailure,
} from "../src/native-identity-sync.mjs";

test("router switch events reconcile native identity immediately with bounded busy retry", async () => {
  let time = Date.parse("2026-08-04T00:00:00.000Z");
  let reconcileCalls = 0;
  let restartCalls = 0;
  const telemetry = [];
  const controller = createNativeIdentitySyncController({
    reconcile: async () => {
      reconcileCalls += 1;
      if (reconcileCalls === 1) {
        throw new Error("native account rebind failed", {
          cause: new Error("router is not idle"),
        });
      }
      return { rebound: true, account_alias: "must-not-be-observed" };
    },
    restartWeb: async () => { restartCalls += 1; },
    emitTelemetry: (record) => telemetry.push(record),
    now: () => time,
    sleep: async (milliseconds) => { time += milliseconds; },
    retryDeadlineMs: 1_000,
  });

  await controller.triggerEvent({
    reason: "quota_exhausted",
    routeAttempts: 2,
    timestamp: "2026-08-04T00:00:00.000Z",
  });

  assert.equal(reconcileCalls, 2);
  assert.equal(restartCalls, 1);
  assert.deepEqual(telemetry, [{
    event: "native_identity_sync",
    trigger: "router_switch_event",
    stage: "completed",
    switch_reason: "quota_exhausted",
    route_attempts: 2,
    sync_attempts: 2,
    elapsed_ms: 50,
    credentials_exposed: false,
  }]);
  assert.doesNotMatch(JSON.stringify(telemetry), /must-not-be-observed|alias|token|prompt|response/i);
});

test("poll fallback stays silent on no-op and records only a sanitized rebound", async () => {
  const telemetry = [];
  let reconcileCalls = 0;
  let restartCalls = 0;
  const controller = createNativeIdentitySyncController({
    reconcile: async () => ({ rebound: ++reconcileCalls === 2 }),
    restartWeb: async () => { restartCalls += 1; },
    emitTelemetry: (record) => telemetry.push(record),
  });

  await controller.triggerFallback();
  await controller.triggerFallback();

  assert.equal(restartCalls, 1);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].trigger, "poll_fallback");
  assert.equal(telemetry[0].stage, "completed");
  assert.equal(telemetry[0].switch_reason, null);
});

test("sanitized identity telemetry rejects extra or sensitive fields", () => {
  const lines = [];
  const logger = createSanitizedIdentitySyncLogger((line) => lines.push(line));
  const safe = sanitizedEventStreamFailure({ attempts: 1, elapsedMs: 25 });
  logger(safe);
  assert.deepEqual(JSON.parse(lines[0]), safe);
  assert.throws(() => logger({ ...safe, account_alias: "forbidden" }), /telemetry is invalid/);
  assert.doesNotMatch(lines[0], /alias|token|prompt|response|authorization/i);
});
