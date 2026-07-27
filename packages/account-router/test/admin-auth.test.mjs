import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { createAdminAuthenticator } from "../src/admin-auth.mjs";

const ADMIN_TOKEN = "fixture-admin-token-0123456789";

test("accepts only the exact admin bearer token", () => {
  const authenticator = createAdminAuthenticator({ token: ADMIN_TOKEN });
  assert.equal(authenticator.authenticate({ authorization: `Bearer ${ADMIN_TOKEN}` }), true);
  for (const headers of [
    {},
    { authorization: `Bearer ${"wrong-token-0123456789"}` },
    { authorization: ADMIN_TOKEN },
    { authorization: `Basic ${ADMIN_TOKEN}` },
    { authorization: [`Bearer ${ADMIN_TOKEN}`] },
    { "x-codex-proxy-token": ADMIN_TOKEN },
    { "x-api-key": ADMIN_TOKEN },
  ]) {
    assert.equal(authenticator.authenticate(headers), false);
  }
});

test("does not serialize or inspect the admin token", () => {
  const authenticator = createAdminAuthenticator({ token: ADMIN_TOKEN });
  const json = JSON.stringify({ authenticator });
  assert.doesNotMatch(json, new RegExp(ADMIN_TOKEN));
  assert.match(json, /REDACTED/);
  assert.doesNotMatch(inspect(authenticator), new RegExp(ADMIN_TOKEN));
  assert.match(inspect(authenticator), /REDACTED/);
});

test("rejects weak or malformed admin token configuration", () => {
  for (const token of [
    undefined,
    null,
    "",
    "short",
    "contains whitespace token",
    "invalid:bearer:value:0123456789",
    "A".repeat(4_097),
  ]) {
    assert.throws(() => createAdminAuthenticator({ token }), /admin token/);
  }
});
