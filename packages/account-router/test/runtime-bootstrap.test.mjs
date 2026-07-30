import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import { loadRuntimeBootstrap } from "../src/runtime-bootstrap.mjs";
import {
  createCircuitStateStore,
  createRoutingStateStore,
} from "../src/state-store.mjs";

async function privateTemporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-bootstrap-test-"));
  await fs.chmod(directory, 0o700);
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("builds an empty loopback runtime configuration when no accounts are configured", async () => {
  const options = await loadRuntimeBootstrap({
    CODEX_ROUTER_ADMIN_PORT: "0",
    CODEX_ROUTER_MODEL_PORT: "0",
  });
  assert.deepEqual(options.accounts, []);
  assert.equal(options.upstreamOrigin, "https://chatgpt.com");
  assert.equal(options.adminPort, 0);
  assert.equal(options.modelPort, 0);
  assert.equal(options.adminAuthenticator, null);
  assert.equal(options.secretRegistry.has("codex-auth"), false);
});

test("loads only public account metadata and registers the Codex credential provider", async (context) => {
  const directory = await privateTemporaryDirectory(context);
  const accountsFile = path.join(directory, "accounts.json");
  await fs.writeFile(
    accountsFile,
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "account-a",
          alias: "Account A",
          enabled: true,
          priority: 1,
          max_concurrency: 2,
          provider: "openai-codex",
          secret_provider: "codex-auth",
          credential_ref: "auth.json",
        },
      ],
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(directory, "auth.json"), "{}", { mode: 0o600 });

  const options = await loadRuntimeBootstrap({
    CODEX_ROUTER_ACCOUNTS_FILE: accountsFile,
    CODEX_ROUTER_CREDENTIAL_ROOT: directory,
    CODEX_ROUTER_UPSTREAM_ORIGIN: "https://example.test",
  });
  assert.equal(options.accounts.length, 1);
  assert.equal(options.accounts[0].id, "account-a");
  assert.equal(options.upstreamOrigin, "https://example.test");
  assert.equal(options.secretRegistry.has("codex-auth"), true);
  assert.doesNotMatch(JSON.stringify(options.accounts), /authorization|access_token|cookie/i);
});

test("loads an optional private admin token file without retaining plaintext", async (context) => {
  const directory = await privateTemporaryDirectory(context);
  const tokenPath = path.join(directory, "admin-token");
  const token = "A".repeat(32);
  await fs.writeFile(tokenPath, token, { mode: 0o600 });

  const options = await loadRuntimeBootstrap({
    CODEX_ROUTER_ADMIN_TOKEN_FILE: tokenPath,
  });
  assert.equal(options.adminAuthenticator.authenticate({ authorization: `Bearer ${token}` }), true);
  assert.equal(JSON.stringify(options.adminAuthenticator), '"[REDACTED AdminAuthenticator]"');
  assert.doesNotMatch(JSON.stringify(options), new RegExp(token));
});

test("loads the private circuit state selected by the runtime state directory", async (context) => {
  const directory = await privateTemporaryDirectory(context);
  const store = createCircuitStateStore({ directory });
  const routingStore = createRoutingStateStore({ directory });
  const breaker = createCircuitBreaker({
    now: () => Date.parse("2026-07-27T08:00:00.000Z"),
  });
  breaker.recordFailure("account-a", { kind: "network_error" });
  await store.save({
    ...breaker.exportState(),
    weekly_quota: [{
      account_id: "account-a",
      observed_at: "2026-07-27T08:00:00.000Z",
      remaining_ratio: 0.25,
      resets_at: "2026-07-28T00:00:00.000Z",
    }],
  });
  await routingStore.save({
    version: 1,
    saved_at: "2026-07-27T08:00:00.000Z",
    accounts: [],
    routing: {
      current_account_id: "account-a",
      preferred_account_id: "account-a",
    },
  });

  const options = await loadRuntimeBootstrap({
    CODEX_ROUTER_STATE_DIRECTORY: directory,
  });
  assert.equal(options.initialCircuitState.accounts[0].account_id, "account-a");
  assert.equal(options.initialCircuitState.accounts[0].last_failure_kind, "network_error");
  assert.equal(options.initialCircuitState.weekly_quota[0].remaining_ratio, 0.25);
  assert.equal(options.initialCircuitState.routing, undefined);
  assert.deepEqual(options.initialRoutingState.routing, {
    current_account_id: "account-a",
    preferred_account_id: "account-a",
  });
  assert.equal(options.circuitStateStore.toString(), "[CircuitStateStore]");
  assert.equal(options.routingStateStore.toString(), "[RoutingStateStore]");
});

test("rejects incomplete, permissive, symlinked, and credential-bearing account configuration", async (context) => {
  const directory = await privateTemporaryDirectory(context);
  const accountsFile = path.join(directory, "accounts.json");
  const linkedFile = path.join(directory, "linked.json");
  const credentialRoot = path.join(directory, "credentials");
  await fs.mkdir(credentialRoot, { mode: 0o700 });

  await assert.rejects(
    loadRuntimeBootstrap({ CODEX_ROUTER_ACCOUNTS_FILE: accountsFile }),
    /credential root/i,
  );

  await fs.writeFile(accountsFile, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o666 });
  await fs.chmod(accountsFile, 0o666);
  await assert.rejects(
    loadRuntimeBootstrap({
      CODEX_ROUTER_ACCOUNTS_FILE: accountsFile,
      CODEX_ROUTER_CREDENTIAL_ROOT: credentialRoot,
    }),
    /permissions/i,
  );

  await fs.chmod(accountsFile, 0o600);
  await fs.symlink(accountsFile, linkedFile);
  await assert.rejects(
    loadRuntimeBootstrap({
      CODEX_ROUTER_ACCOUNTS_FILE: linkedFile,
      CODEX_ROUTER_CREDENTIAL_ROOT: credentialRoot,
    }),
    /regular configuration file/i,
  );

  await fs.writeFile(
    accountsFile,
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "account-a",
          alias: "Account A",
          enabled: true,
          priority: 0,
          secret_provider: "codex-auth",
          credential_ref: "auth.json",
          access_token: "must-not-be-accepted",
        },
      ],
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    loadRuntimeBootstrap({
      CODEX_ROUTER_ACCOUNTS_FILE: accountsFile,
      CODEX_ROUTER_CREDENTIAL_ROOT: credentialRoot,
    }),
    /unsupported account field/i,
  );
});
