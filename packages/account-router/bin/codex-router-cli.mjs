#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIGURATION_ERROR = "codex router wrapper configuration is invalid";
const EXECUTION_ERROR = "codex router wrapper execution failed";

function fail(message = CONFIGURATION_ERROR, code = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function realExecutable(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail();
  try {
    const resolved = realpathSync(value);
    const self = realpathSync(fileURLToPath(import.meta.url));
    if (resolved === self || !statSync(resolved).isFile()) fail();
    accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    fail();
  }
}

function routerBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]"]).has(url.hostname) ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/backend-api/codex" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail();
  }
  return url.toString().replace(/\/$/, "");
}

function invocation(args) {
  if (args.length === 1 && args[0] === "--version") {
    return Object.freeze({ mode: "version", args });
  }
  let index = 0;
  while (args[index] === "-c") {
    if (typeof args[index + 1] !== "string" || args[index + 1].length === 0) fail();
    index += 2;
  }
  if (args[index] !== "app-server") fail();
  return Object.freeze({ mode: "app-server", args });
}

const executable = realExecutable(process.env.CODEX_REAL_CLI_PATH);
const parsed = invocation(process.argv.slice(2));
const childEnvironment = { ...process.env };
delete childEnvironment.CODEX_REAL_CLI_PATH;
delete childEnvironment.CODEX_ROUTER_MODEL_BASE_URL;

const childArguments = parsed.mode === "version"
  ? parsed.args
  : [
      "-c",
      `openai_base_url=${JSON.stringify(routerBaseUrl(process.env.CODEX_ROUTER_MODEL_BASE_URL))}`,
      ...parsed.args,
    ];
const child = spawn(executable, childArguments, {
  env: childEnvironment,
  stdio: "inherit",
});
let settled = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!settled && child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.once("error", () => {
  if (settled) return;
  settled = true;
  process.stderr.write(`${EXECUTION_ERROR}\n`);
  process.exitCode = 70;
});
child.once("exit", (code) => {
  if (settled) return;
  settled = true;
  process.exitCode = Number.isInteger(code) ? code : 1;
});
