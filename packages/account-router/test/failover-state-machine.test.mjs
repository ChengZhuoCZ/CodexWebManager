import assert from "node:assert/strict";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import {
  createFailoverStateMachine,
  FailoverAttemptError,
  FailoverResultError,
  failoverErrorBody,
} from "../src/failover-state-machine.mjs";
import { classifyResponseEvent, isSemanticResponseEvent } from "../src/semantic-events.mjs";

function selector(accounts, seen = []) {
  let index = 0;
  return async (context) => {
    seen.push([...context.excludeAccountIds]);
    const accountId = accounts[index++] ?? null;
    return accountId === null ? null : { accountId };
  };
}

test("classifies only explicit lifecycle metadata as pre-semantic", () => {
  for (const type of [
    "response.created",
    "response.in_progress",
    "response.queued",
    "codex.rate_limits",
    "codex.response.metadata",
  ]) {
    assert.equal(classifyResponseEvent(type), "preflight");
    assert.equal(isSemanticResponseEvent(type), false);
  }
  for (const type of [
    "response.output_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
    "response.custom_tool_call_input.delta",
    "response.output_item.added",
    "response.completed",
    "error",
    null,
  ]) {
    assert.notEqual(classifyResponseEvent(type), "preflight");
    assert.equal(isSemanticResponseEvent(type), true);
  }
});

test("retries a replayable initial request on a different account before semantic output", async () => {
  const exclusions = [];
  const sleeps = [];
  const failures = [];
  const releases = [];
  const machine = createFailoverStateMachine({
    maxAttempts: 3,
    totalDeadlineMs: 1_000,
    baseBackoffMs: 10,
    maxBackoffMs: 50,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  const result = await machine.execute({
    replayPolicy: "initial_request",
    async selectAccount(context) {
      const accountId = ["A", "B"][exclusions.length];
      exclusions.push([...context.excludeAccountIds]);
      return { accountId, release() { releases.push(accountId); } };
    },
    async attempt({ accountId, observeEvent }) {
      observeEvent("response.created");
      if (accountId === "A") {
        throw new FailoverAttemptError("network_error");
      }
      observeEvent("response.output_text.delta");
      return "fixture-complete";
    },
    async onAttemptFailure(failure) { failures.push(failure); },
  });
  assert.deepEqual(exclusions, [[], ["A"]]);
  assert.deepEqual(sleeps, [10]);
  assert.deepEqual(releases, ["A", "B"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].accountId, "A");
  assert.equal(failures[0].kind, "network_error");
  assert.deepEqual(result, {
    status: "completed",
    attempts: 2,
    semantic_output: true,
    value: "fixture-complete",
  });
});

test("never retries after output text, reasoning, or function arguments are committed", async () => {
  for (const eventType of [
    "response.output_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
  ]) {
    let selections = 0;
    const machine = createFailoverStateMachine({ sleep: async () => undefined });
    await assert.rejects(
      machine.execute({
        replayPolicy: "initial_request",
        async selectAccount() {
          selections += 1;
          return { accountId: selections === 1 ? "A" : "B" };
        },
        async attempt({ observeEvent }) {
          observeEvent("response.created");
          observeEvent(eventType);
          throw new FailoverAttemptError("network_error");
        },
      }),
      (error) => {
        assert.ok(error instanceof FailoverResultError);
        assert.equal(error.code, "unsafe_to_replay");
        assert.equal(error.reason, "semantic_output_committed");
        assert.equal(error.attempts, 1);
        assert.equal(error.semanticOutput, true);
        assert.deepEqual(failoverErrorBody(error), {
          error: {
            type: "unsafe_to_replay",
            reason: "semantic_output_committed",
            attempts: 1,
            semantic_output: true,
          },
        });
        return true;
      },
    );
    assert.equal(selections, 1, eventType);
  }
});

test("does not replay a continuation request across a replacement upstream connection", async () => {
  let selections = 0;
  const machine = createFailoverStateMachine({ sleep: async () => undefined });
  await assert.rejects(
    machine.execute({
      replayPolicy: "continuation_request",
      async selectAccount() {
        selections += 1;
        return { accountId: selections === 1 ? "A" : "B" };
      },
      async attempt({ observeEvent }) {
        observeEvent("response.created");
        throw new FailoverAttemptError("network_error");
      },
    }),
    (error) => {
      assert.equal(error.code, "unsafe_to_replay");
      assert.equal(error.reason, "continuation_connection_not_portable");
      assert.equal(error.semanticOutput, false);
      return true;
    },
  );
  assert.equal(selections, 1);
});

test("enforces attempt count, exponential backoff, and cumulative account exclusion", async () => {
  const exclusions = [];
  const sleeps = [];
  const machine = createFailoverStateMachine({
    maxAttempts: 3,
    totalDeadlineMs: 10_000,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  await assert.rejects(
    machine.execute({
      replayPolicy: "initial_request",
      selectAccount: selector(["A", "B", "C", "D"], exclusions),
      async attempt() { throw new FailoverAttemptError("quota_exhausted"); },
    }),
    (error) => {
      assert.equal(error.code, "all_accounts_unavailable");
      assert.equal(error.reason, "max_attempts_exhausted");
      assert.equal(error.attempts, 3);
      return true;
    },
  );
  assert.deepEqual(exclusions, [[], ["A"], ["A", "B"]]);
  assert.deepEqual(sleeps, [10, 20]);
});

test("rejects a selector that ignores the exclusion set", async () => {
  let selections = 0;
  const machine = createFailoverStateMachine({ sleep: async () => undefined });
  await assert.rejects(
    machine.execute({
      replayPolicy: "initial_request",
      async selectAccount() {
        selections += 1;
        return { accountId: "A" };
      },
      async attempt() { throw new FailoverAttemptError("network_error"); },
    }),
    (error) => {
      assert.equal(error.code, "all_accounts_unavailable");
      assert.equal(error.reason, "selector_violated_exclusion");
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(selections, 2);
});

test("caps Retry-After backoff and stops before exceeding the total deadline", async () => {
  let current = 0;
  const sleeps = [];
  const machine = createFailoverStateMachine({
    now: () => current,
    maxAttempts: 4,
    totalDeadlineMs: 35,
    baseBackoffMs: 10,
    maxBackoffMs: 20,
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
  });
  await assert.rejects(
    machine.execute({
      replayPolicy: "initial_request",
      selectAccount: selector(["A", "B", "C"]),
      async attempt() {
        throw new FailoverAttemptError("rate_limited", { retryAfterMs: 60_000 });
      },
    }),
    (error) => {
      assert.equal(error.code, "all_accounts_unavailable");
      assert.equal(error.reason, "total_deadline_exceeded");
      assert.equal(error.attempts, 2);
      return true;
    },
  );
  assert.deepEqual(sleeps, [20]);
  assert.equal(current, 20);
});

test("actively aborts a stalled attempt at the total deadline", async () => {
  const machine = createFailoverStateMachine({
    maxAttempts: 2,
    totalDeadlineMs: 20,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
  });
  let aborted = false;
  await assert.rejects(
    machine.execute({
      replayPolicy: "initial_request",
      selectAccount: selector(["A"]),
      attempt: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    (error) => {
      assert.equal(error.code, "all_accounts_unavailable");
      assert.equal(error.reason, "total_deadline_exceeded");
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(aborted, true);
});

test("does not retry protocol errors or client cancellation", async () => {
  for (const kind of ["protocol_error", "client_cancelled"]) {
    let selections = 0;
    let failureCallbacks = 0;
    const machine = createFailoverStateMachine({ sleep: async () => undefined });
    await assert.rejects(
      machine.execute({
        replayPolicy: "initial_request",
        async selectAccount() {
          selections += 1;
          return { accountId: "A" };
        },
        async attempt() { throw new FailoverAttemptError(kind); },
        async onAttemptFailure() { failureCallbacks += 1; },
      }),
      (error) => {
        assert.equal(error.code, kind);
        assert.equal(error.reason, "non_retryable_failure");
        return true;
      },
    );
    assert.equal(selections, 1);
    assert.equal(failureCallbacks, 0);
  }
});

test("feeds explicit account failures into the M2.3 circuit breaker callback", async () => {
  const now = Date.parse("2026-07-16T00:00:00.000Z");
  const breaker = createCircuitBreaker({ now: () => now });
  const machine = createFailoverStateMachine({
    sleep: async () => undefined,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
  });
  const result = await machine.execute({
    replayPolicy: "initial_request",
    selectAccount: selector(["A", "B"]),
    async attempt({ accountId }) {
      if (accountId === "A") {
        throw new FailoverAttemptError("rate_limited", { retryAfterMs: 60_000 });
      }
      return "complete";
    },
    async onAttemptFailure({ accountId, kind, retryAfterMs }) {
      breaker.recordFailure(accountId, { kind, retryAfterMs });
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(breaker.snapshot("A").phase, "open");
  assert.equal(breaker.snapshot("A").last_failure_kind, "rate_limited");
  assert.equal(breaker.tryAcquire("A").allowed, false);
  assert.equal(breaker.tryAcquire("B").allowed, true);
});

test("reports an injected backoff failure without mislabeling it as a deadline", async () => {
  const machine = createFailoverStateMachine({
    sleep: async () => { throw new Error("fixture sleep failure"); },
  });
  await assert.rejects(
    machine.execute({
      replayPolicy: "initial_request",
      selectAccount: selector(["A", "B"]),
      async attempt() { throw new FailoverAttemptError("network_error"); },
    }),
    (error) => {
      assert.equal(error.code, "protocol_error");
      assert.equal(error.reason, "backoff_failed");
      return true;
    },
  );
});

test("validates configuration and callback boundaries", async () => {
  for (const options of [
    { maxAttempts: 0 },
    { maxAttempts: 17 },
    { totalDeadlineMs: 0 },
    { baseBackoffMs: -1 },
    { maxBackoffMs: 10, baseBackoffMs: 11 },
    { now: null },
    { sleep: null },
  ]) {
    assert.throws(() => createFailoverStateMachine(options));
  }
  const machine = createFailoverStateMachine();
  await assert.rejects(machine.execute({}), /replayPolicy/);
  await assert.rejects(
    machine.execute({ replayPolicy: "initial_request" }),
    /selectAccount/,
  );
  assert.throws(() => new FailoverAttemptError("unknown"));
  assert.throws(() => new FailoverAttemptError("rate_limited", { retryAfterMs: -1 }));
});
