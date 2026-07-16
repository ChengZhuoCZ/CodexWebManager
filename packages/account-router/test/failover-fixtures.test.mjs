import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createFailoverStateMachine,
  FailoverAttemptError,
} from "../src/failover-state-machine.mjs";

function scalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[0-9]+$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    return body === "" ? [] : body.split(",").map((item) => scalar(item));
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

async function loadScenarios() {
  const fixtureUrl = new URL("../../../test-fixtures/mock_scenarios.yaml", import.meta.url);
  const text = await readFile(fixtureUrl, "utf8");
  const scenarios = [];
  let scenario = null;
  let section = null;
  let responseSubsection = null;
  let event = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    let match;
    if (indent === 2 && (match = /^- id: (.+)$/.exec(line))) {
      scenario = { id: scalar(match[1]), response: {}, expect: {} };
      scenarios.push(scenario);
      section = null;
      responseSubsection = null;
      event = null;
      continue;
    }
    if (!scenario) continue;
    if (indent === 4 && line === "response:") {
      section = "response";
      responseSubsection = null;
      continue;
    }
    if (indent === 4 && line === "expect:") {
      section = "expect";
      responseSubsection = null;
      continue;
    }
    if (indent === 4 && (match = /^([^:]+): (.+)$/.exec(line))) {
      scenario[match[1]] = scalar(match[2]);
      continue;
    }
    if (section === "expect" && indent === 6 && (match = /^([^:]+): (.+)$/.exec(line))) {
      scenario.expect[match[1]] = scalar(match[2]);
      continue;
    }
    if (section !== "response") continue;
    if (indent === 6 && (line === "events:" || line === "headers:" || line === "json:")) {
      responseSubsection = line.slice(0, -1);
      if (responseSubsection === "events") scenario.response.events = [];
      else scenario.response[responseSubsection] = {};
      continue;
    }
    if (indent === 6 && (match = /^([^:]+): (.+)$/.exec(line))) {
      scenario.response[match[1]] = scalar(match[2]);
      continue;
    }
    if (responseSubsection === "events" && indent === 8 && (match = /^- ([^:]+): (.+)$/.exec(line))) {
      event = { [match[1]]: scalar(match[2]) };
      scenario.response.events.push(event);
      continue;
    }
    if (responseSubsection === "events" && indent === 10 && event && (match = /^([^:]+): (.+)$/.exec(line))) {
      event[match[1]] = scalar(match[2]);
      continue;
    }
    if (responseSubsection === "headers" && indent === 8 && (match = /^([^:]+): (.+)$/.exec(line))) {
      scenario.response.headers[match[1]] = scalar(match[2]);
    }
  }
  return scenarios;
}

const FAILURE_KIND = Object.freeze({
  quota_before_stream: "quota_exhausted",
  rate_limit_before_stream: "rate_limited",
  auth_expired: "auth_expired",
  all_accounts_exhausted: "quota_exhausted",
});

test("executes every task-pack failover fixture without treating mocks as real accounts", async () => {
  const scenarios = await loadScenarios();
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [
      "success_stream",
      "quota_before_stream",
      "rate_limit_before_stream",
      "auth_expired",
      "failure_after_text_delta",
      "failure_after_function_args",
      "all_accounts_exhausted",
    ],
  );

  for (const scenario of scenarios) {
    const accounts = scenario.accounts ?? [scenario.account ?? "A", "B"];
    let accountIndex = 0;
    const failures = [];
    const sleeps = [];
    const machine = createFailoverStateMachine({
      maxAttempts: scenario.expect.max_attempts ?? 3,
      totalDeadlineMs: 10_000,
      baseBackoffMs: 1,
      maxBackoffMs: 5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });
    const operation = machine.execute({
      replayPolicy: "initial_request",
      async selectAccount({ excludeAccountIds }) {
        const next = accounts[accountIndex++];
        assert.equal(excludeAccountIds.includes(next), false, scenario.id);
        return next === undefined ? null : { accountId: next };
      },
      async attempt({ accountId, observeEvent }) {
        for (const event of scenario.response.events ?? []) {
          if (event.type) observeEvent(event.type);
          if (event.disconnect) throw new FailoverAttemptError("network_error");
        }
        if (scenario.id === "success_stream") return { scenario: scenario.id };
        if (scenario.id.startsWith("failure_after_")) {
          throw new Error("disconnect fixture did not execute");
        }
        if (scenario.id === "all_accounts_exhausted" || accountId === accounts[0]) {
          const retryAfterMs = scenario.response.headers?.["retry-after"] === undefined
            ? null
            : Number(scenario.response.headers["retry-after"]) * 1_000;
          throw new FailoverAttemptError(FAILURE_KIND[scenario.id], { retryAfterMs });
        }
        return { scenario: scenario.id };
      },
      async onAttemptFailure(failure) { failures.push(failure); },
    });

    if (scenario.expect.error) {
      await assert.rejects(operation, (error) => {
        assert.equal(error.code, scenario.expect.error, scenario.id);
        assert.equal(error.semanticOutput, true, scenario.id);
        return true;
      });
      assert.equal(accountIndex, 1, scenario.id);
      continue;
    }
    if (scenario.expect.final_error) {
      await assert.rejects(operation, (error) => {
        assert.equal(error.code, scenario.expect.final_error, scenario.id);
        assert.equal(error.attempts, scenario.expect.max_attempts, scenario.id);
        return true;
      });
      assert.equal(failures.length, scenario.expect.max_attempts, scenario.id);
      continue;
    }
    const result = await operation;
    assert.equal(result.status, "completed", scenario.id);
    if (scenario.expect.failover_allowed) {
      assert.equal(result.attempts, 2, scenario.id);
      assert.equal(failures.length, 1, scenario.id);
      assert.equal(failures[0].kind, FAILURE_KIND[scenario.id], scenario.id);
      assert.ok(sleeps.length === 1, scenario.id);
    } else {
      assert.equal(result.attempts, 1, scenario.id);
    }
  }
});
