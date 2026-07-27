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
import { createCircuitStateStore } from "./state-store.mjs";

const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
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

async function readAccountsDocument(filePath) {
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
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error("accounts configuration must be a bounded regular configuration file");
    }
    assertOwnedByCurrentUser(stat);
    if ((stat.mode & 0o022) !== 0) {
      throw new Error("accounts configuration permissions must deny group and other writes");
    }
    const text = await handle.readFile("utf8");
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

async function loadAdminAuthenticator(filePath, credentialsDirectory) {
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
    return lease.use((token) => createAdminAuthenticator({ token }));
  } finally {
    lease.dispose();
  }
}

export async function loadRuntimeBootstrap(environment = process.env) {
  const listenerConfig = loadRuntimeConfig(environment);
  const accountsFile = environment.CODEX_ROUTER_ACCOUNTS_FILE;
  const credentialRoot = environment.CODEX_ROUTER_CREDENTIAL_ROOT;
  if ((accountsFile === undefined) !== (credentialRoot === undefined)) {
    throw new Error("accounts configuration file and credential root must be configured together");
  }

  const secretRegistry = new SecretProviderRegistry();
  let accounts = Object.freeze([]);
  if (accountsFile !== undefined) {
    const rootDirectory = assertAbsolutePath(credentialRoot, "credential root");
    const credentialsDirectory = systemdCredentialsFor(
      rootDirectory,
      environment.CREDENTIALS_DIRECTORY,
    );
    accounts = await readAccountsDocument(accountsFile);
    secretRegistry.register(
      createCodexAuthSecretProvider({
        rootDirectory,
        ...(credentialsDirectory === undefined ? {} : { credentialsDirectory }),
      }),
    );
  }
  const adminAuthenticator = await loadAdminAuthenticator(
    environment.CODEX_ROUTER_ADMIN_TOKEN_FILE,
    environment.CREDENTIALS_DIRECTORY,
  );
  const stateDirectory = environment.CODEX_ROUTER_STATE_DIRECTORY;
  const circuitStateStore = stateDirectory === undefined
    ? null
    : createCircuitStateStore({
        directory: assertAbsolutePath(stateDirectory, "circuit state directory"),
      });
  const initialCircuitState = circuitStateStore === null
    ? null
    : await circuitStateStore.load();

  return Object.freeze({
    ...listenerConfig,
    accounts,
    secretRegistry,
    adminAuthenticator,
    circuitStateStore,
    initialCircuitState,
    upstreamOrigin: environment.CODEX_ROUTER_UPSTREAM_ORIGIN ?? DEFAULT_UPSTREAM_ORIGIN,
  });
}

export async function createRuntimeFromEnvironment(environment = process.env) {
  return createRuntimeComposition(await loadRuntimeBootstrap(environment));
}

export { DEFAULT_UPSTREAM_ORIGIN };
