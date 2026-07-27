#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";
import { createDeploymentManager } from "../src/deployment-manager.mjs";

const SERVICE = "codex-account-router.service";
const ADMIN_HOST = "127.0.0.1";
const ADMIN_PORT = 18318;
const HEALTH_PATH = "/healthz";
const OPERATION_TIMEOUT_MS = 30_000;

function usage() {
  return `Usage:
  codex-stack-deploy backup
  codex-stack-deploy upgrade --release-dir ABSOLUTE_DIRECTORY
  codex-stack-deploy rollback --snapshot SNAPSHOT_ID
`;
}

function parseArguments(argumentsList) {
  const [command, ...rest] = argumentsList;
  if (command === "--help" || command === "-h") return { help: true };
  if (!new Set(["backup", "upgrade", "rollback"]).has(command)) {
    throw new Error("deployment command is invalid");
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--release-dir" && options.releaseDirectory === undefined) {
      options.releaseDirectory = rest[++index];
    } else if (argument === "--snapshot" && options.snapshotId === undefined) {
      options.snapshotId = rest[++index];
    } else {
      throw new Error("deployment option is invalid");
    }
  }
  if (
    (command === "backup" && rest.length !== 0) ||
    (command === "upgrade" && typeof options.releaseDirectory !== "string") ||
    (command === "rollback" && typeof options.snapshotId !== "string")
  ) {
    throw new Error("deployment command is incomplete");
  }
  return options;
}

function runSystemctl(action) {
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", [action, SERVICE], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`service ${action} timed out`));
    }, OPERATION_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`service ${action} failed`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`service ${action} failed`));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function healthRequest() {
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
      path: HEALTH_PATH,
      timeout: 2_000,
      headers: { accept: "application/json", connection: "close" },
    }, (response) => {
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 4_096) response.destroy();
      });
      response.once("end", () => finish(response.statusCode === 200 && length <= 4_096));
      response.once("error", () => finish(false));
      response.once("aborted", () => finish(false));
      response.once("close", () => {
        if (!response.complete) finish(false);
      });
    });
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let backoff = 100;
  while (Date.now() < deadline) {
    if (await healthRequest()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(backoff, remaining));
    backoff = Math.min(backoff * 2, 1_000);
  }
  return false;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (
    process.platform !== "linux" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0
  ) {
    throw new Error("deployment command requires root on Linux");
  }
  const manager = createDeploymentManager({
    architecture: process.arch,
    backupRoot: "/var/backups/codex-account-router",
    configFile: "/etc/codex-account-router/accounts.json",
    healthCheck: waitForHealth,
    platform: process.platform,
    prefix: "/opt/codex-account-router",
    serviceController: {
      stop: () => runSystemctl("stop"),
      start: () => runSystemctl("start"),
    },
    stateFile: "/var/lib/codex-account-router/circuit-state.json",
  });
  let result;
  if (options.command === "backup") {
    result = await manager.backup();
  } else if (options.command === "upgrade") {
    result = await manager.upgrade({ releaseDirectory: options.releaseDirectory });
  } else {
    result = await manager.rollback({ snapshotId: options.snapshotId });
  }
  process.stdout.write(`${JSON.stringify({
    event: `deployment_${options.command}_completed`,
    architecture_mode: "LIMITED_MODE",
    release: result.release,
    snapshot_id: result.snapshot_id,
    credentials_included: false,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`deployment operation failed: ${error.message}\n`);
  process.exitCode = 1;
});
