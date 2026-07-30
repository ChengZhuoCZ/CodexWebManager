import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRouterService,
  listenWithDeadline,
  SERVICE_STATES,
} from "../src/service.mjs";

const packageDirectory = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const stalledRuntimeLoadPreload = new URL(
  "../fixtures/startup/stall-runtime-load.mjs",
  import.meta.url,
).href;

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

test("rejects a pre-aborted listener start before binding", async () => {
  const service = createRouterService({ adminPort: 0 });
  const controller = new AbortController();
  const reason = new Error("fixture listener start cancelled");
  controller.abort(reason);

  await assert.rejects(
    service.start({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(service.state, SERVICE_STATES.STOPPED);
  assert.equal(service.address, null);
});

test("bounds a standalone listener start and removes its event hooks", async () => {
  const server = new EventEmitter();
  let listenOptions = null;
  server.listen = (options) => {
    listenOptions = options;
  };

  const outcome = await Promise.race([
    listenWithDeadline(server, {
      port: 0,
      host: "127.0.0.1",
      deadlineMs: 50,
    }).then(
      () => "resolved",
      (error) => error?.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 150)),
  ]);

  assert.equal(outcome, "listener start deadline exceeded");
  assert.equal(listenOptions?.signal?.aborted, true);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("listening"), 0);
});

test("uses a parent listener signal without opening a fresh deadline", async () => {
  const server = new EventEmitter();
  let listenOptions = null;
  server.listen = (options) => {
    listenOptions = options;
  };
  const controller = new AbortController();
  const parentReason = new Error("fixture parent listener deadline");
  const operation = listenWithDeadline(server, {
    port: 0,
    host: "127.0.0.1",
    signal: controller.signal,
    deadlineMs: 1,
  });

  const earlyOutcome = await Promise.race([
    operation.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
  assert.equal(earlyOutcome, "pending");
  assert.equal(listenOptions?.signal, controller.signal);

  controller.abort(parentReason);
  await assert.rejects(operation, (error) => error === parentReason);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("listening"), 0);
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

test("stops an active admin event stream without waiting for an external kill", async (context) => {
  const service = createRouterService({
    adminPort: 0,
    adminHandler(_request, response, pathname) {
      assert.equal(pathname, "/fixture-events");
      response.writeHead(200, {
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(": fixture-connected\n\n");
    },
  });
  let clientRequest = null;
  let clientResponse = null;
  let stopPromise = null;
  context.after(async () => {
    clientResponse?.destroy();
    clientRequest?.destroy();
    await stopPromise?.catch(() => undefined);
    await service.stop().catch(() => undefined);
  });
  const address = await service.start();
  const connected = new Promise((resolve, reject) => {
    clientRequest = http.get(
      `http://127.0.0.1:${address.port}/fixture-events`,
      (response) => {
        clientResponse = response;
        response.once("data", () => resolve(response));
      },
    );
    clientRequest.once("error", reject);
  });
  clientRequest.on("error", () => undefined);
  const response = await withTimeout(connected, "admin event stream");
  assert.equal(response.statusCode, 200);
  const responseClosed = new Promise((resolve) => {
    for (const event of ["aborted", "close", "error"]) {
      response.once(event, () => resolve(event));
    }
  });

  stopPromise = service.stop();
  const outcome = await Promise.race([
    stopPromise.then(() => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
  ]);

  assert.equal(outcome, "stopped");
  assert.match(
    await withTimeout(responseClosed, "admin event stream close"),
    /^(?:aborted|close|error)$/,
  );
  assert.equal(service.state, SERVICE_STATES.STOPPED);
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

test("CLI treats SIGTERM during a stalled startup as a normal stop", async (context) => {
  const stalledAccountsPath = "/fixture/stalled-accounts.json";
  const childEnvironment = { ...process.env };
  for (const name of Object.keys(childEnvironment)) {
    if (name.startsWith("CODEX_ROUTER_")) delete childEnvironment[name];
  }
  for (const name of [
    "CREDENTIALS_DIRECTORY",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
  ]) {
    delete childEnvironment[name];
  }
  Object.assign(childEnvironment, {
    CODEX_ROUTER_ACCOUNTS_FILE: stalledAccountsPath,
    CODEX_ROUTER_CREDENTIAL_ROOT: "/fixture/credentials",
    CODEX_ROUTER_TEST_STALLED_ACCOUNTS_FILE: stalledAccountsPath,
  });
  const child = spawn(
    process.execPath,
    ["--import", stalledRuntimeLoadPreload, "src/main.mjs"],
    {
      cwd: packageDirectory,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

  await withTimeout(once(child.stdout, "data"), "stalled CLI startup", 1_000);
  assert.match(stdout, /"event":"fixture_runtime_load_stalled"/);
  child.kill("SIGTERM");
  const [code, signal] = await withTimeout(childExit, "stalled CLI stop", 1_000);

  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, "");
  assert.match(stdout, /"event":"router_stopping","signal":"SIGTERM"/);
  assert.doesNotMatch(stdout, /"event":"router_started"/);
  assert.doesNotMatch(stderr, /"event":"router_start_failed"/);
});

test("CLI closes an active protected admin event stream on SIGTERM", async (context) => {
  const privateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-router-admin-stop-"),
  );
  await fs.chmod(privateDirectory, 0o700);
  const adminTokenPath = path.join(privateDirectory, "admin-token");
  const adminToken = "fixture-admin-stop-token-0123456789";
  await fs.writeFile(adminTokenPath, adminToken, { mode: 0o600 });
  const childEnvironment = {
    ...process.env,
    CODEX_ROUTER_ADMIN_PORT: "0",
    CODEX_ROUTER_ADMIN_TOKEN_FILE: adminTokenPath,
    CODEX_ROUTER_MODEL_PORT: "0",
  };
  for (const name of [
    "CODEX_ROUTER_ACCOUNTS_FILE",
    "CODEX_ROUTER_ADMIN_HOST",
    "CODEX_ROUTER_CREDENTIAL_ROOT",
    "CODEX_ROUTER_MODEL_HOST",
    "CODEX_ROUTER_STATE_DIRECTORY",
    "CODEX_ROUTER_UPSTREAM_ORIGIN",
    "CREDENTIALS_DIRECTORY",
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
  const streamController = new AbortController();
  context.after(async () => {
    streamController.abort();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await childExit;
    await fs.rm(privateDirectory, { recursive: true, force: true });
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
  const events = await fetch(
    `http://127.0.0.1:${started.bind_port}/v1/events`,
    {
      headers: { authorization: `Bearer ${adminToken}` },
      signal: streamController.signal,
    },
  );
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  const connected = await withTimeout(reader.read(), "admin event stream connect");
  assert.equal(connected.done, false);
  assert.match(Buffer.from(connected.value).toString("utf8"), /connected/);
  const streamTerminated = reader.read().then(
    ({ done }) => done ? "ended" : "data",
    () => "aborted",
  );

  child.kill("SIGTERM");
  const [code, signal] = await withTimeout(childExit, "CLI active-stream stop");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(
    await withTimeout(streamTerminated, "admin event stream termination"),
    /^(?:aborted|ended)$/,
  );
  assert.equal(stderr, "");
  assert.match(stdout, /"event":"router_stopping"/);
  assert.doesNotMatch(stdout, /router_stop_failed/);
  assert.doesNotMatch(stdout, /fixture-admin-stop-token/);
  assert.doesNotMatch(stderr, /fixture-admin-stop-token/);
});
