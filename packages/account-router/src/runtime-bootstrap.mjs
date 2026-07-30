import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { createAccountCatalog } from "./accounts.mjs";
import { createAdminAuthenticator } from "./admin-auth.mjs";
import { createCodexAuthSecretProvider } from "./codex-credentials.mjs";
import { loadRuntimeConfig } from "./config.mjs";
import { createRuntimeComposition } from "./runtime-composition.mjs";
import {
  createFileSecretProvider,
  createSystemdCredentialSecretProvider,
  SecretProviderRegistry,
} from "./secrets.mjs";
import {
  createCircuitStateStore,
  createRoutingStateStore,
} from "./state-store.mjs";

const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
const DEFAULT_INITIAL_LOAD_DEADLINE_MS = 5_000;
const DEFAULT_RUNTIME_STARTUP_DEADLINE_MS = 5_000;
const DEFAULT_STARTUP_PRIVATE_LOAD_DEADLINE_MS = 5_000;
const DEFAULT_STARTUP_STATE_LOAD_DEADLINE_MS = 5_000;
const MAX_STARTUP_LOAD_DEADLINE_MS = 60_000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const CONFIG_FIELDS = new Set(["version", "accounts"]);

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

function assertOwnedByCurrentUser(stat) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("accounts configuration must be owned by the service user");
  }
}

function abortReason(signal, fallbackMessage = "runtime bootstrap load aborted") {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(fallbackMessage);
}

function throwIfAborted(signal, fallbackMessage) {
  if (signal?.aborted) {
    throw abortReason(signal, fallbackMessage);
  }
}

async function readAccountsDocument(filePath, { signal = null } = {}) {
  throwIfAborted(signal, "runtime private bootstrap load aborted");
  const absolutePath = assertAbsolutePath(filePath, "accounts configuration file");
  let handle;
  try {
    handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error("accounts configuration must be a regular configuration file");
  }
  try {
    throwIfAborted(signal, "runtime private bootstrap load aborted");
    const stat = await handle.stat();
    throwIfAborted(signal, "runtime private bootstrap load aborted");
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error("accounts configuration must be a bounded regular configuration file");
    }
    assertOwnedByCurrentUser(stat);
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("accounts configuration permissions must deny group and other writes");
    }
    const text = await handle.readFile({
      encoding: "utf8",
      ...(signal === null ? {} : { signal }),
    });
    throwIfAborted(signal, "runtime private bootstrap load aborted");
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error("accounts configuration must contain valid JSON");
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("accounts configuration document is invalid");
    }
    for (const field of Object.keys(document)) {
      if (!CONFIG_FIELDS.has(field)) {
        throw new Error("accounts configuration document is invalid");
      }
    }
    if (document.version !== 1 || !Array.isArray(document.accounts)) {
      throw new Error("accounts configuration document is invalid");
    }
    createAccountCatalog(document.accounts);
    return Object.freeze(document.accounts.map((account) => Object.freeze({ ...account })));
  } finally {
    await handle.close();
  }
}

function systemdCredentialsFor(rootDirectory, credentialsDirectory) {
  return typeof credentialsDirectory === "string" && rootDirectory === credentialsDirectory
    ? credentialsDirectory
    : undefined;
}

async function loadAdminAuthenticator(
  filePath,
  credentialsDirectory,
  { signal = null } = {},
) {
  throwIfAborted(signal, "runtime private bootstrap load aborted");
  if (filePath === undefined) return null;
  const absolutePath = assertAbsolutePath(filePath, "admin token file");
  const rootDirectory = path.dirname(absolutePath);
  const systemdCredentialsDirectory = systemdCredentialsFor(
    rootDirectory,
    credentialsDirectory,
  );
  const providerFactory = systemdCredentialsDirectory === undefined
    ? createFileSecretProvider
    : createSystemdCredentialSecretProvider;
  const provider = providerFactory({
    rootDirectory,
    ...(systemdCredentialsDirectory === undefined
      ? {}
      : { credentialsDirectory: systemdCredentialsDirectory }),
    name: "admin-token-file",
    maxBytes: 4_096,
  });
  const lease = await provider.acquire(path.basename(absolutePath));
  try {
    throwIfAborted(signal, "runtime private bootstrap load aborted");
    return lease.use((token) => createAdminAuthenticator({ token }));
  } finally {
    lease.dispose();
  }
}

function assertStateStore(value, label) {
  if (
    value !== null &&
    (typeof value !== "object" || typeof value.load !== "function")
  ) {
    throw new TypeError(`${label} state store is invalid`);
  }
  return value;
}

function awaitWithAbort(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

function assertStartupLoadDeadline(deadlineMs, label) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_STARTUP_LOAD_DEADLINE_MS
  ) {
    throw new Error(`${label} must be an integer from 1 through 60000`);
  }
  return deadlineMs;
}

function assertAbortSignal(signal) {
  if (
    signal !== null &&
    (
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("startup load signal is invalid");
  }
  return signal;
}

async function runStartupLoad({
  signal = null,
  deadlineMs,
  deadlineLabel,
  deadlineErrorMessage,
}, operation) {
  const parentSignal = assertAbortSignal(signal);
  assertStartupLoadDeadline(deadlineMs, deadlineLabel);
  if (typeof operation !== "function") {
    throw new TypeError("startup load operation is invalid");
  }

  const controller = parentSignal === null ? new AbortController() : null;
  const activeSignal = parentSignal ?? controller.signal;
  const deadlineError = new Error(deadlineErrorMessage);
  const timer = controller === null
    ? null
    : setTimeout(() => controller.abort(deadlineError), deadlineMs);
  const operationPromise = Promise.resolve().then(() => {
    throwIfAborted(activeSignal, deadlineErrorMessage);
    return operation(activeSignal);
  });
  try {
    return await awaitWithAbort(operationPromise, activeSignal);
  } catch (error) {
    if (activeSignal.aborted) throw abortReason(activeSignal);
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function loadInitialPrivateConfiguration({
  accountsFile,
  credentialRoot,
  adminTokenFile,
  credentialsDirectory,
  accountsLoader = readAccountsDocument,
  adminAuthenticatorLoader = loadAdminAuthenticator,
  deadlineMs = DEFAULT_STARTUP_PRIVATE_LOAD_DEADLINE_MS,
  signal = null,
} = {}) {
  if ((accountsFile === undefined) !== (credentialRoot === undefined)) {
    throw new Error("accounts configuration file and credential root must be configured together");
  }
  if (typeof accountsLoader !== "function") {
    throw new TypeError("accounts configuration loader is invalid");
  }
  if (typeof adminAuthenticatorLoader !== "function") {
    throw new TypeError("admin authenticator loader is invalid");
  }

  return runStartupLoad({
    signal,
    deadlineMs,
    deadlineLabel: "startup private bootstrap load deadline",
    deadlineErrorMessage: "runtime private bootstrap load deadline exceeded",
  }, async (activeSignal) => {
    const secretRegistry = new SecretProviderRegistry();
    let accounts = Object.freeze([]);
    if (accountsFile !== undefined) {
      const rootDirectory = assertAbsolutePath(credentialRoot, "credential root");
      const systemdCredentialsDirectory = systemdCredentialsFor(
        rootDirectory,
        credentialsDirectory,
      );
      accounts = await awaitWithAbort(
        accountsLoader(accountsFile, { signal: activeSignal }),
        activeSignal,
      );
      if (!Array.isArray(accounts)) {
        throw new Error("accounts configuration loader returned invalid metadata");
      }
      secretRegistry.register(
        createCodexAuthSecretProvider({
          rootDirectory,
          ...(systemdCredentialsDirectory === undefined
            ? {}
            : { credentialsDirectory: systemdCredentialsDirectory }),
        }),
      );
    }
    const adminAuthenticator = await awaitWithAbort(
      adminAuthenticatorLoader(
        adminTokenFile,
        credentialsDirectory,
        { signal: activeSignal },
      ),
      activeSignal,
    );
    return Object.freeze({
      accounts,
      secretRegistry,
      adminAuthenticator,
    });
  });
}

export async function loadInitialRuntimeState({
  circuitStateStore = null,
  routingStateStore = null,
  deadlineMs = DEFAULT_STARTUP_STATE_LOAD_DEADLINE_MS,
  signal = null,
} = {}) {
  const circuitStore = assertStateStore(circuitStateStore, "circuit");
  const routingStore = assertStateStore(routingStateStore, "routing");
  return runStartupLoad({
    signal,
    deadlineMs,
    deadlineLabel: "startup state load deadline",
    deadlineErrorMessage: "runtime state load deadline exceeded",
  }, async (activeSignal) => {
    const initialCircuitState = circuitStore === null
      ? null
      : await awaitWithAbort(
        circuitStore.load({ signal: activeSignal }),
        activeSignal,
      );
    const initialRoutingState = routingStore === null
      ? null
      : await awaitWithAbort(
        routingStore.load({ signal: activeSignal }),
        activeSignal,
      );
    return Object.freeze({ initialCircuitState, initialRoutingState });
  });
}

export async function loadInitialRuntimeData({
  privateConfigurationLoader,
  runtimeStateLoader,
  deadlineMs = DEFAULT_INITIAL_LOAD_DEADLINE_MS,
  signal = null,
} = {}) {
  if (typeof privateConfigurationLoader !== "function") {
    throw new TypeError("private configuration stage loader is invalid");
  }
  if (typeof runtimeStateLoader !== "function") {
    throw new TypeError("runtime state stage loader is invalid");
  }
  return runStartupLoad({
    signal,
    deadlineMs,
    deadlineLabel: "initial runtime load deadline",
    deadlineErrorMessage: "runtime initial load deadline exceeded",
  }, async (signal) => {
    const privateConfiguration = await awaitWithAbort(
      privateConfigurationLoader({ signal }),
      signal,
    );
    const runtimeState = await awaitWithAbort(
      runtimeStateLoader({ signal }),
      signal,
    );
    return Object.freeze({ privateConfiguration, runtimeState });
  });
}

export async function loadRuntimeBootstrap(
  environment = process.env,
  { signal = null } = {},
) {
  const listenerConfig = loadRuntimeConfig(environment);
  let circuitStateStore = null;
  let routingStateStore = null;
  const { privateConfiguration, runtimeState } = await loadInitialRuntimeData({
    signal,
    privateConfigurationLoader: ({ signal }) =>
      loadInitialPrivateConfiguration({
        accountsFile: environment.CODEX_ROUTER_ACCOUNTS_FILE,
        credentialRoot: environment.CODEX_ROUTER_CREDENTIAL_ROOT,
        adminTokenFile: environment.CODEX_ROUTER_ADMIN_TOKEN_FILE,
        credentialsDirectory: environment.CREDENTIALS_DIRECTORY,
        signal,
      }),
    runtimeStateLoader: ({ signal }) => {
      const stateDirectory = environment.CODEX_ROUTER_STATE_DIRECTORY;
      const absoluteStateDirectory = stateDirectory === undefined
        ? null
        : assertAbsolutePath(stateDirectory, "circuit state directory");
      circuitStateStore = absoluteStateDirectory === null
        ? null
        : createCircuitStateStore({ directory: absoluteStateDirectory });
      routingStateStore = absoluteStateDirectory === null
        ? null
        : createRoutingStateStore({ directory: absoluteStateDirectory });
      return loadInitialRuntimeState({
        circuitStateStore,
        routingStateStore,
        signal,
      });
    },
  });
  const { accounts, secretRegistry, adminAuthenticator } = privateConfiguration;
  const { initialCircuitState, initialRoutingState } = runtimeState;

  return Object.freeze({
    ...listenerConfig,
    accounts,
    secretRegistry,
    adminAuthenticator,
    circuitStateStore,
    initialCircuitState,
    routingStateStore,
    initialRoutingState,
    upstreamOrigin: environment.CODEX_ROUTER_UPSTREAM_ORIGIN ?? DEFAULT_UPSTREAM_ORIGIN,
  });
}

export async function createRuntimeFromEnvironment(
  environment = process.env,
  { signal = null } = {},
) {
  return createRuntimeComposition(
    await loadRuntimeBootstrap(environment, { signal }),
  );
}

function assertRuntime(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.start !== "function" ||
    typeof value.stop !== "function"
  ) {
    throw new TypeError("runtime loader returned an invalid runtime");
  }
  return value;
}

export async function startRuntimeFromEnvironment({
  environment = process.env,
  runtimeLoader = createRuntimeFromEnvironment,
  onRuntimeCreated = () => {},
  deadlineMs = DEFAULT_RUNTIME_STARTUP_DEADLINE_MS,
} = {}) {
  if (environment === null || typeof environment !== "object") {
    throw new TypeError("runtime environment is invalid");
  }
  if (typeof runtimeLoader !== "function") {
    throw new TypeError("runtime loader is invalid");
  }
  if (typeof onRuntimeCreated !== "function") {
    throw new TypeError("runtime creation callback is invalid");
  }

  return runStartupLoad({
    deadlineMs,
    deadlineLabel: "runtime startup deadline",
    deadlineErrorMessage: "runtime startup deadline exceeded",
  }, async (signal) => {
    let runtime = null;
    try {
      runtime = assertRuntime(await awaitWithAbort(
        runtimeLoader(environment, { signal }),
        signal,
      ));
      throwIfAborted(signal, "runtime startup deadline exceeded");
      onRuntimeCreated(runtime);
      const addresses = await awaitWithAbort(runtime.start({ signal }), signal);
      return Object.freeze({ runtime, addresses });
    } catch (error) {
      if (runtime !== null) {
        const cleanup = Promise.resolve().then(() => runtime.stop());
        try {
          await awaitWithAbort(cleanup, signal);
        } catch {
          // Runtime cleanup shares the same total startup deadline.
        }
      }
      throw error;
    }
  });
}

export { DEFAULT_UPSTREAM_ORIGIN };
