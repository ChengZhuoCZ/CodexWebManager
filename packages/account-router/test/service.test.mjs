import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRouterService, SERVICE_STATES } from "../src/service.mjs";

const packageDirectory = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function readJson(response) {
  const body = await response.text();
  return { body, value: body ? JSON.parse(body) : null };
}

function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("starts with zero accounts and exposes health plus explicit non-readiness", async (context) => {
  const service = createRouterService({ adminPort: 0 });
  context.after(() => service.stop());
  assert.equal(service.state, SERVICE_STATES.CREATED);
  const address = await service.start();
  assert.equal(service.state, SERVICE_STATES.RUNNING);
  assert.equal(address.address, "127.0.0.1");

  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual((await readJson(health)).value, {
    service: "codex-account-router",
    status: "ok",
  });

  const readiness = await fetch(`${origin}/readyz`);
  assert.equal(readiness.status, 503);
  assert.deepEqual((await readJson(readiness)).value, {
    service: "codex-account-router",
    status: "not_ready",
    reason: "no_accounts",
    usable_accounts: 0,
  });
});

test("becomes ready only when the account-count provider reports usable accounts", async (context) => {
  let accountCount = 0;
  const service = createRouterService({
    adminPort: 0,
    getUsableAccountCount: () => accountCount,
  });
  context.after(() => service.stop());
  const address = await service.start();
  const url = `http://127.0.0.1:${address.port}/readyz`;
  assert.equal((await fetch(url)).status, 503);
  accountCount = 2;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual((await readJson(response)).value, {
    service: "codex-account-router",
    status: "ready",
    usable_accounts: 2,
  });
  accountCount = Number.NaN;
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.equal((await readJson(unavailable)).value.reason, "account_state_unavailable");
});

test("fails readiness closed when the account provider throws", async (context) => {
  const service = createRouterService({
    adminPort: 0,
    getUsableAccountCount: () => {
      throw new Error("fixture provider failure");
    },
  });
  context.after(() => service.stop());
  const address = await service.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).value.reason, "account_state_unavailable");

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
});

test("fails closed for unsupported methods, paths, and query variants", async (context) => {
  const service = createRouterService({ adminPort: 0 });
  context.after(() => service.stop());
  const address = await service.start();
  const origin = `http://127.0.0.1:${address.port}`;

  const method = await fetch(`${origin}/healthz`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
  assert.equal((await readJson(method)).value.error, "method_not_allowed");

  const missing = await fetch(`${origin}/v1/status`);
  assert.equal(missing.status, 404);
  assert.equal((await readJson(missing)).value.error, "not_found");

  const query = await fetch(`${origin}/healthz?unexpected=true`);
  assert.equal(query.status, 400);
  assert.equal((await readJson(query)).value.error, "invalid_request_target");

  const head = await fetch(`${origin}/healthz`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("has no desktop-runtime or third-party production dependency", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
  assert.equal(manifest.engines.node, ">=22");
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  const sourceDirectory = path.join(packageDirectory, "src");
  const files = await fs.readdir(sourceDirectory);
  const source = (
    await Promise.all(files.filter((file) => file.endsWith(".mjs")).map((file) =>
      fs.readFile(path.join(sourceDirectory, file), "utf8"),
    ))
  ).join("\n");
  assert.doesNotMatch(source, /(?:electron|keytar|x11|wayland|darwin-keychain)/i);
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    assert.match(match[1], /^(?:node:|\.\/)/);
  }
});

test("CLI starts headlessly on loopback and exits cleanly on SIGTERM", async (context) => {
  const childEnvironment = {
    ...process.env,
    CODEX_ROUTER_ADMIN_PORT: "0",
    CODEX_ROUTER_MODEL_PORT: "0",
  };
  for (const name of [
    "CODEX_ROUTER_ADMIN_HOST",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
  ]) {
    delete childEnvironment[name];
  }
  const child = spawn(process.execPath, ["src/main.mjs"], {
    cwd: packageDirectory,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExit = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await childExit;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await withTimeout(once(child.stdout, "data"), "CLI start");
  const started = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((record) => record.event === "router_started");
  assert.equal(started.bind_address, "127.0.0.1");
  assert.equal(started.architecture_mode, "LIMITED_MODE");

  const health = await fetch(`http://127.0.0.1:${started.bind_port}/healthz`);
  assert.equal(health.status, 200);
  child.kill("SIGTERM");
  const [code, signal] = await withTimeout(childExit, "CLI stop");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, "");
  assert.match(stdout, /"event":"router_stopping"/);
});
