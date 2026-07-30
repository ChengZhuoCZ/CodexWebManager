import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import {
  loadInitialPrivateConfiguration,
  loadInitialRuntimeState,
  loadRuntimeBootstrap,
} from "../src/runtime-bootstrap.mjs";
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

test("bounds both startup state loads with one total deadline", async (context) => {
  let releaseRoutingLoad;
  let announceRoutingLoad;
  const routingLoadGate = new Promise((resolve) => {
    releaseRoutingLoad = resolve;
  });
  const routingLoadStarted = new Promise((resolve) => {
    announceRoutingLoad = resolve;
  });
  let circuitSignal = null;
  let routingSignal = null;
  const circuitState = Object.freeze({ fixture: "circuit" });
  const operation = loadInitialRuntimeState({
    circuitStateStore: {
      async load({ signal = null } = {}) {
        circuitSignal = signal;
        return circuitState;
      },
    },
    routingStateStore: {
      async load({ signal = null } = {}) {
        routingSignal = signal;
        announceRoutingLoad();
        await routingLoadGate;
        return Object.freeze({ fixture: "routing" });
      },
    },
    deadlineMs: 100,
  });
  context.after(async () => {
    releaseRoutingLoad();
    await operation.catch(() => undefined);
  });
  await routingLoadStarted;

  const outcome = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => error?.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 250)),
  ]);

  assert.equal(outcome, "runtime state load deadline exceeded");
  assert.equal(circuitSignal, routingSignal);
  assert.equal(routingSignal?.aborted, true);
});

test("bounds private account and admin bootstrap loads with one total deadline", async (context) => {
  let releaseAdminLoad;
  let announceAdminLoad;
  const adminLoadGate = new Promise((resolve) => {
    releaseAdminLoad = resolve;
  });
  const adminLoadStarted = new Promise((resolve) => {
    announceAdminLoad = resolve;
  });
  let accountsSignal = null;
  let adminSignal = null;
  const operation = loadInitialPrivateConfiguration({
    accountsFile: "/fixture/accounts.json",
    credentialRoot: "/fixture/credentials",
    adminTokenFile: "/fixture/admin-token",
    accountsLoader: async (_filePath, { signal = null } = {}) => {
      accountsSignal = signal;
      return Object.freeze([]);
    },
    adminAuthenticatorLoader: async (
      _filePath,
      _credentialsDirectory,
      { signal = null } = {},
    ) => {
      adminSignal = signal;
      announceAdminLoad();
      await adminLoadGate;
      return null;
    },
    deadlineMs: 100,
  });
  context.after(async () => {
    releaseAdminLoad?.();
    await operation.catch(() => undefined);
  });
  await adminLoadStarted;

  const outcome = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => error?.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 250)),
  ]);

  assert.equal(outcome, "runtime private bootstrap load deadline exceeded");
  assert.equal(accountsSignal, adminSignal);
  assert.equal(adminSignal?.aborted, true);
});

test("rejects invalid private bootstrap boundaries before invoking a loader", async () => {
  let loadCalls = 0;
  const accountsLoader = async () => {
    loadCalls += 1;
    return Object.freeze([]);
  };
  for (const deadlineMs of [0, 60_001, 1.5]) {
    await assert.rejects(
      loadInitialPrivateConfiguration({
        accountsFile: "/fixture/accounts.json",
        credentialRoot: "/fixture/credentials",
        accountsLoader,
        deadlineMs,
      }),
      /startup private bootstrap load deadline must be an integer from 1 through 60000/,
    );
  }
  await assert.rejects(
    loadInitialPrivateConfiguration({
      accountsFile: "/fixture/accounts.json",
      credentialRoot: "/fixture/credentials",
      accountsLoader: {},
    }),
    /accounts configuration loader is invalid/,
  );
  await assert.rejects(
    loadInitialPrivateConfiguration({
      adminAuthenticatorLoader: {},
    }),
    /admin authenticator loader is invalid/,
  );
  assert.equal(loadCalls, 0);
});

test("rejects invalid startup state load boundaries before reading a store", async () => {
  let loadCalls = 0;
  const store = {
    async load() {
      loadCalls += 1;
      return null;
    },
  };
  for (const deadlineMs of [0, 60_001, 1.5]) {
    await assert.rejects(
      loadInitialRuntimeState({
        circuitStateStore: store,
        deadlineMs,
      }),
      /startup state load deadline must be an integer from 1 through 60000/,
    );
  }
  await assert.rejects(
    loadInitialRuntimeState({ routingStateStore: {} }),
    /routing state store is invalid/,
  );
  assert.equal(loadCalls, 0);
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
