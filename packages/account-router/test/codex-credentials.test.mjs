import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAuthSecretProvider } from "../src/codex-credentials.mjs";
import { SecretLease } from "../src/secrets.mjs";

async function privateDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-provider-"));
  await fs.chmod(directory, 0o700);
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeAuth(directory, value, { mode = 0o600, name = "auth.json" } = {}) {
  const file = path.join(directory, name);
  await fs.writeFile(file, JSON.stringify(value), { mode });
  await fs.chmod(file, mode);
  return file;
}

function fixtureAuth(overrides = {}) {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "fixture-timestamp",
    tokens: {
      access_token: "fixture-access-token-value",
      account_id: "fixture-upstream-account-id",
      id_token: "fixture-id-token-must-not-survive",
      refresh_token: "fixture-refresh-token-must-not-survive",
      ...overrides,
    },
  };
}

test("extracts only the bounded upstream credential bundle from a private Codex auth file", async (context) => {
  const rootDirectory = await privateDirectory(context);
  await writeAuth(rootDirectory, fixtureAuth());
  const provider = createCodexAuthSecretProvider({ rootDirectory });
  assert.equal(provider.name, "codex-auth");
  const lease = await provider.acquire("auth.json");
  assert.ok(lease instanceof SecretLease);
  const bundle = lease.use((text) => {
    assert.doesNotMatch(text, /refresh-token-must-not-survive|id-token-must-not-survive/);
    return JSON.parse(text);
  });
  assert.deepEqual(bundle, {
    version: 1,
    authorization: "Bearer fixture-access-token-value",
    account_id: "fixture-upstream-account-id",
  });
  assert.equal(JSON.stringify(lease), '"[REDACTED SecretLease]"');
  lease.dispose();
  assert.equal(lease.disposed, true);
  assert.throws(() => lease.use(() => undefined), /disposed/);
});

test("fails closed for permissive, symlinked, malformed, or incomplete auth files", async (context) => {
  const rootDirectory = await privateDirectory(context);
  await writeAuth(rootDirectory, fixtureAuth(), { mode: 0o644, name: "permissive.json" });
  await writeAuth(rootDirectory, { tokens: { access_token: "fixture" } }, { name: "missing.json" });
  await writeAuth(rootDirectory, fixtureAuth({ access_token: "fixture\nheader" }), {
    name: "control.json",
  });
  await fs.symlink(path.join(rootDirectory, "control.json"), path.join(rootDirectory, "link.json"));
  const provider = createCodexAuthSecretProvider({ rootDirectory });
  for (const reference of ["permissive.json", "missing.json", "control.json", "link.json"]) {
    await assert.rejects(provider.acquire(reference), /credential acquisition failed/);
  }
  await assert.rejects(provider.acquire("missing-file.json"), /credential acquisition failed/);
});

test("validates provider configuration without exposing paths or credential values", async () => {
  for (const options of [
    {},
    { rootDirectory: "relative" },
    { rootDirectory: "/tmp", name: "bad provider name" },
  ]) {
    assert.throws(() => createCodexAuthSecretProvider(options));
  }
});
