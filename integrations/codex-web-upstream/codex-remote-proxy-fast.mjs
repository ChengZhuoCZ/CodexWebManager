#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import readline from "node:readline";
import { localStartupRpcResponse } from "./codex-remote-fastpath.mjs";

const EXIT_USAGE = 64;
const EXIT_SOFTWARE = 70;
const runtimeRequire = createRequire(
  "/opt/0xcaff-codex-web-router/current/package.json",
);
const WebSocket = runtimeRequire("ws");

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function validateSocketPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/run/") ||
    !value.endsWith(".sock") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.length > 160
  ) {
    fail("codex remote proxy configuration is invalid");
  }
  return value;
}

function appServerInvocation(rawArgs) {
  if (rawArgs.length === 1 && rawArgs[0] === "--version") {
    return { mode: "version" };
  }

  const args = [...rawArgs];
  while (args[0] === "-c") {
    if (args.length < 2 || args[1].length === 0) {
      fail("codex remote proxy received -c without a value");
    }
    args.splice(0, 2);
  }
  if (args[0] !== "app-server") {
    fail("codex remote proxy only supports app-server mode");
  }
  return { mode: "app-server" };
}

function delegateVersion() {
  const executable = process.env.CODEX_REAL_CLI_PATH || "/usr/local/bin/codex";
  const child = spawn(executable, ["--version"], {
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", () => {
    process.exitCode = EXIT_SOFTWARE;
  });
  child.once("exit", (code) => {
    process.exitCode = Number.isInteger(code) ? code : EXIT_SOFTWARE;
  });
}

async function writeStdout(chunk) {
  if (process.stdout.write(chunk)) {
    return;
  }
  await new Promise((resolve) => process.stdout.once("drain", resolve));
}

async function bridge(socketPath) {
  const websocket = new WebSocket("ws://localhost/", {
    createConnection: () => net.createConnection(socketPath),
    maxPayload: 100 * 1024 * 1024,
    perMessageDeflate: false,
  });

  await new Promise((resolve, reject) => {
    websocket.once("open", resolve);
    websocket.once("error", reject);
  });

  websocket.on("message", (data, isBinary) => {
    if (isBinary) {
      process.stderr.write(
        "codex remote proxy received an unexpected binary frame\n",
      );
      websocket.close();
      return;
    }
    void writeStdout(Buffer.concat([Buffer.from(data), Buffer.from("\n")]));
  });

  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const localResponse = localStartupRpcResponse(line);
    if (localResponse !== null) {
      await writeStdout(localResponse);
      continue;
    }
    await new Promise((resolve, reject) => {
      websocket.send(line, { binary: false }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  websocket.close();
}

const invocation = appServerInvocation(process.argv.slice(2));
if (invocation.mode === "version") {
  delegateVersion();
} else {
  const socketPath = validateSocketPath(process.env.CODEX_UNIX_SOCKET);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => process.exit(0));
  }
  bridge(socketPath).catch(() => {
    process.stderr.write("codex remote proxy connection failed\n");
    process.exitCode = EXIT_SOFTWARE;
  });
}
