import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { createAccountCatalog, normalizeAccountDefinition } from "../src/accounts.mjs";

const fixtureAccount = Object.freeze({
  id: "account-a",
  alias: "Fixture A",
  enabled: true,
  priority: 10,
  max_concurrency: 2,
  provider: "openai-codex",
  secret_provider: "file",
  credential_ref: "codex-account-a",
});

test("separates public account metadata from the credential binding", () => {
  const normalized = normalizeAccountDefinition(fixtureAccount);
  assert.deepEqual(normalized.publicMetadata, {
    id: "account-a",
    alias: "Fixture A",
    enabled: true,
    priority: 10,
    max_concurrency: 2,
    provider: "openai-codex",
  });
  assert.deepEqual(normalized.credentialBinding, {
    accountId: "account-a",
    secretProvider: "file",
    credentialRef: "codex-account-a",
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.publicMetadata), true);
  assert.equal(Object.isFrozen(normalized.credentialBinding), true);
  assert.doesNotMatch(JSON.stringify(normalized.publicMetadata), /credential|secret/i);
});

test("catalog exposes only public metadata and keeps bindings behind an explicit method", () => {
  const catalog = createAccountCatalog([
    fixtureAccount,
    {
      ...fixtureAccount,
      id: "account-b",
      alias: "Fixture B",
      credential_ref: "codex-account-b",
    },
  ]);
  assert.deepEqual(catalog.listPublic().map(({ id }) => id), ["account-a", "account-b"]);
  assert.equal(catalog.getPublic("account-a").alias, "Fixture A");
  assert.deepEqual(catalog.getCredentialBinding("account-b"), {
    accountId: "account-b",
    secretProvider: "file",
    credentialRef: "codex-account-b",
  });
  const publicJson = JSON.stringify(catalog.listPublic());
  assert.doesNotMatch(publicJson, /codex-account-[ab]|credential_ref|secret_provider/i);
  assert.equal(catalog.size, 2);
});

test("rejects duplicate IDs, unknown fields, and raw credential material", () => {
  assert.throws(
    () => createAccountCatalog([fixtureAccount, fixtureAccount]),
    /duplicate account id/,
  );
  for (const extra of [
    { authorization: "Bearer fixture-secret" },
    { access_token: "fixture-secret" },
    { email: "fixture@example.test" },
    { unexpected: true },
  ]) {
    assert.throws(
      () => normalizeAccountDefinition({ ...fixtureAccount, ...extra }),
      /unsupported account field/,
    );
  }
});

test("validates bounded public metadata and opaque credential references", () => {
  const cases = [
    ["id", { id: "contains spaces" }],
    ["alias", { alias: "" }],
    ["enabled", { enabled: "yes" }],
    ["priority", { priority: 1001 }],
    ["max_concurrency", { max_concurrency: 0 }],
    ["provider", { provider: "" }],
    ["secret_provider", { secret_provider: "../file" }],
    ["credential_ref", { credential_ref: "../escape" }],
  ];
  for (const [field, replacement] of cases) {
    assert.throws(
      () => normalizeAccountDefinition({ ...fixtureAccount, ...replacement }),
      new RegExp(field),
    );
  }
});

test("public JSON schema contains no credential binding fields", async () => {
  const schemaUrl = new URL("../../../contracts/account.schema.json", import.meta.url);
  const schema = JSON.parse(await fs.readFile(schemaUrl, "utf8"));
  assert.equal(schema.title, "Account public metadata");
  assert.equal(schema.properties.credential_ref, undefined);
  assert.equal(schema.properties.secret_provider, undefined);
  assert.deepEqual(
    schema.required,
    ["id", "alias", "enabled", "priority", "max_concurrency", "provider"],
  );
});
