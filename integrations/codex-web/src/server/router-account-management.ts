import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const START_PATH = "/__backend/codex-router/accounts/device-auth";
const OPERATION_PATH = `${START_PATH}/:operationId`;
const REMOVE_PATH = "/__backend/codex-router/accounts/:accountAlias";
const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const MANAGER_RESPONSE_LIMIT = 8 * 1024;
const AUTH_OUTPUT_LIMIT = 64 * 1024;
const AUTH_TIMEOUT_MS = 20 * 60 * 1_000;
const FINISHED_RETENTION_MS = 10 * 60 * 1_000;
const VERIFICATION_URL_PATTERN = /https:\/\/(?:auth\.openai\.com|platform\.openai\.com|chatgpt\.com)\/[^\s<>"']+/u;
const USER_CODE_PATTERN = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b/u;

type ManagementConfig =
  | { enabled: false }
  | {
      enabled: true;
      authRoot: string;
      codexCli: string;
      managerSocket: string;
    };

type OperationPhase = "starting" | "waiting" | "installing" | "complete" | "failed" | "cancelled";

type DeviceAuthOperation = {
  alias: string;
  child: ChildProcess | null;
  createdAt: number;
  directory: string;
  failure: "device_auth_failed" | "account_install_failed" | null;
  finishedAt: number | null;
  id: string;
  output: string;
  phase: OperationPhase;
  userCode: string | null;
  verificationUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeAlias(value: unknown): string {
  if (
    typeof value !== "string" || value.trim() !== value ||
    !SAFE_ALIAS_PATTERN.test(value) || value.includes("@")
  ) throw new Error("account alias is invalid");
  return value;
}

function loadConfig(environment: NodeJS.ProcessEnv): ManagementConfig {
  const authRoot = environment.CODEX_ROUTER_ACCOUNT_AUTH_ROOT;
  const codexCli = environment.CODEX_REAL_CLI_PATH;
  const managerSocket = environment.CODEX_ROUTER_ACCOUNT_MANAGER_SOCKET;
  if (authRoot === undefined && codexCli === undefined && managerSocket === undefined) {
    return { enabled: false };
  }
  if (
    authRoot === undefined || codexCli === undefined || managerSocket === undefined ||
    !path.isAbsolute(authRoot) || !authRoot.startsWith(`/var/lib${path.sep}`) ||
    !path.isAbsolute(codexCli) || !path.isAbsolute(managerSocket) ||
    !managerSocket.startsWith(`/run${path.sep}`) || !managerSocket.endsWith(".sock") ||
    [authRoot, codexCli, managerSocket].some((value) => value.includes("\0") || value.includes("\n"))
  ) throw new Error("router account management configuration is invalid");
  return {
    enabled: true,
    authRoot: path.normalize(authRoot),
    codexCli: path.normalize(codexCli),
    managerSocket: path.normalize(managerSocket),
  };
}

function publicOperation(operation: DeviceAuthOperation) {
  return {
    enabled: true,
    operation_id: operation.id,
    account_alias: operation.alias,
    phase: operation.phase,
    verification_url: operation.phase === "waiting" ? operation.verificationUrl : null,
    user_code: operation.phase === "waiting" ? operation.userCode : null,
    error: operation.failure,
  };
}

export function extractDeviceAuthorizationPrompt(value: string) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > AUTH_OUTPUT_LIMIT) {
    return null;
  }
  const verificationUrl = value.match(VERIFICATION_URL_PATTERN)?.[0] ?? null;
  const userCode = value.match(USER_CODE_PATTERN)?.[0] ?? null;
  return verificationUrl !== null && userCode !== null
    ? Object.freeze({ verificationUrl, userCode })
    : null;
}

function managerRequest(socketPath: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let length = 0;
    const chunks: Buffer[] = [];
    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== null || result === undefined) reject(error ?? new Error("account manager failed"));
      else resolve(result);
    };
    const socket = net.createConnection(socketPath);
    socket.setTimeout(35_000, () => finish(new Error("account manager timed out")));
    socket.once("error", () => finish(new Error("account manager failed")));
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MANAGER_RESPONSE_LIMIT) {
        finish(new Error("account manager failed"));
        return;
      }
      chunks.push(bytes);
    });
    socket.once("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (
          !isRecord(body) || body.ok !== true || body.credentials_exposed !== false ||
          !Number.isSafeInteger(body.configured_accounts) || Number(body.configured_accounts) < 1
        ) throw new Error("account manager failed");
        finish(null, body);
      } catch {
        finish(new Error("account manager failed"));
      }
    });
  });
}

function loginEnvironment(directory: string): NodeJS.ProcessEnv {
  const inherited = [
    "PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
  ];
  const environment: NodeJS.ProcessEnv = { HOME: directory, CODEX_HOME: directory };
  for (const name of inherited) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export async function registerRouterAccountManagement(
  app: FastifyInstance,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const config = loadConfig(environment);
  const operations = new Map<string, DeviceAuthOperation>();

  const finish = (operation: DeviceAuthOperation, phase: OperationPhase, failure: DeviceAuthOperation["failure"]) => {
    operation.phase = phase;
    operation.failure = failure;
    operation.finishedAt = Date.now();
    operation.child = null;
    operation.output = "";
  };

  const cleanupOperation = async (operation: DeviceAuthOperation) => {
    await fs.rm(operation.directory, { recursive: true, force: true }).catch(() => {});
  };

  const reap = () => {
    const now = Date.now();
    for (const [id, operation] of operations) {
      if (operation.finishedAt !== null && now - operation.finishedAt >= FINISHED_RETENTION_MS) {
        operations.delete(id);
      }
    }
  };

  app.post(START_PATH, { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    if (!isRecord(request.body) || Object.keys(request.body).length !== 1) {
      return reply.code(400).send({ enabled: true, error: "invalid_account_request" });
    }
    let alias: string;
    try { alias = safeAlias(request.body.alias); } catch {
      return reply.code(400).send({ enabled: true, error: "invalid_account_request" });
    }
    reap();
    if ([...operations.values()].some((operation) => operation.finishedAt === null)) {
      return reply.code(409).send({ enabled: true, error: "device_auth_in_progress" });
    }
    const id = randomBytes(16).toString("hex");
    const directory = path.join(config.authRoot, id);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const child = spawn(config.codexCli, ["login", "--device-auth"], {
      cwd: directory,
      env: loginEnvironment(directory),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const operation: DeviceAuthOperation = {
      alias, child, createdAt: Date.now(), directory, failure: null, finishedAt: null,
      id, output: "", phase: "starting", userCode: null, verificationUrl: null,
    };
    operations.set(id, operation);
    const timeout = setTimeout(() => child.kill("SIGTERM"), AUTH_TIMEOUT_MS);
    timeout.unref();
    const receive = (chunk: Buffer) => {
      if (operation.output.length >= AUTH_OUTPUT_LIMIT) return;
      operation.output = `${operation.output}${chunk.toString("utf8")}`.slice(-AUTH_OUTPUT_LIMIT);
      const prompt = extractDeviceAuthorizationPrompt(operation.output);
      if (prompt !== null && operation.phase === "starting") {
        operation.verificationUrl = prompt.verificationUrl;
        operation.userCode = prompt.userCode;
        operation.phase = "waiting";
      }
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.once("error", async () => {
      clearTimeout(timeout);
      finish(operation, "failed", "device_auth_failed");
      await cleanupOperation(operation);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timeout);
      if (operation.phase === "cancelled") {
        await cleanupOperation(operation);
        return;
      }
      if (code !== 0 || signal !== null) {
        finish(operation, "failed", "device_auth_failed");
        await cleanupOperation(operation);
        return;
      }
      operation.phase = "installing";
      try {
        const authFile = path.join(directory, "auth.json");
        const handle = await fs.open(authFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 1024 * 1024) {
            throw new Error("authorized credential is unavailable");
          }
        } finally {
          await handle.close();
        }
        await managerRequest(config.managerSocket, {
          operation: "enroll",
          source_file: authFile,
          id: `web-${id.slice(0, 24)}`,
          alias,
        });
        finish(operation, "complete", null);
      } catch {
        finish(operation, "failed", "account_install_failed");
      }
      await cleanupOperation(operation);
    });
    return reply.code(202).send(publicOperation(operation));
  });

  app.get(OPERATION_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    const operationId = (request.params as Record<string, unknown>).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send({ enabled: true, error: "invalid_account_request" });
    }
    reap();
    const operation = operations.get(operationId);
    return operation === undefined
      ? reply.code(404).send({ enabled: true, error: "device_auth_not_found" })
      : reply.send(publicOperation(operation));
  });

  app.delete(OPERATION_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    const operationId = (request.params as Record<string, unknown>).operationId;
    const operation = typeof operationId === "string" ? operations.get(operationId) : undefined;
    if (operation === undefined || operation.finishedAt !== null) {
      return reply.code(404).send({ enabled: true, error: "device_auth_not_found" });
    }
    operation.phase = "cancelled";
    operation.finishedAt = Date.now();
    operation.output = "";
    operation.child?.kill("SIGTERM");
    return reply.code(202).send(publicOperation(operation));
  });

  app.delete(REMOVE_PATH, { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    let accountAlias: string;
    try { accountAlias = safeAlias((request.params as Record<string, unknown>).accountAlias); } catch {
      return reply.code(400).send({ enabled: true, error: "invalid_account_request" });
    }
    if (
      !isRecord(request.body) || Object.keys(request.body).length !== 1 ||
      request.body.confirm_alias !== accountAlias
    ) return reply.code(400).send({ enabled: true, error: "account_confirmation_required" });
    try {
      const result = await managerRequest(config.managerSocket, {
        operation: "remove",
        alias: accountAlias,
      });
      return reply.send({
        enabled: true,
        removed: true,
        account_alias: accountAlias,
        configured_accounts: result.configured_accounts,
      });
    } catch {
      return reply.code(409).send({ enabled: true, error: "account_removal_rejected" });
    }
  });

  app.addHook("onClose", async () => {
    for (const operation of operations.values()) {
      operation.child?.kill("SIGTERM");
      await cleanupOperation(operation);
    }
    operations.clear();
  });
}
