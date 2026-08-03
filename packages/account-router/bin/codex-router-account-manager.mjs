#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs, realpathSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createAccountEnrollmentManager } from "../src/account-enrollment.mjs";
import { createNativeAccountRebinder } from "../src/native-account-rebinding.mjs";

const SERVICE = "codex-account-router.service";
const APP_SERVER_SERVICE = "codex-web-router-app-server.service";
const WEB_SERVICE = "codex-web-router.service";
const APP_SERVER_CREDENTIAL_FILE = "/etc/codex-account-router/credentials/app-server-auth.json";
const APP_SERVER_SOCKET = "/run/codex-web-router-app-server/app-server.sock";
const ADMIN_HOST = "127.0.0.1";
const ADMIN_PORT = 18318;
const SYSTEMCTL_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const OPAQUE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeAlias(value) {
  if (typeof value !== "string" || !SAFE_ALIAS_PATTERN.test(value) || value.includes("@")) {
    throw new Error("account request is invalid");
  }
  return value;
}

function safeId(value) {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error("account request is invalid");
  }
  return value;
}

function safeSourceFile(value, sourceRoot) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("account request is invalid");
  }
  const normalized = path.normalize(value);
  const relative = path.relative(sourceRoot, normalized);
  if (
    relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) || path.basename(normalized) !== "auth.json"
  ) {
    throw new Error("account request is invalid");
  }
  return normalized;
}

export async function assertAuthSourceBoundary(sourceRoot, sourceFile) {
  const root = await fs.lstat(sourceRoot);
  const directory = await fs.lstat(path.dirname(sourceFile));
  const file = await fs.lstat(sourceFile);
  if (
    !root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 ||
    !directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
    !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 ||
    root.uid === 0 || root.uid !== directory.uid || root.gid !== directory.gid ||
    root.uid !== file.uid || root.gid !== file.gid
  ) throw new Error("account source boundary is invalid");
}

export function isDirectManagerInvocation(moduleUrl, executablePath) {
  if (typeof executablePath !== "string" || executablePath.length === 0) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(executablePath)).href;
  } catch {
    return false;
  }
}

export function parseManagerRequest(value, sourceRoot) {
  if (!isRecord(value) || typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new Error("account request is invalid");
  }
  if (value.operation === "enroll") {
    if (
      Object.keys(value).some((key) => !new Set(["operation", "source_file", "id", "alias"]).has(key)) ||
      Object.keys(value).length !== 4
    ) {
      throw new Error("account request is invalid");
    }
    return Object.freeze({
      operation: "enroll",
      sourceFile: safeSourceFile(value.source_file, sourceRoot),
      id: safeId(value.id),
      alias: safeAlias(value.alias),
      priority: 0,
      maxConcurrency: 1,
    });
  }
  if (value.operation === "remove") {
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "alias")) {
      throw new Error("account request is invalid");
    }
    return Object.freeze({ operation: "remove", alias: safeAlias(value.alias) });
  }
  if (value.operation === "switch") {
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "alias")) {
      throw new Error("account request is invalid");
    }
    return Object.freeze({ operation: "switch", alias: safeAlias(value.alias) });
  }
  if (value.operation === "observe") {
    if (Object.keys(value).length !== 1) throw new Error("account request is invalid");
    return Object.freeze({ operation: "observe" });
  }
  throw new Error("account request is invalid");
}

function boundedReply(socket, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_RESPONSE_BYTES) {
    socket.end('{"ok":false,"error":"account_operation_failed"}\n');
    return;
  }
  socket.end(bytes);
}

export function createManagerProtocolServer({ sourceRoot, enroll, remove, switchAccount, observe }) {
  if (
    typeof enroll !== "function" || typeof remove !== "function" ||
    typeof switchAccount !== "function" || typeof observe !== "function"
  ) {
    throw new TypeError("account manager callbacks are required");
  }
  return net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setTimeout(OPERATION_TIMEOUT_MS, () => socket.destroy());
    let settled = false;
    let length = 0;
    const chunks = [];
    const fail = () => {
      if (settled) return;
      settled = true;
      boundedReply(socket, { ok: false, error: "account_operation_failed" });
    };
    socket.on("data", (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_REQUEST_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const newline = body.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== body.length - 1 || body.subarray(0, newline).includes(0x00)) {
        fail();
        return;
      }
      settled = true;
      Promise.resolve().then(async () => {
        const request = parseManagerRequest(
          JSON.parse(body.subarray(0, newline).toString("utf8")),
          sourceRoot,
        );
        const result = request.operation === "enroll" ? await enroll(request)
          : request.operation === "remove" ? await remove(request)
            : request.operation === "switch" ? await switchAccount(request)
              : await observe(request);
        const response = {
          ok: true,
          event: result.event,
          configured_accounts: result.configured_accounts,
          credentials_exposed: false,
        };
        if (request.operation === "switch") {
          Object.assign(response, {
            account_alias: result.account_alias,
            continuity: "new_backend_session",
            architecture_mode: "LIMITED_MODE",
            native_identity_rebound: result.native_identity_rebound === true,
            web_restart_required: result.web_restart_required === true,
          });
        }
        boundedReply(socket, response);
      }).catch(() => {
        boundedReply(socket, { ok: false, error: "account_operation_failed" });
      });
    });
    socket.once("error", () => {});
    socket.once("end", () => {
      if (!settled) fail();
    });
  });
}

function spawnSystemctl(action, service) {
  const operation = `${action}:${service}`;
  if (!new Set([
    `restart:${SERVICE}`,
    `stop:${APP_SERVER_SERVICE}`,
    `start:${APP_SERVER_SERVICE}`,
    `is-active:${APP_SERVER_SERVICE}`,
    `restart:${WEB_SERVICE}`,
  ]).has(operation)) {
    return Promise.reject(new Error("systemctl operation is invalid"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", [action, service], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("systemctl operation timed out"));
    }, SYSTEMCTL_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("systemctl operation failed"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error("systemctl operation failed"));
    });
  });
}

function spawnSystemctlRestart() {
  return spawnSystemctl("restart", SERVICE);
}

function adminRequest(pathname, token = null) {
  return new Promise((resolve) => {
    const request = http.get({
      host: ADMIN_HOST,
      port: ADMIN_PORT,
      path: pathname,
      timeout: 2_000,
      headers: {
        accept: "application/json",
        connection: "close",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) response.destroy();
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve(null);
        }
      });
      response.once("error", () => resolve(null));
      response.once("aborted", () => resolve(null));
    });
    request.once("timeout", () => { request.destroy(); resolve(null); });
    request.once("error", () => resolve(null));
  });
}

function adminSwitch(alias, token) {
  return new Promise((resolve) => {
    const request = http.request({
      host: ADMIN_HOST,
      port: ADMIN_PORT,
      path: "/v1/switch",
      method: "POST",
      timeout: 5_000,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) response.destroy();
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch {
          resolve(null);
        }
      });
      response.once("error", () => resolve(null));
      response.once("aborted", () => resolve(null));
    });
    request.once("timeout", () => { request.destroy(); resolve(null); });
    request.once("error", () => resolve(null));
    request.end(JSON.stringify({ account_alias: alias, reason: "manual" }));
  });
}

async function waitForReadiness(expectedAccounts) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let backoff = 100;
  while (Date.now() < deadline) {
    const response = await adminRequest("/readyz");
    if (
      response?.statusCode === 200 && response.body?.status === "ready" &&
      Number.isSafeInteger(response.body.usable_accounts) &&
      response.body.usable_accounts >= expectedAccounts
    ) return true;
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 1_000);
  }
  return false;
}

async function waitForAppServer() {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let backoff = 100;
  while (Date.now() < deadline) {
    try {
      await spawnSystemctl("is-active", APP_SERVER_SERVICE);
      const socket = await fs.lstat(APP_SERVER_SOCKET);
      if (socket.isSocket()) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 1_000);
  }
  return false;
}

async function readPrivateToken(filePath) {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size < 24 || stat.size > 4096) {
      throw new Error("admin token is unavailable");
    }
    const token = (await handle.readFile()).toString("utf8");
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("admin token is unavailable");
    return token;
  } finally {
    await handle.close();
  }
}

async function start() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("account manager requires root on Linux");
  }
  const sourceRoot = process.env.CODEX_ROUTER_ACCOUNT_AUTH_ROOT ?? "/var/lib/codex-web-router-account-auth";
  const adminTokenFile = process.env.CODEX_ROUTER_ADMIN_SOURCE_TOKEN_FILE ?? "/etc/codex-account-router/credentials/admin-token";
  const manager = createAccountEnrollmentManager({
    accountsFile: "/etc/codex-account-router/accounts.json",
    credentialStoreDirectory: "/etc/credstore",
    credentialUid: 0,
    credentialGid: 0,
    restartRouter: spawnSystemctlRestart,
    routerReady: waitForReadiness,
    accountEnrollmentAllowed: async () => {
      const token = await readPrivateToken(adminTokenFile);
      const response = await adminRequest("/v1/status", token);
      return Boolean(
        response?.statusCode === 200 && response.body?.active_streams === 0 &&
        response.body?.active_requests === 0,
      );
    },
    accountRemovalAllowed: async ({ alias }) => {
      const token = await readPrivateToken(adminTokenFile);
      const response = await adminRequest("/v1/status", token);
      return Boolean(
        response?.statusCode === 200 && response.body?.active_streams === 0 &&
        response.body?.active_requests === 0 &&
        response.body?.current_route?.account_alias !== alias &&
        Array.isArray(response.body?.accounts) &&
        response.body.accounts.some((account) => account?.alias === alias),
      );
    },
  });
  const token = await readPrivateToken(adminTokenFile);
  const rebinder = createNativeAccountRebinder({
    accountsFile: "/etc/codex-account-router/accounts.json",
    credentialStoreDirectory: "/etc/credstore",
    appServerCredentialFile: APP_SERVER_CREDENTIAL_FILE,
    routerStatus: async () => {
      const response = await adminRequest("/v1/status", token);
      if (response?.statusCode !== 200) throw new Error("router status is unavailable");
      return response.body;
    },
    routerSwitch: async (alias) => {
      const response = await adminSwitch(alias, token);
      if (response?.statusCode !== 200) throw new Error("router switch was rejected");
      return response.body;
    },
    stopAppServer: () => spawnSystemctl("stop", APP_SERVER_SERVICE),
    startAppServer: () => spawnSystemctl("start", APP_SERVER_SERVICE),
    appServerReady: waitForAppServer,
  });
  const server = createManagerProtocolServer({
    sourceRoot,
    enroll: async (request) => {
      await assertAuthSourceBoundary(sourceRoot, request.sourceFile);
      return manager.enroll(request);
    },
    remove: (request) => manager.remove(request),
    switchAccount: (request) => rebinder.switchToAlias(request.alias),
    observe: async () => ({
      event: "router_account_observer_ready",
      configured_accounts: await rebinder.configuredAccountCount(),
    }),
  });
  server.listen({ fd: 3 });
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const result = await rebinder.reconcileCurrentRoute();
      if (result.rebound === true) await spawnSystemctl("restart", WEB_SERVICE);
    } catch {
      // Busy routes and concurrent catalog operations are retried on the next tick.
    } finally {
      reconciling = false;
    }
  };
  const interval = setInterval(() => { void reconcile(); }, 3_000);
  interval.unref();
}

if (isDirectManagerInvocation(import.meta.url, process.argv[1])) {
  start().catch(() => {
    process.stderr.write("account manager failed\n");
    process.exitCode = 1;
  });
}
