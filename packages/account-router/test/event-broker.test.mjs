import assert from "node:assert/strict";
import test from "node:test";
import { createEventBroker } from "../src/event-broker.mjs";

test("keeps a bounded sanitized backlog and publishes ordered event IDs", () => {
  const broker = createEventBroker({ maxEvents: 2, now: () => "2026-07-16T00:00:00.000Z" });
  const first = broker.publish({
    type: "router.started",
    data: { status: "ready", authorization: "Bearer fixture-secret" },
  });
  const second = broker.publish({ type: "account.state", data: { alias: "Fixture A" } });
  const third = broker.publish({ type: "account.state", data: { alias: "Fixture B" } });
  assert.deepEqual([first.id, second.id, third.id], ["1", "2", "3"]);
  assert.deepEqual(broker.snapshot().map(({ id }) => id), ["2", "3"]);
  assert.doesNotMatch(JSON.stringify(first), /fixture-secret/);
  assert.match(JSON.stringify(first), /REDACTED/);
  assert.equal(Object.isFrozen(third), true);
  assert.equal(Object.isFrozen(third.data), true);
});

test("subscribers receive backlog plus live events and can unsubscribe", () => {
  const broker = createEventBroker({ maxEvents: 4 });
  broker.publish({ type: "router.started", data: { status: "ready" } });
  const received = [];
  const unsubscribe = broker.subscribe((event) => received.push(event), { afterId: "0" });
  assert.deepEqual(received.map(({ id }) => id), ["1"]);
  broker.publish({ type: "account.state", data: { alias: "Fixture A" } });
  assert.deepEqual(received.map(({ id }) => id), ["1", "2"]);
  assert.equal(broker.subscriberCount, 1);
  unsubscribe();
  assert.equal(broker.subscriberCount, 0);
  broker.publish({ type: "account.state", data: { alias: "Fixture B" } });
  assert.deepEqual(received.map(({ id }) => id), ["1", "2"]);
});

test("removes a subscriber when backlog replay throws", () => {
  const broker = createEventBroker();
  broker.publish({ type: "router.started", data: { status: "ready" } });
  assert.throws(
    () => broker.subscribe(() => { throw new Error("fixture subscriber failure"); }),
    /fixture subscriber failure/,
  );
  assert.equal(broker.subscriberCount, 0);
});

test("rejects malformed event types, payloads, and subscription cursors", () => {
  const broker = createEventBroker();
  for (const type of ["", "UPPERCASE", "contains spaces", "../escape", null]) {
    assert.throws(() => broker.publish({ type, data: {} }), /event type/);
  }
  assert.throws(() => broker.publish({ type: "fixture.event", data: "not-object" }), /event data/);
  assert.throws(() => broker.subscribe(() => undefined, { afterId: "invalid" }), /event cursor/);
});
