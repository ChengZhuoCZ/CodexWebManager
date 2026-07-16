import assert from "node:assert/strict";
import test from "node:test";
import { redactForLog, stringifyLogRecord } from "../src/redaction.mjs";
import { SecretLease } from "../src/secrets.mjs";

test("redacts credential fields, account email, and SecretLease values recursively", () => {
  const lease = SecretLease.fromUtf8("fixture-lease-secret");
  const record = {
    event: "fixture",
    authorization: "Bearer fixture-authorization",
    nested: {
      access_token: "fixture-access-token",
      refreshToken: "fixture-refresh-token",
      credential_ref: "fixture-credential-ref",
      email: "fixture@example.test",
      lease,
      safe: "visible",
    },
  };
  const serialized = stringifyLogRecord(record);
  for (const forbidden of [
    "fixture-authorization",
    "fixture-access-token",
    "fixture-refresh-token",
    "fixture-credential-ref",
    "fixture@example.test",
    "fixture-lease-secret",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  assert.match(serialized, /"safe":"visible"/);
  assert.match(serialized, /\[REDACTED\]/);
  lease.dispose();
});

test("handles circular, deep, wide, error, bigint, and unsupported values safely", () => {
  const circular = { event: "fixture", count: 2n, error: new Error("fixture failure") };
  circular.self = circular;
  circular.deep = { one: { two: { three: { four: "hidden by depth" } } } };
  circular.wide = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, index]));
  circular.callback = () => undefined;

  const redacted = redactForLog(circular, { maxDepth: 3, maxEntries: 5 });
  const serialized = JSON.stringify(redacted);
  assert.match(serialized, /\[Circular\]/);
  assert.match(serialized, /\[MaxDepth\]/);
  assert.match(serialized, /\[Truncated\]/);
  assert.match(serialized, /"count":"2"/);
  assert.match(serialized, /"name":"Error"/);
  assert.doesNotMatch(serialized, /callback/);
});

test("redacts emails, bearer credentials, and known token shapes in arbitrary strings", () => {
  const serialized = stringifyLogRecord({
    event: "fixture",
    message:
      "contact fixture@example.test with Bearer ABCDEFGHIJKLMNOP or ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  });
  assert.doesNotMatch(serialized, /fixture@example\.test|ABCDEFGHIJKLMNOP|ghp_/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("rejects non-object top-level log records", () => {
  for (const value of [null, "text", 1, [], new SecretLease(Buffer.from("fixture"))]) {
    assert.throws(() => stringifyLogRecord(value), /plain object/);
  }
});
