#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs, realpathSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createAccountEnrollmentManager } from "../src/account-enrollment.mjs";

const SERVICE = "codex-account-router.service";
const ADMIN_HOST = "127.0.0.1";
const ADMIN_PORT = 18318;
const OPERATION_TIMEOUT_MS = 30_000;
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

export function createManagerProtocolServer({ sourceRoot, enroll, remove }) {
  if (typeof enroll !== "function" || typeof remove !== "function") {
    throw new TypeError("account manager callbacks are required");
  }
  return net.createServer((socket) => {
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
        const result = request.operation === "enroll"
          ? await enroll(request)
          : await remove(request);
        boundedReply(socket, {
          ok: true,
          event: result.event,
          configured_accounts: result.configured_accounts,
          credentials_exposed: false,
        });
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

function spawnSystemctlRestart() {
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", ["restart", SERVICE], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("router restart timed out"));
    }, OPERATION_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("router restart failed"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error("router restart failed"));
    });
  });
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
      return Boolean(response?.statusCode === 200 && response.body?.active_streams === 0);
    },
    accountRemovalAllowed: async ({ alias }) => {
      const token = await readPrivateToken(adminTokenFile);
      const response = await adminRequest("/v1/status", token);
      return Boolean(
        response?.statusCode === 200 && response.body?.active_streams === 0 &&
        response.body?.current_route?.account_alias !== alias &&
        Array.isArray(response.body?.accounts) &&
        response.body.accounts.some((account) => account?.alias === alias),
      );
    },
  });
  const server = createManagerProtocolServer({
    sourceRoot,
    enroll: async (request) => {
      await assertAuthSourceBoundary(sourceRoot, request.sourceFile);
      return manager.enroll(request);
    },
    remove: (request) => manager.remove(request),
  });
  server.listen({ fd: 3 });
}

if (isDirectManagerInvocation(import.meta.url, process.argv[1])) {
  start().catch(() => {
    process.stderr.write("account manager failed\n");
    process.exitCode = 1;
  });
}
