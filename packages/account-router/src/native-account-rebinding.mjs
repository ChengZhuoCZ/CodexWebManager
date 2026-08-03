import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { createAccountCatalog } from "./accounts.mjs";
import { parseCodexAuthCredential } from "./codex-credentials.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

function callback(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} callback is required`);
  return value;
}

async function readBounded(filePath, { requirePrivateOwner = false } = {}) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (
      !stat.isFile() || (requirePrivateOwner && stat.uid !== expectedUid) ||
      (stat.mode & (requirePrivateOwner ? 0o077 : 0o022)) !== 0 ||
      stat.size < 1 || stat.size > MAX_DOCUMENT_BYTES
    ) throw new Error("file boundary is invalid");
    return { bytes: await handle.readFile(), stat };
  } finally {
    await handle?.close();
  }
}

async function readConfiguration(filePath) {
  return readBounded(filePath);
}

async function readPrivate(filePath) {
  return readBounded(filePath, { requirePrivateOwner: true });
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function replacePrivate(filePath, bytes, stat) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.next`);
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      stat.mode & 0o777,
    );
    await handle.writeFile(bytes);
    await handle.chmod(stat.mode & 0o777);
    await handle.chown(stat.uid, stat.gid);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function parseAccounts(bytes) {
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("accounts configuration is invalid");
  }
  if (
    document === null || typeof document !== "object" || Array.isArray(document) ||
    document.version !== 1 || !Array.isArray(document.accounts) ||
    Object.keys(document).some((field) => field !== "version" && field !== "accounts")
  ) throw new Error("accounts configuration is invalid");
  const catalog = createAccountCatalog(document.accounts);
  return { document, catalog };
}

function accountForAlias(parsed, alias) {
  if (typeof alias !== "string" || !SAFE_ALIAS_PATTERN.test(alias) || alias.includes("@")) {
    throw new Error("account alias is invalid");
  }
  const account = parsed.catalog.listPublic().find((candidate) => candidate.alias === alias);
  if (account?.enabled !== true) throw new Error("account binding is unavailable");
  const binding = parsed.catalog.getCredentialBinding(account.id);
  if (binding?.secretProvider !== "codex-auth") {
    throw new Error("account binding is unavailable");
  }
  return binding;
}

function routeStatus(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    !Number.isSafeInteger(value.active_requests) || value.active_requests < 0 ||
    !Number.isSafeInteger(value.active_streams) || value.active_streams < 0 ||
    value.current_route === null || typeof value.current_route !== "object" ||
    typeof value.current_route.account_alias !== "string"
  ) throw new Error("router status is unavailable");
  return {
    activeRequests: value.active_requests,
    activeStreams: value.active_streams,
    accountAlias: value.current_route.account_alias,
  };
}

function assertIdle(status) {
  if (status.activeRequests !== 0 || status.activeStreams !== 0) {
    throw new Error("router is not idle");
  }
}

function acceptedSwitch(value, alias) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    value.accepted !== true || value.account_alias !== alias
  ) throw new Error("router switch was rejected");
}

export function createNativeAccountRebinder({
  accountsFile,
  credentialStoreDirectory,
  appServerCredentialFile,
  routerStatus,
  routerSwitch,
  stopAppServer,
  startAppServer,
  appServerReady,
} = {}) {
  const configPath = absolute(accountsFile, "accounts file");
  const credentialRoot = absolute(credentialStoreDirectory, "credential store");
  const appCredentialPath = absolute(appServerCredentialFile, "App Server credential");
  const status = callback(routerStatus, "router status");
  const switchRoute = callback(routerSwitch, "router switch");
  const stop = callback(stopAppServer, "App Server stop");
  const start = callback(startAppServer, "App Server start");
  const ready = callback(appServerReady, "App Server readiness");
  const lockPath = path.join(path.dirname(configPath), ".account-enrollment.lock");

  async function inputs(alias) {
    const accounts = await readConfiguration(configPath);
    const parsed = parseAccounts(accounts.bytes);
    const binding = accountForAlias(parsed, alias);
    const targetPath = path.join(credentialRoot, binding.credentialRef);
    if (path.dirname(targetPath) !== credentialRoot) throw new Error("account binding is unavailable");
    const target = await readPrivate(targetPath);
    parseCodexAuthCredential(target.bytes);
    const current = await readPrivate(appCredentialPath);
    parseCodexAuthCredential(current.bytes);
    return { configuredAccounts: parsed.catalog.size, current, target };
  }

  async function withLock(action) {
    let lock;
    try {
      lock = await fs.open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      return await action();
    } finally {
      await lock?.close().catch(() => {});
      if (lock !== undefined) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        await syncDirectory(path.dirname(configPath)).catch(() => {});
      }
    }
  }

  async function restoreStopped(current, { routeChanged, originalAlias }) {
    let restored = true;
    if (routeChanged) {
      try { acceptedSwitch(await switchRoute(originalAlias), originalAlias); } catch { restored = false; }
    }
    try { await replacePrivate(appCredentialPath, current.bytes, current.stat); } catch { restored = false; }
    try {
      await start();
      if (await ready() !== true) restored = false;
    } catch { restored = false; }
    return restored;
  }

  async function switchToAlias(alias) {
    return withLock(async () => {
      let current;
      let stopped = false;
      let routeChanged = false;
      let originalAlias = null;
      try {
        const before = routeStatus(await status());
        assertIdle(before);
        originalAlias = before.accountAlias;
        if (originalAlias === alias) throw new Error("account route is already selected");
        const prepared = await inputs(alias);
        current = prepared.current;
        await stop();
        stopped = true;
        const afterStop = routeStatus(await status());
        assertIdle(afterStop);
        if (afterStop.accountAlias !== originalAlias) throw new Error("account route changed concurrently");
        await replacePrivate(appCredentialPath, prepared.target.bytes, prepared.current.stat);
        acceptedSwitch(await switchRoute(alias), alias);
        routeChanged = true;
        await start();
        if (await ready() !== true) throw new Error("App Server readiness failed");
        return Object.freeze({
          event: "router_account_switched",
          configured_accounts: prepared.configuredAccounts,
          account_alias: alias,
          native_identity_rebound: true,
          web_restart_required: true,
        });
      } catch (error) {
        if (stopped && current !== undefined && originalAlias !== null) {
          await restoreStopped(current, { routeChanged, originalAlias });
        }
        throw new Error("native account rebind failed", { cause: error });
      }
    });
  }

  async function reconcileCurrentRoute() {
    return withLock(async () => {
      let current;
      let stopped = false;
      try {
        const before = routeStatus(await status());
        assertIdle(before);
        const prepared = await inputs(before.accountAlias);
        current = prepared.current;
        if (prepared.current.bytes.equals(prepared.target.bytes)) {
          return Object.freeze({
            event: "router_native_identity_already_current",
            configured_accounts: prepared.configuredAccounts,
            account_alias: before.accountAlias,
            rebound: false,
          });
        }
        await stop();
        stopped = true;
        const afterStop = routeStatus(await status());
        assertIdle(afterStop);
        if (afterStop.accountAlias !== before.accountAlias) {
          throw new Error("account route changed concurrently");
        }
        await replacePrivate(appCredentialPath, prepared.target.bytes, prepared.current.stat);
        await start();
        if (await ready() !== true) throw new Error("App Server readiness failed");
        return Object.freeze({
          event: "router_native_identity_reconciled",
          configured_accounts: prepared.configuredAccounts,
          account_alias: before.accountAlias,
          rebound: true,
        });
      } catch (error) {
        if (stopped && current !== undefined) {
          await restoreStopped(current, { routeChanged: false, originalAlias: "" });
        }
        throw new Error("native account rebind failed", { cause: error });
      }
    });
  }

  async function configuredAccountCount() {
    const accounts = await readConfiguration(configPath);
    return parseAccounts(accounts.bytes).catalog.size;
  }

  async function currentIdentityAlias() {
    return withLock(async () => {
      const accounts = await readConfiguration(configPath);
      const parsed = parseAccounts(accounts.bytes);
      const current = await readPrivate(appCredentialPath);
      parseCodexAuthCredential(current.bytes);
      const matches = [];
      for (const account of parsed.catalog.listPublic()) {
        if (!account.enabled) continue;
        const binding = accountForAlias(parsed, account.alias);
        const targetPath = path.join(credentialRoot, binding.credentialRef);
        if (path.dirname(targetPath) !== credentialRoot) {
          throw new Error("account binding is unavailable");
        }
        const target = await readPrivate(targetPath);
        parseCodexAuthCredential(target.bytes);
        if (target.bytes.equals(current.bytes)) matches.push(account.alias);
      }
      if (matches.length !== 1) throw new Error("native account identity is unavailable");
      return matches[0];
    });
  }

  return Object.freeze({
    switchToAlias,
    reconcileCurrentRoute,
    configuredAccountCount,
    currentIdentityAlias,
  });
}
