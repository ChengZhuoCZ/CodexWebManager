#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";

import { createAccountEnrollmentManager } from "../src/account-enrollment.mjs";

const SERVICE = "codex-account-router.service";
const ADMIN_HOST = "127.0.0.1";
const ADMIN_PORT = 18318;
const OPERATION_TIMEOUT_MS = 30_000;

function usage() {
  return `Usage:
  codex-router-account enroll \\
    --source-file ABSOLUTE_PRIVATE_AUTH_JSON \\
    --id OPAQUE_ID \\
    --alias OPAQUE_ALIAS \\
    [--priority INTEGER] \\
    [--max-concurrency INTEGER]
`;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^-?[0-9]+$/.test(value ?? "")) {
    throw new Error(`${name} must be an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return number;
}

export function parseAccountCommand(argumentsList) {
  if (argumentsList.length === 1 && new Set(["-h", "--help"]).has(argumentsList[0])) {
    return Object.freeze({ help: true });
  }
  if (argumentsList[0] !== "enroll") throw new Error("account command is invalid");
  const values = new Map();
  const allowed = new Set([
    "--source-file",
    "--id",
    "--alias",
    "--priority",
    "--max-concurrency",
  ]);
  for (let index = 1; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!allowed.has(option) || values.has(option) || typeof value !== "string") {
      throw new Error("account option is invalid");
    }
    values.set(option, value);
  }
  for (const required of ["--source-file", "--id", "--alias"]) {
    if (!values.has(required)) throw new Error("account command is incomplete");
  }
  return Object.freeze({
    command: "enroll",
    sourceFile: values.get("--source-file"),
    id: values.get("--id"),
    alias: values.get("--alias"),
    priority: boundedInteger(values.get("--priority") ?? "0", "priority", -1_000, 1_000),
    maxConcurrency: boundedInteger(
      values.get("--max-concurrency") ?? "1",
      "max concurrency",
      1,
      64,
    ),
  });
}

function restartRouter() {
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

function readinessRequest(expectedAccounts) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({
      host: ADMIN_HOST,
      port: ADMIN_PORT,
      path: "/readyz",
      timeout: 2_000,
      headers: { accept: "application/json", connection: "close" },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 4_096) {
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(
            response.statusCode === 200 &&
            payload.status === "ready" &&
            Number.isSafeInteger(payload.usable_accounts) &&
            payload.usable_accounts >= expectedAccounts,
          );
        } catch {
          finish(false);
        }
      });
      response.once("error", () => finish(false));
      response.once("aborted", () => finish(false));
    });
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReadiness(expectedAccounts) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let backoff = 100;
  while (Date.now() < deadline) {
    if (await readinessRequest(expectedAccounts)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(backoff, remaining));
    backoff = Math.min(backoff * 2, 1_000);
  }
  return false;
}

async function main() {
  const command = parseAccountCommand(process.argv.slice(2));
  if (command.help) {
    process.stdout.write(usage());
    return;
  }
  if (
    process.platform !== "linux" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0
  ) {
    throw new Error("account command requires root on Linux");
  }
  const manager = createAccountEnrollmentManager({
    accountsFile: "/etc/codex-account-router/accounts.json",
    credentialStoreDirectory: "/etc/credstore",
    credentialUid: 0,
    credentialGid: 0,
    restartRouter,
    routerReady: waitForReadiness,
  });
  const result = await manager.enroll(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write("account enrollment failed\n");
    process.exitCode = 1;
  });
}
