#!/usr/bin/env node

const { spawn } = require("node:child_process");
const http = require("node:http");

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const host = option("--host");
const port = Number.parseInt(option("--port") ?? "", 10);
if (host !== "127.0.0.1" || port !== 8214 || typeof process.env.CODEX_CLI_PATH !== "string") {
  process.exit(64);
}

let proxy;
let stopping = false;
let attempts = 0;
const maximumAttempts = 20;
const retryDelayMs = 250;
let retryDeadline = Date.now() + maximumAttempts * retryDelayMs + 5_000;

function startProxy() {
  if (stopping || attempts >= maximumAttempts || Date.now() > retryDeadline) return;
  attempts += 1;
  const startedAt = Date.now();
  proxy = spawn(
    process.env.CODEX_CLI_PATH,
    ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
    { env: process.env, stdio: "ignore" },
  );
  proxy.once("error", () => {
    if (!stopping) setTimeout(startProxy, retryDelayMs);
  });
  proxy.once("exit", () => {
    proxy = undefined;
    if (Date.now() - startedAt >= 1_000) {
      attempts = 0;
      retryDeadline = Date.now() + maximumAttempts * retryDelayMs + 5_000;
    }
    if (!stopping) setTimeout(startProxy, retryDelayMs);
  });
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ok: true, path: request.url }));
});
server.listen(port, host, startProxy);

function stop() {
  if (stopping) return;
  stopping = true;
  proxy?.kill("SIGTERM");
  server.close(() => process.exit(0));
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
