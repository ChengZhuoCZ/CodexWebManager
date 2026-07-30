import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import {
  loadInitialPrivateConfiguration,
  loadInitialRuntimeData,
  loadInitialRuntimeState,
  loadRuntimeBootstrap,
} from "../src/runtime-bootstrap.mjs";
import * as runtimeBootstrapModule from "../src/runtime-bootstrap.mjs";
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

test("bounds the complete pre-listener load sequence with one total deadline", async (context) => {
  let releaseStateLoad;
  let announceStateLoad;
  const stateLoadGate = new Promise((resolve) => {
    releaseStateLoad = resolve;
  });
  const stateLoadStarted = new Promise((resolve) => {
    announceStateLoad = resolve;
  });
  let accountsSignal = null;
  let adminSignal = null;
  let circuitSignal = null;
  let routingSignal = null;
  const startedAt = performance.now();
  const operation = loadInitialRuntimeData({
    privateConfigurationLoader: ({ signal = null } = {}) =>
      loadInitialPrivateConfiguration({
        accountsFile: "/fixture/accounts.json",
        credentialRoot: "/fixture/credentials",
        accountsLoader: async (_filePath, { signal: loaderSignal = null } = {}) => {
          accountsSignal = loaderSignal;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return Object.freeze([]);
        },
        adminAuthenticatorLoader: async (
          _filePath,
          _credentialsDirectory,
          { signal: loaderSignal = null } = {},
        ) => {
          adminSignal = loaderSignal;
          return null;
        },
        deadlineMs: 1_000,
        signal,
      }),
    runtimeStateLoader: ({ signal = null } = {}) =>
      loadInitialRuntimeState({
        circuitStateStore: {
          async load({ signal: loaderSignal = null } = {}) {
            circuitSignal = loaderSignal;
            return null;
          },
        },
        routingStateStore: {
          async load({ signal: loaderSignal = null } = {}) {
            routingSignal = loaderSignal;
            announceStateLoad();
            await stateLoadGate;
            return null;
          },
        },
        deadlineMs: 1_000,
        signal,
      }),
    deadlineMs: 120,
  });
  context.after(async () => {
    releaseStateLoad?.();
    await operation.catch(() => undefined);
  });
  await stateLoadStarted;

  const outcome = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => error?.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 300)),
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome, "runtime initial load deadline exceeded");
  assert.equal(accountsSignal, adminSignal);
  assert.equal(adminSignal, circuitSignal);
  assert.equal(circuitSignal, routingSignal);
  assert.equal(routingSignal?.aborted, true);
  assert.ok(elapsedMs < 250);
});

test("bounds runtime creation and listener start with one total deadline", async (context) => {
  let releaseListenerStart;
  let announceListenerStart;
  const listenerStartGate = new Promise((resolve) => {
    releaseListenerStart = resolve;
  });
  const listenerStartStarted = new Promise((resolve) => {
    announceListenerStart = resolve;
  });
  let loaderSignal = null;
  let listenerSignal = null;
  let stopCalls = 0;
  const runtime = {
    async start({ signal = null } = {}) {
      listenerSignal = signal;
      announceListenerStart();
      await listenerStartGate;
      return Object.freeze({});
    },
    async stop() {
      stopCalls += 1;
    },
  };
  const startedAt = performance.now();
  const operation = runtimeBootstrapModule.startRuntimeFromEnvironment({
    environment: Object.freeze({}),
    runtimeLoader: async (_environment, { signal = null } = {}) => {
      loaderSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return runtime;
    },
    deadlineMs: 120,
  });
  context.after(async () => {
    releaseListenerStart?.();
    await operation.catch(() => undefined);
  });
  await listenerStartStarted;

  const outcome = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => error?.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 300)),
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome, "runtime startup deadline exceeded");
  assert.equal(loaderSignal, listenerSignal);
  assert.equal(listenerSignal?.aborted, true);
  assert.equal(stopCalls, 1);
  assert.ok(elapsedMs < 250);
});

test("parent process signal cancels complete runtime startup", async (context) => {
  let releaseRuntimeLoad;
  let announceRuntimeLoad;
  const runtimeLoadGate = new Promise((resolve) => {
    releaseRuntimeLoad = resolve;
  });
  const runtimeLoadStarted = new Promise((resolve) => {
    announceRuntimeLoad = resolve;
  });
  const controller = new AbortController();
  const stopReason = new Error("fixture process stop");
  let loaderSignal = null;
  let runtimeStartCalls = 0;
  const operation = runtimeBootstrapModule.startRuntimeFromEnvironment({
    environment: Object.freeze({}),
    signal: controller.signal,
    runtimeLoader: async (_environment, { signal = null } = {}) => {
      loaderSignal = signal;
      announceRuntimeLoad();
      await runtimeLoadGate;
      return {
        async start() {
          runtimeStartCalls += 1;
          return Object.freeze({});
        },
        async stop() {},
      };
    },
    deadlineMs: 1_000,
  });
  context.after(async () => {
    releaseRuntimeLoad?.();
    await operation.catch(() => undefined);
  });
  await runtimeLoadStarted;

  controller.abort(stopReason);
  const outcome = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
  ]);

  assert.equal(outcome, stopReason);
  assert.equal(loaderSignal?.aborted, true);
  assert.equal(loaderSignal?.reason, stopReason);
  assert.equal(runtimeStartCalls, 0);
});

test("retains the complete startup deadline with a live parent process signal", async (context) => {
  let releaseRuntimeLoad;
  let announceRuntimeLoad;
  const runtimeLoadGate = new Promise((resolve) => {
    releaseRuntimeLoad = resolve;
  });
  const runtimeLoadStarted = new Promise((resolve) => {
    announceRuntimeLoad = resolve;
  });
  const controller = new AbortController();
  let loaderSignal = null;
  let runtimeStartCalls = 0;
  const operation = runtimeBootstrapModule.startRuntimeFromEnvironment({
    environment: Object.freeze({}),
    signal: controller.signal,
    runtimeLoader: async (_environment, { signal = null } = {}) => {
      loaderSignal = signal;
      announceRuntimeLoad();
      await runtimeLoadGate;
      return {
        async start() {
          runtimeStartCalls += 1;
          return Object.freeze({});
        },
        async stop() {},
      };
    },
    deadlineMs: 50,
  });
  context.after(async () => {
    releaseRuntimeLoad?.();
    await operation.catch(() => undefined);
  });
  await runtimeLoadStarted;

  const outcome = await Promise.race([
    operation.then(
      () => "resolved",
      (error) => error?.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 150)),
  ]);

  assert.equal(outcome, "runtime startup deadline exceeded");
  assert.equal(controller.signal.aborted, false);
  assert.equal(loaderSignal?.aborted, true);
  assert.equal(runtimeStartCalls, 0);
});

test("rejects a pre-aborted parent process signal before runtime loading", async () => {
  const controller = new AbortController();
  const stopReason = new Error("fixture pre-start process stop");
  controller.abort(stopReason);
  let loadCalls = 0;

  await assert.rejects(
    runtimeBootstrapModule.startRuntimeFromEnvironment({
      environment: Object.freeze({}),
      signal: controller.signal,
      runtimeLoader: async () => {
        loadCalls += 1;
        return null;
      },
    }),
    (error) => error === stopReason,
  );
  assert.equal(loadCalls, 0);
});

test("uses a parent initial-load signal without opening a fresh deadline", async (context) => {
  let releasePrivateLoad;
  const privateLoadGate = new Promise((resolve) => {
    releasePrivateLoad = resolve;
  });
  const controller = new AbortController();
  const parentReason = new Error("fixture complete startup deadline");
  let loaderSignal = null;
  let stateCalls = 0;
  const operation = loadInitialRuntimeData({
    privateConfigurationLoader: async ({ signal = null } = {}) => {
      loaderSignal = signal;
      await privateLoadGate;
      return Object.freeze({});
    },
    runtimeStateLoader: async () => {
      stateCalls += 1;
      return Object.freeze({});
    },
    deadlineMs: 1,
    signal: controller.signal,
  });
  context.after(async () => {
    releasePrivateLoad?.();
    await operation.catch(() => undefined);
  });

  const earlyOutcome = await Promise.race([
    operation.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
  assert.equal(earlyOutcome, "pending");
  assert.equal(loaderSignal, controller.signal);
  assert.equal(stateCalls, 0);

  controller.abort(parentReason);
  await assert.rejects(operation, (error) => error === parentReason);
  assert.equal(stateCalls, 0);
});

test("rejects invalid complete runtime startup boundaries before loading", async () => {
  let loadCalls = 0;
  const runtimeLoader = async () => {
    loadCalls += 1;
    return null;
  };
  for (const deadlineMs of [0, 60_001, 1.5]) {
    await assert.rejects(
      runtimeBootstrapModule.startRuntimeFromEnvironment({
        environment: Object.freeze({}),
        runtimeLoader,
        deadlineMs,
      }),
      /runtime startup deadline must be an integer from 1 through 60000/,
    );
  }
  await assert.rejects(
    runtimeBootstrapModule.startRuntimeFromEnvironment({
      environment: null,
      runtimeLoader,
    }),
    /runtime environment is invalid/,
  );
  await assert.rejects(
    runtimeBootstrapModule.startRuntimeFromEnvironment({
      environment: Object.freeze({}),
      runtimeLoader: {},
    }),
    /runtime loader is invalid/,
  );
  await assert.rejects(
    runtimeBootstrapModule.startRuntimeFromEnvironment({
      environment: Object.freeze({}),
      runtimeLoader,
      onRuntimeCreated: {},
    }),
    /runtime creation callback is invalid/,
  );
  await assert.rejects(
    runtimeBootstrapModule.startRuntimeFromEnvironment({
      environment: Object.freeze({}),
      runtimeLoader,
      signal: {},
    }),
    /startup load signal is invalid/,
  );
  assert.equal(loadCalls, 0);
});

test("rejects invalid complete initial load boundaries before invoking a stage", async () => {
  let stageCalls = 0;
  const stageLoader = async () => {
    stageCalls += 1;
    return null;
  };
  for (const deadlineMs of [0, 60_001, 1.5]) {
    await assert.rejects(
      loadInitialRuntimeData({
        privateConfigurationLoader: stageLoader,
        runtimeStateLoader: stageLoader,
        deadlineMs,
      }),
      /initial runtime load deadline must be an integer from 1 through 60000/,
    );
  }
  await assert.rejects(
    loadInitialRuntimeData({
      privateConfigurationLoader: {},
      runtimeStateLoader: stageLoader,
    }),
    /private configuration stage loader is invalid/,
  );
  await assert.rejects(
    loadInitialRuntimeData({
      privateConfigurationLoader: stageLoader,
      runtimeStateLoader: {},
    }),
    /runtime state stage loader is invalid/,
  );
  assert.equal(stageCalls, 0);
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
