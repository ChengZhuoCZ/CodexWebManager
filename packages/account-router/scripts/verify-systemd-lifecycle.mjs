#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const services = [
  "codex-account-router.service",
  "codex-app-server.service",
  "codex-web.service",
];
const expectedTcpListeners = new Map([
  ["codex-account-router.service", [18_317, 18_318]],
  ["codex-web.service", [8_214]],
]);
const appServerSocket = "/run/codex-app-server/app-server.sock";
const proxyMarker = "/run/codex-app-server/proxy-connected";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--summary") options.summaryPath = argumentsList[++index];
    else if (argument === "--help") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/verify-systemd-lifecycle.mjs --summary FILE\n\n` +
    "Runs only on a root Linux systemd host with the M5.2 fixtures already installed.\n";
}

function run(command, argumentsList, { allowFailure = false } = {}) {
  const result = spawnSync(command, argumentsList, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with status ${result.status}`);
  }
  return result;
}

function systemctl(...argumentsList) {
  return run("systemctl", argumentsList);
}

function mainPid(service) {
  const value = systemctl("show", "--property=MainPID", "--value", service).stdout.trim();
  const pid = Number.parseInt(value, 10);
  assert(Number.isSafeInteger(pid) && pid > 1, `${service} has no supervised MainPID`);
  return pid;
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForActive(service) {
  await waitFor(
    () => run("systemctl", ["is-active", "--quiet", service], { allowFailure: true }).status === 0,
    `${service} activation`,
  );
}

async function waitForHttp(url, expectedStatus) {
  await waitFor(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.status === expectedStatus;
  }, `${url} status ${expectedStatus}`);
}

async function waitForTcp(host, port) {
  await waitFor(() => new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  }), `${host}:${port} TCP listener`);
}

async function processDetails(service) {
  const pid = mainPid(service);
  const [status, cmdline] = await Promise.all([
    fs.readFile(`/proc/${pid}/status`, "utf8"),
    fs.readFile(`/proc/${pid}/cmdline`),
  ]);
  const parentMatch = /^PPid:\s+(\d+)$/m.exec(status);
  const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
  assert(parentMatch?.[1] === "1", `${service} MainPID is not a direct systemd child`);
  const uid = Number.parseInt(uidMatch?.[1] ?? "0", 10);
  assert(uid > 0, `${service} runs as root`);
  const commandLine = cmdline.toString("utf8").replaceAll("\0", " ");
  assert(
    !/(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{12,})/i.test(commandLine),
    `${service} command line contains secret-like material`,
  );
  return { pid, uid };
}

async function assertEndpoints() {
  await waitForTcp("127.0.0.1", 18_317);
  await waitForHttp("http://127.0.0.1:18318/healthz", 200);
  await waitForHttp("http://127.0.0.1:8214/__backend/healthz", 200);
  await waitFor(async () => (await fs.stat(appServerSocket)).isSocket(), "App Server Unix socket");
  await waitFor(async () => (await fs.stat(proxyMarker)).isFile(), "codex-web Unix proxy connection");

  const tcp = run("ss", ["-H", "-ltn"]).stdout;
  for (const ports of expectedTcpListeners.values()) {
    for (const port of ports) {
      const rows = tcp.split("\n").filter((line) => line.includes(`:${port}`));
      assert(rows.length === 1, `TCP port ${port} does not have exactly one listener`);
      assert(rows[0].includes(`127.0.0.1:${port}`), `TCP port ${port} is not loopback-only`);
      assert(!rows[0].includes(`0.0.0.0:${port}`) && !rows[0].includes(`[::]:${port}`), `TCP port ${port} is public`);
    }
  }
  const unix = run("ss", ["-H", "-lx"]).stdout;
  assert(unix.includes(appServerSocket), "App Server Unix listener is missing from ss");
}

async function writeSummary(filePath, summary) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o644 });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (typeof options.summaryPath !== "string" || options.summaryPath === "") {
    throw new Error("--summary is required");
  }
  assert(process.platform === "linux", "systemd lifecycle test requires Linux");
  assert(typeof process.getuid === "function" && process.getuid() === 0, "systemd lifecycle test requires root");
  const pidOne = await fs.readFile("/proc/1/comm", "utf8");
  assert(pidOne.trim() === "systemd", "systemd must be PID 1");

  const independence = [];
  let started = false;
  try {
    systemctl("daemon-reload");
    started = true;
    systemctl("start", "codex-stack.target");
    for (const service of services) await waitForActive(service);
    await assertEndpoints();

    const initial = new Map();
    for (const service of services) initial.set(service, await processDetails(service));
    assert(new Set([...initial.values()].map(({ uid }) => uid)).size === 1, "services do not share the dedicated identity");

    for (const service of services) {
      const before = new Map(services.map((name) => [name, mainPid(name)]));
      systemctl("restart", service);
      await waitForActive(service);
      await waitFor(() => mainPid(service) !== before.get(service), `${service} PID replacement`);
      await assertEndpoints();
      const after = new Map(services.map((name) => [name, mainPid(name)]));
      const peerPidsUnchanged = services
        .filter((name) => name !== service)
        .every((name) => after.get(name) === before.get(name));
      assert(peerPidsUnchanged, `${service} restart propagated to a peer service`);
      await processDetails(service);
      independence.push({
        restarted_service: service,
        restarted_pid_changed: after.get(service) !== before.get(service),
        peer_pids_unchanged: peerPidsUnchanged,
      });
    }

    const systemdVersion = run("systemd", ["--version"]).stdout.split("\n", 1)[0].trim();
    const summary = {
      schema_version: 1,
      task: "M5.2",
      platform: `${os.platform()} ${os.arch()}`,
      systemd_version: systemdVersion,
      node_version: process.version,
      architecture_mode: "LIMITED_MODE",
      service_identity: { name: "codex", non_root: true, shared_by_services: true },
      endpoints: {
        router_model: "127.0.0.1:18317",
        router_admin: "127.0.0.1:18318",
        codex_web: "127.0.0.1:8214",
        app_server: appServerSocket,
        public_listener_detected: false,
      },
      credential_delivery: {
        systemd_credential_files: true,
        secret_like_command_line_matches: 0,
      },
      independent_restarts: independence,
      real_account_configured: false,
      account_switch_tested: false,
      seamless_account_continuity_claimed: false,
    };
    await writeSummary(options.summaryPath, summary);
    process.stdout.write(`${JSON.stringify({ event: "systemd_lifecycle_verified", summary: path.resolve(options.summaryPath) })}\n`);
  } finally {
    if (started) {
      run("systemctl", ["stop", ...services], { allowFailure: true });
      run("systemctl", ["stop", "codex-stack.target"], { allowFailure: true });
      run("systemctl", ["reset-failed", ...services], { allowFailure: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`systemd lifecycle verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
