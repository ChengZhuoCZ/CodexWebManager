#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createTextMessageAssembler,
  createWebSocketFrameParser,
  encodeWebSocketFrame,
} from "../src/websocket-frames.mjs";
import { readLinuxReleaseArchive } from "./build-linux-release.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseArguments(argumentsList) {
  const options = { architecture: process.arch };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--arch") {
      options.architecture = argumentsList[++index];
    } else if (argument === "--artifact") {
      options.artifactPath = argumentsList[++index];
    } else if (argument === "--summary") {
      options.summaryPath = argumentsList[++index];
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: node scripts/verify-linux-release.mjs --artifact FILE [options]

Options:
  --arch x64|arm64  Required Linux runner architecture (default: current Node architecture)
  --artifact FILE  Release .tar.gz to install and run
  --summary FILE   Write a sanitized JSON evidence summary
  --help           Show this help
`;
}

async function verifyArchive(artifactPath, architecture) {
  const packageDocument = JSON.parse(
    await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  const releaseName = `codex-account-router-${packageDocument.version}-linux-${architecture}`;
  assert(
    path.basename(artifactPath) === `${releaseName}.tar.gz`,
    "artifact name does not match the package version and target architecture",
  );
  const archive = await fs.readFile(artifactPath);
  const digest = sha256(archive);
  const checksumText = await fs.readFile(`${artifactPath}.sha256`, "utf8");
  assert(
    checksumText === `${digest}  ${path.basename(artifactPath)}\n`,
    "artifact checksum file does not match the archive",
  );

  const entries = readLinuxReleaseArchive(archive);
  assert(entries.length > 0, "release archive is empty");
  const entryPaths = new Set();
  for (const entry of entries) {
    assert(!entryPaths.has(entry.path), "release archive contains a duplicate path");
    entryPaths.add(entry.path);
    assert(!path.posix.isAbsolute(entry.path), "release archive contains an absolute path");
    assert(!entry.path.includes("\\"), "release archive contains a backslash path");
    assert(
      entry.path === releaseName || entry.path.startsWith(`${releaseName}/`),
      "release archive contains a path outside its release root",
    );
    assert(
      !entry.path.split("/").includes(".."),
      "release archive contains a parent-directory path",
    );
  }

  const files = new Map(
    entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]),
  );
  const manifestEntry = files.get(`${releaseName}/manifest.json`);
  assert(manifestEntry, "release manifest is missing");
  const manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  assert(manifest.target.os === "linux", "release target operating system is not Linux");
  assert(
    manifest.target.architecture === architecture,
    "release manifest architecture does not match the runner",
  );
  assert(manifest.runtime.electron_required === false, "release requires Electron");
  assert(manifest.runtime.display_server_required === false, "release requires a display server");
  assert(
    manifest.schemas?.accounts === 1 && manifest.schemas?.circuit_state === 1,
    "release schema compatibility is unsupported",
  );
  assert(
    Array.isArray(manifest.runtime.native_package_dependencies) &&
      manifest.runtime.native_package_dependencies.length === 0,
    "release declares native package dependencies",
  );

  const manifestPaths = new Set();
  for (const file of manifest.files) {
    assert(!manifestPaths.has(file.path), "release manifest contains a duplicate path");
    manifestPaths.add(file.path);
    const entry = files.get(`${releaseName}/${file.path}`);
    assert(entry, `manifest payload is missing: ${file.path}`);
    assert(entry.content.length === file.size, `manifest size mismatch: ${file.path}`);
    assert(sha256(entry.content) === file.sha256, `manifest digest mismatch: ${file.path}`);
    assert(
      entry.mode.toString(8).padStart(4, "0") === file.mode,
      `manifest mode mismatch: ${file.path}`,
    );
  }
  const payloadPaths = [...files.keys()]
    .filter((entryPath) => entryPath !== `${releaseName}/manifest.json`)
    .map((entryPath) => entryPath.slice(releaseName.length + 1));
  assert(
    payloadPaths.length === manifestPaths.size &&
      payloadPaths.every((entryPath) => manifestPaths.has(entryPath)),
    "release archive contains a file not covered by the manifest",
  );
  assert(
    ![...files.keys()].some((entryPath) =>
      /(^|\/)(node_modules|electron)(\/|$)/i.test(entryPath),
    ),
    "release contains a desktop or dependency payload",
  );
  return { archive, digest, entries, files, manifest, releaseName };
}

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function scrubbedRuntimeEnvironment(homeDirectory) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !name.startsWith("CODEX_ROUTER_") &&
      name !== "CREDENTIALS_DIRECTORY" &&
      !["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"].includes(name)
    ) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    HOME: homeDirectory,
    NODE_BINARY: process.execPath,
    CODEX_ROUTER_ADMIN_HOST: "127.0.0.1",
    CODEX_ROUTER_ADMIN_PORT: "0",
    CODEX_ROUTER_MODEL_HOST: "127.0.0.1",
    CODEX_ROUTER_MODEL_PORT: "0",
  };
}

async function waitForStart(child, timeoutMs = 15_000) {
  let pending = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("installed router start timed out"));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `installed router exited before start (code=${code}, signal=${signal}, stderr=${stderr.trim()})`,
        ),
      );
    };
    const onData = (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.event === "router_started") {
          cleanup();
          resolve({ record, getStderr: () => stderr });
          return;
        }
      }
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
    }
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  });
}

async function waitForExit(child, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("installed router stop timed out")), timeoutMs);
  });
  return Promise.race([once(child, "close"), timeout]).finally(() => clearTimeout(timer));
}

async function listenLoopback(server, timeoutMs = 5_000) {
  let timer;
  try {
    server.listen(0, "127.0.0.1");
    await Promise.race([
      once(server, "listening"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("synthetic upstream start timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const address = server.address();
  assert(
    address !== null &&
      typeof address === "object" &&
      address.address === "127.0.0.1" &&
      Number.isSafeInteger(address.port),
    "synthetic upstream did not bind to loopback",
  );
  return `http://127.0.0.1:${address.port}`;
}

async function closeLoopback(server, timeoutMs = 5_000) {
  if (!server.listening) return;
  let timer;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("synthetic upstream stop timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function readUntilSocket(socket, marker, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("synthetic WebSocket handshake timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      assert(
        buffer.length <= 64 * 1024,
        "synthetic WebSocket handshake exceeded its byte limit",
      );
      const index = buffer.indexOf(marker);
      if (index === -1) return;
      cleanup();
      resolve({
        before: buffer.subarray(0, index + marker.length),
        after: buffer.subarray(index + marker.length),
      });
    };
    const onError = () => {
      cleanup();
      reject(new Error("synthetic WebSocket handshake failed"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("synthetic WebSocket closed during its handshake"));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function collectWebSocketMessages(socket, initial = Buffer.alloc(0)) {
  const messages = [];
  const events = new EventEmitter();
  const assemble = createTextMessageAssembler({
    onMessage(payload) {
      const message = JSON.parse(payload.toString("utf8"));
      messages.push(message);
      events.emit("message", message);
    },
  });
  const parser = createWebSocketFrameParser({
    expectMasked: false,
    onFrame(frame) {
      assemble(frame);
    },
  });
  socket.on("data", (chunk) => {
    try {
      parser.push(chunk);
    } catch {
      events.emit("failure");
    }
  });
  if (initial.length > 0) parser.push(initial);
  return {
    messages,
    waitFor(predicate, timeoutMs = 5_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          events.off("message", onMessage);
          events.off("failure", onFailure);
        };
        const onMessage = (message) => {
          if (!predicate(message)) return;
          cleanup();
          resolve(message);
        };
        const onFailure = () => {
          cleanup();
          reject(new Error("synthetic WebSocket response was malformed"));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("synthetic WebSocket response timed out"));
        }, timeoutMs);
        events.on("message", onMessage);
        events.on("failure", onFailure);
      });
    },
  };
}

async function openSyntheticWebSocket({ port }) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  try {
    await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
    const key = randomBytes(16).toString("base64");
    socket.write(
      "GET /backend-api/codex/responses HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    const handshake = await readUntilSocket(
      socket,
      Buffer.from("\r\n\r\n"),
    );
    const headerText = handshake.before.toString("latin1");
    assert(
      /^HTTP\/1\.1 101/.test(headerText) &&
        headerText.toLowerCase().includes(
          `sec-websocket-accept: ${websocketAccept(key)}`.toLowerCase(),
        ),
      "installed router synthetic WebSocket upgrade was invalid",
    );
    return {
      collector: collectWebSocketMessages(socket, handshake.after),
      socket,
      status: 101,
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function sendSyntheticWebSocketCreate(socket) {
  socket.write(encodeWebSocketFrame(
    JSON.stringify({
      type: "response.create",
      input: ["installed-release-websocket-fixture"],
    }),
    { masked: true, opcode: 0x1 },
  ));
}

async function waitForSyntheticStatus({
  adminOrigin,
  adminToken,
  predicate,
  timeoutMs = 2_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const response = await fetch(`${adminOrigin}/v1/status`, {
      headers: { authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(500, remainingMs))),
    });
    assert(response.status === 200, "synthetic admin status request failed");
    lastStatus = await response.json();
    if (predicate(lastStatus)) return lastStatus;
    if (attempt < 39) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
  throw new Error(
    lastStatus === null
      ? "synthetic admin status was unavailable"
      : "synthetic admin status condition timed out",
  );
}

async function waitForFixtureEvent(child, {
  event,
  label,
  timeoutMs = 5_000,
}) {
  let pending = "";
  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const stalled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`installed router ${label} timed out`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `installed router exited before the ${label} (code=${code}, signal=${signal})`,
        ),
      );
    };
    const onData = (chunk) => {
      stdout += chunk;
      if (settled) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.event === event) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
      }
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("exit", onExit);
    }
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  });

  await stalled;
  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function collectNames(directory, prefix = "") {
  const names = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    names.push(relativePath);
    if (entry.isDirectory()) {
      names.push(...(await collectNames(path.join(directory, entry.name), relativePath)));
    }
  }
  return names;
}

async function verifyInstalledRuntime({ artifactPath, architecture, release }) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "router-linux-release-"));
  await fs.chmod(temporaryRoot, 0o700);
  let child;
  let fixtureServer;
  let fixtureWebSocketSockets;
  let websocketClient;
  try {
    const extractionDirectory = path.join(temporaryRoot, "extract");
    const prefix = path.join(temporaryRoot, "install");
    const homeDirectory = path.join(temporaryRoot, "home");
    await fs.mkdir(extractionDirectory, { mode: 0o700 });
    await fs.mkdir(homeDirectory, { mode: 0o700 });
    run("tar", ["-xzf", artifactPath, "-C", extractionDirectory]);

    const extractedRoot = path.join(extractionDirectory, release.releaseName);
    const environment = {
      ...scrubbedRuntimeEnvironment(homeDirectory),
      PREFIX: prefix,
    };
    const previousRelease = path.join(prefix, "releases", "fixture-previous");
    await fs.mkdir(previousRelease, { recursive: true, mode: 0o755 });
    await fs.symlink("releases/fixture-previous", path.join(prefix, "current"));
    run("sh", [path.join(extractedRoot, "install.sh")], {
      cwd: extractedRoot,
      env: environment,
    });

    const current = path.join(prefix, "current");
    const installedRoot = await fs.realpath(current);
    assert(
      path.basename(installedRoot) === release.releaseName,
      "current symlink does not select the installed release",
    );
    assert(
      (await fs.readdir(previousRelease)).length === 0,
      "installer moved its temporary current link into the previous release",
    );
    const installedNames = await collectNames(installedRoot);
    assert(
      !installedNames.some((entryPath) => /(^|\/)(node_modules|electron)(\/|$)/i.test(entryPath)),
      "installed release contains a desktop or dependency payload",
    );

    child = spawn(path.join(current, "bin/codex-account-router"), [], {
      cwd: current,
      env: scrubbedRuntimeEnvironment(homeDirectory),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = await waitForStart(child);
    assert(started.record.bind_address === "127.0.0.1", "admin listener is not on loopback");
    assert(
      started.record.model_bind_address === "127.0.0.1",
      "model listener is not on loopback",
    );
    assert(
      started.record.architecture_mode === "LIMITED_MODE",
      "runtime architecture mode is not LIMITED_MODE",
    );

    const origin = `http://127.0.0.1:${started.record.bind_port}`;
    const healthResponse = await fetch(`${origin}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    const readinessResponse = await fetch(`${origin}/readyz`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert(healthResponse.status === 200, "installed router health check failed");
    assert(readinessResponse.status === 503, "empty router must report non-readiness");
    const readiness = await readinessResponse.json();
    assert(readiness.reason === "no_accounts", "empty router readiness reason is not no_accounts");

    child.kill("SIGTERM");
    const [exitCode, signal] = await waitForExit(child);
    child = undefined;
    assert(exitCode === 0 && signal === null, "installed router did not exit cleanly on SIGTERM");
    assert(started.getStderr() === "", "installed router wrote an error log");

    const startupInterruptions = [];
    for (const stopSignal of ["SIGTERM", "SIGINT"]) {
      const stalledAccountsPath = path.join(
        temporaryRoot,
        `synthetic-stalled-accounts-${stopSignal.toLowerCase()}.json`,
      );
      child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(
            path.join(PACKAGE_ROOT, "fixtures/startup/stall-runtime-load.mjs"),
          ).href,
          path.join(installedRoot, "lib/account-router/src/main.mjs"),
        ],
        {
          cwd: current,
          env: {
            ...scrubbedRuntimeEnvironment(homeDirectory),
            CODEX_ROUTER_ACCOUNTS_FILE: stalledAccountsPath,
            CODEX_ROUTER_CREDENTIAL_ROOT: path.join(temporaryRoot, "synthetic-credentials"),
            CODEX_ROUTER_TEST_STALLED_ACCOUNTS_FILE: stalledAccountsPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stalled = await waitForFixtureEvent(child, {
        event: "fixture_runtime_load_stalled",
        label: "runtime-load stall fixture",
      });
      child.kill(stopSignal);
      const [startupExitCode, startupExitSignal] = await waitForExit(child);
      child = undefined;
      const stalledStdout = stalled.getStdout();
      const stalledStderr = stalled.getStderr();
      const startupInterruption = {
        signal: stopSignal,
        stalled_before_runtime_creation: true,
        exit_code: startupExitCode,
        exit_signal: startupExitSignal,
        router_stopping_emitted: stalledStdout.includes('"event":"router_stopping"'),
        router_started_emitted: stalledStdout.includes('"event":"router_started"'),
        router_start_failed_emitted: stalledStderr.includes('"event":"router_start_failed"'),
        stderr_bytes: Buffer.byteLength(stalledStderr),
      };
      assert(
        startupInterruption.exit_code === 0 &&
          startupInterruption.exit_signal === null &&
          startupInterruption.router_stopping_emitted === true &&
          startupInterruption.router_started_emitted === false &&
          startupInterruption.router_start_failed_emitted === false &&
          startupInterruption.stderr_bytes === 0,
        `installed router did not stop cleanly during stalled startup on ${stopSignal}`,
      );
      startupInterruptions.push(startupInterruption);
    }

    const listenerStartInterruptions = [];
    for (const stopSignal of ["SIGTERM", "SIGINT"]) {
      child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(
            path.join(PACKAGE_ROOT, "fixtures/startup/stall-listener-start.mjs"),
          ).href,
          path.join(installedRoot, "lib/account-router/src/main.mjs"),
        ],
        {
          cwd: current,
          env: {
            ...scrubbedRuntimeEnvironment(homeDirectory),
            CODEX_ROUTER_TEST_STALL_LISTENER_START: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const listenerStalled = await waitForFixtureEvent(child, {
        event: "fixture_listener_start_stalled",
        label: "listener-start stall fixture",
      });
      child.kill(stopSignal);
      const [listenerExitCode, listenerExitSignal] = await waitForExit(child);
      child = undefined;
      const listenerStdout = listenerStalled.getStdout();
      const listenerStderr = listenerStalled.getStderr();
      const listenerStartInterruption = {
        signal: stopSignal,
        stalled_during_listener_start: true,
        runtime_created_before_stall: true,
        exit_code: listenerExitCode,
        exit_signal: listenerExitSignal,
        router_stopping_emitted: listenerStdout.includes('"event":"router_stopping"'),
        router_started_emitted: listenerStdout.includes('"event":"router_started"'),
        router_start_failed_emitted: listenerStderr.includes('"event":"router_start_failed"'),
        stderr_bytes: Buffer.byteLength(listenerStderr),
      };
      assert(
        listenerStartInterruption.exit_code === 0 &&
          listenerStartInterruption.exit_signal === null &&
          listenerStartInterruption.router_stopping_emitted === true &&
          listenerStartInterruption.router_started_emitted === false &&
          listenerStartInterruption.router_start_failed_emitted === false &&
          listenerStartInterruption.stderr_bytes === 0,
        `installed router did not stop cleanly during stalled listener start on ${stopSignal}`,
      );
      listenerStartInterruptions.push(listenerStartInterruption);
    }

    const syntheticBindingRoot = path.join(temporaryRoot, "synthetic-bindings");
    const syntheticStateDirectory = path.join(temporaryRoot, "synthetic-state");
    const syntheticAccountsFile = path.join(syntheticBindingRoot, "accounts.json");
    await fs.mkdir(syntheticBindingRoot, { mode: 0o700 });
    await fs.mkdir(syntheticStateDirectory, { mode: 0o700 });
    const syntheticBindings = [
      {
        id: "fixture-account-a",
        alias: "Fixture Account A",
        enabled: true,
        priority: 10,
        max_concurrency: 1,
        provider: "openai-codex",
        secret_provider: "codex-auth",
        credential_ref: "fixture-a.json",
      },
      {
        id: "fixture-account-b",
        alias: "Fixture Account B",
        enabled: true,
        priority: 0,
        max_concurrency: 1,
        provider: "openai-codex",
        secret_provider: "codex-auth",
        credential_ref: "fixture-b.json",
      },
    ];
    await fs.writeFile(
      syntheticAccountsFile,
      `${JSON.stringify({ version: 1, accounts: syntheticBindings })}\n`,
      { mode: 0o600 },
    );
    for (const binding of syntheticBindings) {
      await fs.writeFile(
        path.join(syntheticBindingRoot, binding.credential_ref),
        "{}\n",
        { mode: 0o600 },
      );
    }

    const syntheticReadinessStatuses = [];
    const syntheticUsableAccounts = [];
    const syntheticExitCodes = [];
    let stateCheckpointFilesAfterFirstStop = 0;
    for (let processStart = 0; processStart < 2; processStart += 1) {
      child = spawn(path.join(current, "bin/codex-account-router"), [], {
        cwd: current,
        env: {
          ...scrubbedRuntimeEnvironment(homeDirectory),
          CODEX_ROUTER_ACCOUNTS_FILE: syntheticAccountsFile,
          CODEX_ROUTER_CREDENTIAL_ROOT: syntheticBindingRoot,
          CODEX_ROUTER_STATE_DIRECTORY: syntheticStateDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const syntheticStarted = await waitForStart(child);
      const syntheticOrigin =
        `http://127.0.0.1:${syntheticStarted.record.bind_port}`;
      const syntheticReadyResponse = await fetch(`${syntheticOrigin}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      const syntheticReadiness = await syntheticReadyResponse.json();
      assert(
        syntheticReadyResponse.status === 200 &&
          syntheticReadiness.status === "ready" &&
          syntheticReadiness.usable_accounts === 2,
        "installed router did not retain two synthetic bindings across restart",
      );
      syntheticReadinessStatuses.push(syntheticReadyResponse.status);
      syntheticUsableAccounts.push(syntheticReadiness.usable_accounts);
      child.kill("SIGTERM");
      const [syntheticExitCode, syntheticExitSignal] = await waitForExit(child);
      child = undefined;
      assert(
        syntheticExitCode === 0 && syntheticExitSignal === null,
        "installed router with synthetic bindings did not exit cleanly",
      );
      assert(
        syntheticStarted.getStderr() === "",
        "installed router with synthetic bindings wrote an error log",
      );
      syntheticExitCodes.push(syntheticExitCode);
      if (processStart === 0) {
        const checkpointFiles = (await fs.readdir(syntheticStateDirectory))
          .filter((name) => name === "circuit-state.json" || name === "routing-state.json");
        assert(
          checkpointFiles.length === 2,
          "installed router did not persist both restart checkpoints",
        );
        stateCheckpointFilesAfterFirstStop = checkpointFiles.length;
      }
    }
    const syntheticTwoBindingRestart = {
      configured_bindings: syntheticBindings.length,
      process_starts: 2,
      restart_count: 1,
      state_checkpoint_files_after_first_stop: stateCheckpointFilesAfterFirstStop,
      readiness_statuses: syntheticReadinessStatuses,
      usable_accounts: syntheticUsableAccounts,
      sigterm_exit_codes: syntheticExitCodes,
      synthetic_credential_acquisition_tested: false,
      real_credentials_present: false,
      model_request_sent: false,
      account_switch_tested: false,
    };

    const syntheticAdminToken = randomBytes(32).toString("base64url");
    const syntheticAdminTokenFile = path.join(
      syntheticBindingRoot,
      "synthetic-admin-token",
    );
    await fs.writeFile(syntheticAdminTokenFile, syntheticAdminToken, {
      mode: 0o600,
    });
    const syntheticUpstreamAccounts = syntheticBindings.map((binding, index) => ({
      binding,
      role: index === 0 ? "primary" : "secondary",
      upstreamAccountId: `fixture-upstream-${randomUUID()}`,
      accessToken: randomBytes(32).toString("base64url"),
    }));
    for (const fixture of syntheticUpstreamAccounts) {
      await fs.writeFile(
        path.join(syntheticBindingRoot, fixture.binding.credential_ref),
        `${JSON.stringify({
          tokens: {
            access_token: fixture.accessToken,
            account_id: fixture.upstreamAccountId,
          },
        })}\n`,
        { mode: 0o600 },
      );
    }

    const expectedAuthorizationByAccount = new Map(
      syntheticUpstreamAccounts.map(({ accessToken, upstreamAccountId }) => [
        upstreamAccountId,
        `Bearer ${accessToken}`,
      ]),
    );
    const roleByUpstreamAccount = new Map(
      syntheticUpstreamAccounts.map(({ role, upstreamAccountId }) => [
        upstreamAccountId,
        role,
      ]),
    );
    const syntheticUpstreamRoleSequence = [];
    const syntheticHttpSseRoleSequences = {
      pre_semantic: [],
      post_semantic: [],
    };
    const syntheticWebSocketRoleSequences = {
      pre_semantic: [],
      post_semantic: [],
      manual_switch_active: [],
    };
    const syntheticManualSwitchHttpRoleSequences = {
      safe_boundary: [],
      restart: [],
    };
    let syntheticFixtureScenario = "weekly_quota_restart";
    const syntheticResetAtSeconds = Math.ceil(
      (Date.now() + 60 * 60_000) / 1_000,
    );
    const syntheticResetAt = new Date(
      syntheticResetAtSeconds * 1_000,
    ).toISOString();
    let fixtureUpstreamFailure = null;
    let completeManualSwitchWebSocket = null;
    fixtureServer = http.createServer((request, response) => {
      request.resume();
      const upstreamAccountId = request.headers["chatgpt-account-id"];
      const role = roleByUpstreamAccount.get(upstreamAccountId);
      const expectedAuthorization =
        expectedAuthorizationByAccount.get(upstreamAccountId);
      if (
        request.method !== "POST" ||
        request.url !== "/v1/responses" ||
        role === undefined ||
        request.headers.authorization !== expectedAuthorization
      ) {
        fixtureUpstreamFailure =
          "installed router supplied an invalid synthetic upstream request";
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":{"type":"invalid_auth"}}');
        return;
      }
      if (syntheticFixtureScenario === "pre_semantic_failover") {
        syntheticHttpSseRoleSequences.pre_semantic.push(role);
        if (role === "primary") {
          response.writeHead(429, {
            "content-type": "application/json",
          });
          response.end('{"error":{"type":"quota_exhausted"}}');
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
        );
        response.write(
          "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"installed-pre-semantic-secondary\"}\n\n",
        );
        response.end(
          "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
        );
        return;
      }
      if (syntheticFixtureScenario === "post_semantic_failure") {
        syntheticHttpSseRoleSequences.post_semantic.push(role);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
        );
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: role === "primary"
              ? "installed-post-semantic-primary"
              : "must-not-contact-secondary",
          })}\n\n`,
        );
        if (role === "primary") {
          setImmediate(() => response.destroy());
        } else {
          response.end(
            "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
          );
        }
        return;
      }
      if (
        syntheticFixtureScenario === "manual_switch_next_request" ||
        syntheticFixtureScenario === "manual_switch_restart_request"
      ) {
        const sequence = syntheticFixtureScenario === "manual_switch_next_request"
          ? syntheticManualSwitchHttpRoleSequences.safe_boundary
          : syntheticManualSwitchHttpRoleSequences.restart;
        sequence.push(role);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
        );
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "installed-manual-switch-secondary",
          })}\n\n`,
        );
        response.end(
          "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
        );
        return;
      }
      syntheticUpstreamRoleSequence.push(role);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: codex.rate_limits\ndata: ${JSON.stringify({
          type: "codex.rate_limits",
          rate_limits: {
            secondary: {
              used_percent: role === "primary" ? 100 : 25,
              window_minutes: 10_080,
              reset_at: syntheticResetAtSeconds,
            },
          },
        })}\n\n`,
      );
      response.end(
        "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
      );
    });
    fixtureWebSocketSockets = new Set();
    fixtureServer.on("upgrade", (request, socket, head) => {
      fixtureWebSocketSockets.add(socket);
      socket.once("close", () => fixtureWebSocketSockets.delete(socket));
      socket.on("error", () => undefined);
      const upstreamAccountId = request.headers["chatgpt-account-id"];
      const role = roleByUpstreamAccount.get(upstreamAccountId);
      const expectedAuthorization =
        expectedAuthorizationByAccount.get(upstreamAccountId);
      const websocketScenario = new Set([
        "websocket_pre_semantic_failover",
        "websocket_post_semantic_failure",
        "manual_switch_active_stream",
      ]).has(syntheticFixtureScenario);
      const key = request.headers["sec-websocket-key"];
      if (
        !websocketScenario ||
        request.method !== "GET" ||
        request.url !== "/backend-api/codex/responses" ||
        role === undefined ||
        request.headers.authorization !== expectedAuthorization ||
        typeof key !== "string"
      ) {
        fixtureUpstreamFailure =
          "installed router supplied an invalid synthetic WebSocket upstream request";
        socket.end(
          "HTTP/1.1 401 Unauthorized\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n\r\n",
        );
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
      );
      const sendEvent = (message) => {
        socket.write(encodeWebSocketFrame(
          JSON.stringify(message),
          { opcode: 0x1 },
        ));
      };
      let handled = false;
      const assemble = createTextMessageAssembler({
        onMessage(payload) {
          if (handled) {
            fixtureUpstreamFailure =
              "installed router sent duplicate synthetic WebSocket requests";
            socket.destroy();
            return;
          }
          handled = true;
          let message;
          try {
            message = JSON.parse(payload.toString("utf8"));
          } catch {
            fixtureUpstreamFailure =
              "installed router sent malformed synthetic WebSocket JSON";
            socket.destroy();
            return;
          }
          if (message?.type !== "response.create") {
            fixtureUpstreamFailure =
              "installed router sent an unexpected synthetic WebSocket message";
            socket.destroy();
            return;
          }
          if (
            syntheticFixtureScenario ===
              "websocket_pre_semantic_failover"
          ) {
            syntheticWebSocketRoleSequences.pre_semantic.push(role);
            sendEvent({ type: "response.created" });
            if (role === "primary") {
              sendEvent({
                type: "error",
                error: { type: "quota_exhausted" },
              });
            } else {
              sendEvent({
                type: "response.output_text.delta",
                delta: "installed-websocket-pre-semantic-secondary",
              });
              sendEvent({ type: "response.completed" });
            }
            return;
          }
          if (syntheticFixtureScenario === "manual_switch_active_stream") {
            syntheticWebSocketRoleSequences.manual_switch_active.push(role);
            sendEvent({ type: "response.created" });
            sendEvent({
              type: "response.output_text.delta",
              delta: "installed-manual-switch-active-primary",
            });
            if (completeManualSwitchWebSocket !== null) {
              fixtureUpstreamFailure =
                "installed router opened duplicate manual-switch fixture streams";
              socket.destroy();
              return;
            }
            completeManualSwitchWebSocket = () => {
              completeManualSwitchWebSocket = null;
              sendEvent({ type: "response.completed" });
            };
            return;
          }
          syntheticWebSocketRoleSequences.post_semantic.push(role);
          sendEvent({ type: "response.created" });
          sendEvent({
            type: "response.output_text.delta",
            delta: role === "primary"
              ? "installed-websocket-post-semantic-primary"
              : "must-not-contact-websocket-secondary",
          });
          if (role === "primary") {
            setImmediate(() => socket.destroy());
          } else {
            sendEvent({ type: "response.completed" });
          }
        },
      });
      const parser = createWebSocketFrameParser({
        expectMasked: true,
        onFrame(frame) {
          assemble(frame);
        },
      });
      socket.on("data", (chunk) => {
        try {
          parser.push(chunk);
        } catch {
          fixtureUpstreamFailure =
            "installed router sent malformed synthetic WebSocket frames";
          socket.destroy();
        }
      });
      if (head.length > 0) {
        try {
          parser.push(head);
        } catch {
          fixtureUpstreamFailure =
            "installed router sent a malformed synthetic WebSocket head";
          socket.destroy();
        }
      }
    });
    const syntheticUpstreamOrigin = await listenLoopback(fixtureServer);
    const weeklyReadinessStatuses = [];
    const weeklyUsableAccounts = [];
    const syntheticModelResponseStatuses = [];
    const currentRouteContinuity = [];
    let completedSseResponses = 0;
    let firstCooldownUntil = null;
    let weeklyZeroPersisted = false;
    let weeklyResetPersisted = false;
    let cooldownPersisted = false;

    for (let processStart = 0; processStart < 2; processStart += 1) {
      child = spawn(path.join(current, "bin/codex-account-router"), [], {
        cwd: current,
        env: {
          ...scrubbedRuntimeEnvironment(homeDirectory),
          CODEX_ROUTER_ACCOUNTS_FILE: syntheticAccountsFile,
          CODEX_ROUTER_CREDENTIAL_ROOT: syntheticBindingRoot,
          CODEX_ROUTER_ADMIN_TOKEN_FILE: syntheticAdminTokenFile,
          CODEX_ROUTER_STATE_DIRECTORY: syntheticStateDirectory,
          CODEX_ROUTER_UPSTREAM_ORIGIN: syntheticUpstreamOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const syntheticStarted = await waitForStart(child);
      const adminOrigin =
        `http://127.0.0.1:${syntheticStarted.record.bind_port}`;
      const modelOrigin =
        `http://127.0.0.1:${syntheticStarted.record.model_bind_port}`;
      const readyResponse = await fetch(`${adminOrigin}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      const readiness = await readyResponse.json();
      const expectedUsableAccounts = processStart === 0 ? 2 : 1;
      assert(
        readyResponse.status === 200 &&
          readiness.status === "ready" &&
          readiness.usable_accounts === expectedUsableAccounts,
        "installed router weekly restart readiness was invalid",
      );
      weeklyReadinessStatuses.push(readyResponse.status);
      weeklyUsableAccounts.push(readiness.usable_accounts);

      if (processStart === 1) {
        const restartedStatus = await waitForSyntheticStatus({
          adminOrigin,
          adminToken: syntheticAdminToken,
          predicate(status) {
            const primary = status.accounts?.find(
              ({ alias }) => alias === syntheticBindings[0].alias,
            );
            return (
              primary?.state === "quota_exhausted" &&
              primary.weekly_remaining_ratio === 0 &&
              primary.cooldown_until === firstCooldownUntil &&
              status.current_route?.account_alias ===
                syntheticBindings[0].alias &&
              status.current_route?.continuity === "new_backend_session"
            );
          },
        });
        const restartedPrimary = restartedStatus.accounts.find(
          ({ alias }) => alias === syntheticBindings[0].alias,
        );
        cooldownPersisted =
          firstCooldownUntil !== null &&
          restartedPrimary.cooldown_until === firstCooldownUntil;
      }

      const modelResponse = await fetch(`${modelOrigin}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"input":"installed-release-local-fixture"}',
        signal: AbortSignal.timeout(5_000),
      });
      const modelBody = await modelResponse.text();
      assert(
        modelResponse.status === 200 &&
          modelBody.includes("event: response.completed"),
        "installed router synthetic model response did not complete",
      );
      syntheticModelResponseStatuses.push(modelResponse.status);
      completedSseResponses += 1;

      const selectedBinding = syntheticBindings[processStart];
      const selectedRatio = processStart === 0 ? 0 : 0.75;
      const selectedStatus = await waitForSyntheticStatus({
        adminOrigin,
        adminToken: syntheticAdminToken,
        predicate(status) {
          const selected = status.accounts?.find(
            ({ alias }) => alias === selectedBinding.alias,
          );
          return (
            selected?.weekly_remaining_ratio === selectedRatio &&
            status.current_route?.account_alias === selectedBinding.alias &&
            status.current_route?.continuity === "new_backend_session"
          );
        },
      });
      currentRouteContinuity.push(selectedStatus.current_route.continuity);
      if (processStart === 0) {
        const primary = selectedStatus.accounts.find(
          ({ alias }) => alias === syntheticBindings[0].alias,
        );
        assert(
          primary.state === "quota_exhausted" &&
            typeof primary.cooldown_until === "string",
          "installed router did not mark synthetic weekly exhaustion",
        );
        firstCooldownUntil = primary.cooldown_until;
      }

      child.kill("SIGTERM");
      const [weeklyExitCode, weeklyExitSignal] = await waitForExit(child);
      child = undefined;
      assert(
        weeklyExitCode === 0 && weeklyExitSignal === null,
        "installed router weekly restart process did not exit cleanly",
      );
      assert(
        syntheticStarted.getStderr() === "",
        "installed router weekly restart process wrote an error log",
      );

      if (processStart === 0) {
        const checkpoint = JSON.parse(
          await fs.readFile(
            path.join(syntheticStateDirectory, "circuit-state.json"),
            "utf8",
          ),
        );
        const weeklyEntry = checkpoint.weekly_quota?.find(
          ({ account_id: accountId }) =>
            accountId === syntheticBindings[0].id,
        );
        const circuitEntry = checkpoint.accounts?.find(
          ({ account_id: accountId }) =>
            accountId === syntheticBindings[0].id,
        );
        weeklyZeroPersisted =
          weeklyEntry?.remaining_ratio === 0 &&
          circuitEntry?.last_failure_kind === "quota_exhausted";
        weeklyResetPersisted = weeklyEntry?.resets_at === syntheticResetAt;
        assert(
          weeklyZeroPersisted && weeklyResetPersisted,
          "installed router did not persist synthetic weekly state",
        );
      }
    }

    assert(
      fixtureUpstreamFailure === null,
      fixtureUpstreamFailure ??
        "installed router synthetic upstream verification failed",
    );
    assert(
      JSON.stringify(syntheticUpstreamRoleSequence) ===
        JSON.stringify(["primary", "secondary"]),
      "installed router did not route the next new request after restart",
    );
    assert(
      cooldownPersisted,
      "installed router did not retain the synthetic cooldown after restart",
    );
    const syntheticWeeklyQuotaRestart = {
      configured_bindings: syntheticBindings.length,
      process_starts: 2,
      restart_count: 1,
      readiness_statuses: weeklyReadinessStatuses,
      usable_accounts: weeklyUsableAccounts,
      synthetic_model_response_statuses: syntheticModelResponseStatuses,
      completed_sse_responses: completedSseResponses,
      synthetic_upstream_role_sequence: syntheticUpstreamRoleSequence,
      weekly_zero_persisted: weeklyZeroPersisted,
      weekly_reset_persisted: weeklyResetPersisted,
      cooldown_persisted: cooldownPersisted,
      next_new_request_route_changed: true,
      current_route_continuity: currentRouteContinuity,
      synthetic_credential_acquisition_tested: true,
      local_fixture_upstream_only: true,
      synthetic_model_requests_sent: syntheticModelResponseStatuses.length,
      manual_switch_tested: false,
      real_credentials_present: false,
      real_model_request_sent: false,
      real_account_switch_tested: false,
      in_flight_resume_tested: false,
    };

    const httpSseReadinessStatuses = [];
    const httpSseResponses = new Map();
    for (const scenario of [
      "pre_semantic_failover",
      "post_semantic_failure",
    ]) {
      syntheticFixtureScenario = scenario;
      const scenarioStateDirectory = path.join(
        temporaryRoot,
        `synthetic-${scenario}-state`,
      );
      await fs.mkdir(scenarioStateDirectory, { mode: 0o700 });
      child = spawn(path.join(current, "bin/codex-account-router"), [], {
        cwd: current,
        env: {
          ...scrubbedRuntimeEnvironment(homeDirectory),
          CODEX_ROUTER_ACCOUNTS_FILE: syntheticAccountsFile,
          CODEX_ROUTER_CREDENTIAL_ROOT: syntheticBindingRoot,
          CODEX_ROUTER_ADMIN_TOKEN_FILE: syntheticAdminTokenFile,
          CODEX_ROUTER_STATE_DIRECTORY: scenarioStateDirectory,
          CODEX_ROUTER_UPSTREAM_ORIGIN: syntheticUpstreamOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const scenarioStarted = await waitForStart(child);
      const adminOrigin =
        `http://127.0.0.1:${scenarioStarted.record.bind_port}`;
      const modelOrigin =
        `http://127.0.0.1:${scenarioStarted.record.model_bind_port}`;
      const readyResponse = await fetch(`${adminOrigin}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      const readiness = await readyResponse.json();
      assert(
        readyResponse.status === 200 &&
          readiness.status === "ready" &&
          readiness.usable_accounts === 2,
        `installed router ${scenario} readiness was invalid`,
      );
      httpSseReadinessStatuses.push(readyResponse.status);

      const modelResponse = await fetch(`${modelOrigin}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"input":"installed-release-http-sse-fixture"}',
        signal: AbortSignal.timeout(5_000),
      });
      const modelBody = await modelResponse.text();
      httpSseResponses.set(scenario, {
        status: modelResponse.status,
        body: modelBody,
      });

      child.kill("SIGTERM");
      const [scenarioExitCode, scenarioExitSignal] = await waitForExit(child);
      child = undefined;
      assert(
        scenarioExitCode === 0 && scenarioExitSignal === null,
        `installed router ${scenario} process did not exit cleanly`,
      );
      assert(
        scenarioStarted.getStderr() === "",
        `installed router ${scenario} process wrote an error log`,
      );
    }

    const preSemanticResponse = httpSseResponses.get(
      "pre_semantic_failover",
    );
    assert(
      preSemanticResponse.status === 200 &&
        preSemanticResponse.body.includes(
          "installed-pre-semantic-secondary",
        ) &&
        preSemanticResponse.body.includes("event: response.completed"),
      "installed router did not recover the pre-semantic fixture request",
    );
    assert(
      JSON.stringify(syntheticHttpSseRoleSequences.pre_semantic) ===
        JSON.stringify(["primary", "secondary"]),
      "installed router pre-semantic retry was not bounded to primary then secondary",
    );

    const postSemanticResponse = httpSseResponses.get(
      "post_semantic_failure",
    );
    const inStreamErrorMatch = postSemanticResponse.body.match(
      /event: error\ndata: ([^\n]+)\n\n/,
    );
    const inStreamErrorBody = inStreamErrorMatch === null
      ? null
      : JSON.parse(inStreamErrorMatch[1]);
    assert(
      postSemanticResponse.status === 200 &&
        postSemanticResponse.body.includes(
          "installed-post-semantic-primary",
        ) &&
        inStreamErrorBody?.error?.type === "unsafe_to_replay" &&
        inStreamErrorBody.error.semantic_output === true,
      "installed router did not expose the post-semantic unsafe-to-replay error",
    );
    assert(
      JSON.stringify(syntheticHttpSseRoleSequences.post_semantic) ===
        JSON.stringify(["primary"]),
      "installed router contacted a secondary after semantic output",
    );
    assert(
      fixtureUpstreamFailure === null,
      fixtureUpstreamFailure ??
        "installed router synthetic HTTP/SSE verification failed",
    );
    const syntheticHttpSseSafetyBoundaries = {
      scenarios: 2,
      process_starts: 2,
      readiness_statuses: httpSseReadinessStatuses,
      initial_requests: 2,
      pre_semantic: {
        downstream_status: preSemanticResponse.status,
        failure_kind: "quota_exhausted",
        upstream_role_sequence:
          syntheticHttpSseRoleSequences.pre_semantic,
        upstream_attempts:
          syntheticHttpSseRoleSequences.pre_semantic.length,
        secondary_semantic_marker_received: true,
        retry_bound_observed: true,
      },
      post_semantic: {
        downstream_status: postSemanticResponse.status,
        upstream_role_sequence:
          syntheticHttpSseRoleSequences.post_semantic,
        upstream_attempts:
          syntheticHttpSseRoleSequences.post_semantic.length,
        primary_semantic_marker_received: true,
        unsafe_to_replay_exposed: true,
        semantic_output: true,
        secondary_contacted: false,
      },
      local_fixture_upstream_only: true,
      synthetic_credential_acquisition_tested: true,
      synthetic_model_requests_sent: httpSseResponses.size,
      synthetic_upstream_attempts:
        syntheticHttpSseRoleSequences.pre_semantic.length +
        syntheticHttpSseRoleSequences.post_semantic.length,
      manual_switch_tested: false,
      real_credentials_present: false,
      real_model_request_sent: false,
      real_account_switch_tested: false,
      in_flight_resume_tested: false,
    };

    const websocketReadinessStatuses = [];
    const downstreamUpgradeStatuses = [];
    const websocketResponses = new Map();
    for (const scenario of [
      "websocket_pre_semantic_failover",
      "websocket_post_semantic_failure",
    ]) {
      syntheticFixtureScenario = scenario;
      const scenarioStateDirectory = path.join(
        temporaryRoot,
        `synthetic-${scenario}-state`,
      );
      await fs.mkdir(scenarioStateDirectory, { mode: 0o700 });
      child = spawn(path.join(current, "bin/codex-account-router"), [], {
        cwd: current,
        env: {
          ...scrubbedRuntimeEnvironment(homeDirectory),
          CODEX_ROUTER_ACCOUNTS_FILE: syntheticAccountsFile,
          CODEX_ROUTER_CREDENTIAL_ROOT: syntheticBindingRoot,
          CODEX_ROUTER_ADMIN_TOKEN_FILE: syntheticAdminTokenFile,
          CODEX_ROUTER_STATE_DIRECTORY: scenarioStateDirectory,
          CODEX_ROUTER_UPSTREAM_ORIGIN: syntheticUpstreamOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const scenarioStarted = await waitForStart(child);
      const adminOrigin =
        `http://127.0.0.1:${scenarioStarted.record.bind_port}`;
      const readyResponse = await fetch(`${adminOrigin}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      const readiness = await readyResponse.json();
      assert(
        readyResponse.status === 200 &&
          readiness.status === "ready" &&
          readiness.usable_accounts === 2,
        `installed router ${scenario} readiness was invalid`,
      );
      websocketReadinessStatuses.push(readyResponse.status);

      websocketClient = await openSyntheticWebSocket({
        port: scenarioStarted.record.model_bind_port,
      });
      downstreamUpgradeStatuses.push(websocketClient.status);
      sendSyntheticWebSocketCreate(websocketClient.socket);
      if (scenario === "websocket_pre_semantic_failover") {
        await websocketClient.collector.waitFor(
          (message) => message.type === "response.completed",
        );
      } else {
        await websocketClient.collector.waitFor(
          (message) => message.type === "error",
        );
      }
      websocketResponses.set(
        scenario,
        [...websocketClient.collector.messages],
      );
      websocketClient.socket.destroy();
      websocketClient = undefined;

      child.kill("SIGTERM");
      const [scenarioExitCode, scenarioExitSignal] = await waitForExit(child);
      child = undefined;
      assert(
        scenarioExitCode === 0 && scenarioExitSignal === null,
        `installed router ${scenario} process did not exit cleanly`,
      );
      assert(
        scenarioStarted.getStderr() === "",
        `installed router ${scenario} process wrote an error log`,
      );
    }

    const preSemanticWebSocketMessages = websocketResponses.get(
      "websocket_pre_semantic_failover",
    );
    assert(
      preSemanticWebSocketMessages.filter(
        (message) => message.type === "response.created",
      ).length === 1 &&
        preSemanticWebSocketMessages.some(
          (message) =>
            message.type === "response.output_text.delta" &&
            message.delta ===
              "installed-websocket-pre-semantic-secondary",
        ) &&
        preSemanticWebSocketMessages.some(
          (message) => message.type === "response.completed",
        ) &&
        !preSemanticWebSocketMessages.some(
          (message) => message.type === "error",
        ),
      "installed router did not recover the pre-semantic WebSocket request",
    );
    assert(
      JSON.stringify(syntheticWebSocketRoleSequences.pre_semantic) ===
        JSON.stringify(["primary", "secondary"]),
      "installed router WebSocket retry was not bounded to primary then secondary",
    );

    const postSemanticWebSocketMessages = websocketResponses.get(
      "websocket_post_semantic_failure",
    );
    const postSemanticWebSocketError = postSemanticWebSocketMessages.find(
      (message) => message.type === "error",
    );
    assert(
      postSemanticWebSocketMessages.some(
        (message) =>
          message.type === "response.output_text.delta" &&
          message.delta === "installed-websocket-post-semantic-primary",
      ) &&
        postSemanticWebSocketError?.error?.type === "unsafe_to_replay" &&
        postSemanticWebSocketError.error.semantic_output === true,
      "installed router did not expose the post-semantic WebSocket error",
    );
    assert(
      JSON.stringify(syntheticWebSocketRoleSequences.post_semantic) ===
        JSON.stringify(["primary"]),
      "installed router contacted a WebSocket secondary after semantic output",
    );
    assert(
      fixtureUpstreamFailure === null,
      fixtureUpstreamFailure ??
        "installed router synthetic WebSocket verification failed",
    );
    const syntheticWebSocketSafetyBoundaries = {
      scenarios: 2,
      process_starts: 2,
      readiness_statuses: websocketReadinessStatuses,
      downstream_upgrade_statuses: downstreamUpgradeStatuses,
      initial_requests: 2,
      pre_semantic: {
        failure_kind: "quota_exhausted",
        upstream_role_sequence:
          syntheticWebSocketRoleSequences.pre_semantic,
        upstream_attempts:
          syntheticWebSocketRoleSequences.pre_semantic.length,
        primary_preflight_discarded: true,
        secondary_semantic_marker_received: true,
        completed: true,
        retry_bound_observed: true,
      },
      post_semantic: {
        upstream_role_sequence:
          syntheticWebSocketRoleSequences.post_semantic,
        upstream_attempts:
          syntheticWebSocketRoleSequences.post_semantic.length,
        primary_semantic_marker_received: true,
        unsafe_to_replay_exposed: true,
        semantic_output: true,
        secondary_contacted: false,
      },
      local_fixture_upstream_only: true,
      synthetic_credential_acquisition_tested: true,
      synthetic_websocket_requests_sent: websocketResponses.size,
      synthetic_upstream_attempts:
        syntheticWebSocketRoleSequences.pre_semantic.length +
        syntheticWebSocketRoleSequences.post_semantic.length,
      manual_switch_tested: false,
      real_credentials_present: false,
      real_model_request_sent: false,
      real_account_switch_tested: false,
      in_flight_resume_tested: false,
    };

    const manualSwitchStateDirectory = path.join(
      temporaryRoot,
      "synthetic-manual-switch-state",
    );
    await fs.mkdir(manualSwitchStateDirectory, { mode: 0o700 });
    const manualSwitchReadinessStatuses = [];
    const manualSwitchEnvironment = {
      ...scrubbedRuntimeEnvironment(homeDirectory),
      CODEX_ROUTER_ACCOUNTS_FILE: syntheticAccountsFile,
      CODEX_ROUTER_CREDENTIAL_ROOT: syntheticBindingRoot,
      CODEX_ROUTER_ADMIN_TOKEN_FILE: syntheticAdminTokenFile,
      CODEX_ROUTER_STATE_DIRECTORY: manualSwitchStateDirectory,
      CODEX_ROUTER_UPSTREAM_ORIGIN: syntheticUpstreamOrigin,
    };
    const routingStatePath = path.join(
      manualSwitchStateDirectory,
      "routing-state.json",
    );
    const readSyntheticRouting = async () => {
      const document = JSON.parse(await fs.readFile(routingStatePath, "utf8"));
      return document.routing;
    };

    syntheticFixtureScenario = "manual_switch_active_stream";
    child = spawn(path.join(current, "bin/codex-account-router"), [], {
      cwd: current,
      env: manualSwitchEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const manualSwitchStarted = await waitForStart(child);
    const manualSwitchAdminOrigin =
      `http://127.0.0.1:${manualSwitchStarted.record.bind_port}`;
    const manualSwitchModelOrigin =
      `http://127.0.0.1:${manualSwitchStarted.record.model_bind_port}`;
    const manualSwitchReadyResponse = await fetch(
      `${manualSwitchAdminOrigin}/readyz`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const manualSwitchReadiness = await manualSwitchReadyResponse.json();
    assert(
      manualSwitchReadyResponse.status === 200 &&
        manualSwitchReadiness.status === "ready" &&
        manualSwitchReadiness.usable_accounts === 2,
      "installed router manual-switch fixture readiness was invalid",
    );
    manualSwitchReadinessStatuses.push(manualSwitchReadyResponse.status);

    websocketClient = await openSyntheticWebSocket({
      port: manualSwitchStarted.record.model_bind_port,
    });
    const manualSwitchUpgradeStatus = websocketClient.status;
    sendSyntheticWebSocketCreate(websocketClient.socket);
    await websocketClient.collector.waitFor(
      (message) =>
        message.type === "response.output_text.delta" &&
        message.delta === "installed-manual-switch-active-primary",
    );
    const activeStatusBeforeDeniedSwitch = await waitForSyntheticStatus({
      adminOrigin: manualSwitchAdminOrigin,
      adminToken: syntheticAdminToken,
      predicate(status) {
        return (
          status.active_streams === 1 &&
          status.current_route?.account_alias === syntheticBindings[0].alias &&
          status.current_route?.continuity === "new_backend_session"
        );
      },
    });
    const routingBeforeDeniedSwitch = await readSyntheticRouting();
    const deniedSwitchResponse = await fetch(
      `${manualSwitchAdminOrigin}/v1/switch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${syntheticAdminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          account_alias: syntheticBindings[1].alias,
          reason: "manual",
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const deniedSwitchBody = await deniedSwitchResponse.json();
    const activeStatusAfterDeniedSwitch = await waitForSyntheticStatus({
      adminOrigin: manualSwitchAdminOrigin,
      adminToken: syntheticAdminToken,
      predicate(status) {
        return (
          status.active_streams === 1 &&
          status.current_route?.account_alias === syntheticBindings[0].alias
        );
      },
    });
    const routingAfterDeniedSwitch = await readSyntheticRouting();
    const durableRouteUnchanged =
      JSON.stringify(routingAfterDeniedSwitch) ===
        JSON.stringify(routingBeforeDeniedSwitch);
    assert(
      deniedSwitchResponse.status === 409 &&
        deniedSwitchBody.error === "active_semantic_stream" &&
        durableRouteUnchanged,
      "installed router changed a route during an active semantic stream",
    );
    assert(
      typeof completeManualSwitchWebSocket === "function",
      "installed router manual-switch fixture stream was not held open",
    );
    completeManualSwitchWebSocket();
    await websocketClient.collector.waitFor(
      (message) => message.type === "response.completed",
    );
    websocketClient.socket.destroy();
    websocketClient = undefined;
    const safeBoundaryStatus = await waitForSyntheticStatus({
      adminOrigin: manualSwitchAdminOrigin,
      adminToken: syntheticAdminToken,
      predicate(status) {
        return (
          status.active_streams === 0 &&
          status.current_route?.account_alias === syntheticBindings[0].alias
        );
      },
    });

    const acceptedSwitchResponse = await fetch(
      `${manualSwitchAdminOrigin}/v1/switch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${syntheticAdminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          account_alias: syntheticBindings[1].alias,
          reason: "manual",
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const acceptedSwitchBody = await acceptedSwitchResponse.json();
    const acceptedSwitchStatus = await waitForSyntheticStatus({
      adminOrigin: manualSwitchAdminOrigin,
      adminToken: syntheticAdminToken,
      predicate(status) {
        return (
          status.active_streams === 0 &&
          status.current_route?.account_alias === syntheticBindings[1].alias &&
          status.current_route?.continuity === "new_backend_session"
        );
      },
    });
    const acceptedRouting = await readSyntheticRouting();
    const durablePreferencePersisted =
      acceptedRouting?.current_account_id === syntheticBindings[1].id &&
      acceptedRouting?.preferred_account_id === syntheticBindings[1].id;
    assert(
      acceptedSwitchResponse.status === 200 &&
        acceptedSwitchBody.accepted === true &&
        acceptedSwitchBody.account_alias === syntheticBindings[1].alias &&
        acceptedSwitchBody.continuity === "new_backend_session" &&
        durablePreferencePersisted,
      "installed router did not persist an accepted safe-boundary switch",
    );

    syntheticFixtureScenario = "manual_switch_next_request";
    const safeBoundaryModelResponse = await fetch(
      `${manualSwitchModelOrigin}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"input":"installed-manual-switch-next-request"}',
        signal: AbortSignal.timeout(5_000),
      },
    );
    const safeBoundaryModelBody = await safeBoundaryModelResponse.text();
    const safeBoundaryRequestCompleted =
      safeBoundaryModelResponse.status === 200 &&
      safeBoundaryModelBody.includes("installed-manual-switch-secondary") &&
      safeBoundaryModelBody.includes("event: response.completed");
    assert(
      safeBoundaryRequestCompleted &&
        JSON.stringify(
          syntheticManualSwitchHttpRoleSequences.safe_boundary,
        ) === JSON.stringify(["secondary"]),
      "installed router did not apply a manual switch to the next new request",
    );

    child.kill("SIGTERM");
    const [manualSwitchExitCode, manualSwitchExitSignal] =
      await waitForExit(child);
    child = undefined;
    assert(
      manualSwitchExitCode === 0 && manualSwitchExitSignal === null,
      "installed router manual-switch fixture did not exit cleanly",
    );
    assert(
      manualSwitchStarted.getStderr() === "",
      "installed router manual-switch fixture wrote an error log",
    );

    syntheticFixtureScenario = "manual_switch_restart_request";
    child = spawn(path.join(current, "bin/codex-account-router"), [], {
      cwd: current,
      env: manualSwitchEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const manualSwitchRestarted = await waitForStart(child);
    const manualSwitchRestartAdminOrigin =
      `http://127.0.0.1:${manualSwitchRestarted.record.bind_port}`;
    const manualSwitchRestartModelOrigin =
      `http://127.0.0.1:${manualSwitchRestarted.record.model_bind_port}`;
    const manualSwitchRestartReadyResponse = await fetch(
      `${manualSwitchRestartAdminOrigin}/readyz`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const manualSwitchRestartReadiness =
      await manualSwitchRestartReadyResponse.json();
    assert(
      manualSwitchRestartReadyResponse.status === 200 &&
        manualSwitchRestartReadiness.status === "ready" &&
        manualSwitchRestartReadiness.usable_accounts === 2,
      "installed router manual-switch restart readiness was invalid",
    );
    manualSwitchReadinessStatuses.push(
      manualSwitchRestartReadyResponse.status,
    );
    const restartedManualSwitchStatus = await waitForSyntheticStatus({
      adminOrigin: manualSwitchRestartAdminOrigin,
      adminToken: syntheticAdminToken,
      predicate(status) {
        return (
          status.active_streams === 0 &&
          status.current_route?.account_alias === syntheticBindings[1].alias &&
          status.current_route?.continuity === "new_backend_session"
        );
      },
    });
    const restartModelResponse = await fetch(
      `${manualSwitchRestartModelOrigin}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"input":"installed-manual-switch-restart-request"}',
        signal: AbortSignal.timeout(5_000),
      },
    );
    const restartModelBody = await restartModelResponse.text();
    const restartRequestCompleted =
      restartModelResponse.status === 200 &&
      restartModelBody.includes("installed-manual-switch-secondary") &&
      restartModelBody.includes("event: response.completed");
    assert(
      restartRequestCompleted &&
        JSON.stringify(syntheticManualSwitchHttpRoleSequences.restart) ===
          JSON.stringify(["secondary"]),
      "installed router did not retain a manual switch across restart",
    );
    child.kill("SIGTERM");
    const [manualSwitchRestartExitCode, manualSwitchRestartExitSignal] =
      await waitForExit(child);
    child = undefined;
    assert(
      manualSwitchRestartExitCode === 0 &&
        manualSwitchRestartExitSignal === null,
      "installed router restarted manual-switch fixture did not exit cleanly",
    );
    assert(
      manualSwitchRestarted.getStderr() === "",
      "installed router restarted manual-switch fixture wrote an error log",
    );
    assert(
      fixtureUpstreamFailure === null,
      fixtureUpstreamFailure ??
        "installed router synthetic manual-switch verification failed",
    );
    assert(
      JSON.stringify(
        syntheticWebSocketRoleSequences.manual_switch_active,
      ) === JSON.stringify(["primary"]),
      "installed router rerouted an active semantic WebSocket stream",
    );
    const syntheticManualSwitchSafetyBoundary = {
      configured_bindings: syntheticBindings.length,
      process_starts: 2,
      restart_count: 1,
      readiness_statuses: manualSwitchReadinessStatuses,
      active_semantic_stream: {
        downstream_upgrade_status: manualSwitchUpgradeStatus,
        upstream_role_sequence:
          syntheticWebSocketRoleSequences.manual_switch_active,
        primary_semantic_marker_received: true,
        active_streams_before_denied_switch:
          activeStatusBeforeDeniedSwitch.active_streams,
        denied_switch_status: deniedSwitchResponse.status,
        denied_switch_error: deniedSwitchBody.error,
        current_route_role_before:
          activeStatusBeforeDeniedSwitch.current_route.account_alias ===
            syntheticBindings[0].alias
            ? "primary"
            : "unexpected",
        current_route_role_after:
          activeStatusAfterDeniedSwitch.current_route.account_alias ===
            syntheticBindings[0].alias
            ? "primary"
            : "unexpected",
        durable_route_unchanged: durableRouteUnchanged,
        completed_before_acceptance:
          safeBoundaryStatus.active_streams === 0,
      },
      safe_boundary: {
        active_streams_at_acceptance: acceptedSwitchStatus.active_streams,
        accepted_switch_status: acceptedSwitchResponse.status,
        accepted: acceptedSwitchBody.accepted,
        target_role:
          acceptedSwitchBody.account_alias === syntheticBindings[1].alias
            ? "secondary"
            : "unexpected",
        continuity: acceptedSwitchBody.continuity,
        next_new_request_role_sequence:
          syntheticManualSwitchHttpRoleSequences.safe_boundary,
        next_new_request_completed: safeBoundaryRequestCompleted,
        durable_preference_persisted: durablePreferencePersisted,
      },
      restart: {
        readiness_status: manualSwitchRestartReadyResponse.status,
        current_route_role:
          restartedManualSwitchStatus.current_route.account_alias ===
            syntheticBindings[1].alias
            ? "secondary"
            : "unexpected",
        continuity:
          restartedManualSwitchStatus.current_route.continuity,
        next_new_request_role_sequence:
          syntheticManualSwitchHttpRoleSequences.restart,
        next_new_request_completed: restartRequestCompleted,
      },
      local_fixture_upstream_only: true,
      synthetic_credential_acquisition_tested: true,
      synthetic_manual_switch_tested: true,
      synthetic_model_requests_sent: 3,
      real_credentials_present: false,
      real_model_request_sent: false,
      real_account_switch_tested: false,
      in_flight_resume_tested: false,
    };

    return {
      health_status: healthResponse.status,
      readiness_status: readinessResponse.status,
      readiness_reason: readiness.reason,
      admin_bind: "127.0.0.1",
      model_bind: "127.0.0.1",
      sigterm_exit_code: exitCode,
      display_environment_present: false,
      account_configuration_present: false,
      account_switch_tested: false,
      architecture,
      startup_interruption: startupInterruptions[0],
      startup_interruptions: startupInterruptions,
      listener_start_interruption: listenerStartInterruptions[0],
      listener_start_interruptions: listenerStartInterruptions,
      synthetic_two_binding_restart: syntheticTwoBindingRestart,
      synthetic_weekly_quota_restart: syntheticWeeklyQuotaRestart,
      synthetic_http_sse_safety_boundaries:
        syntheticHttpSseSafetyBoundaries,
      synthetic_websocket_safety_boundaries:
        syntheticWebSocketSafetyBoundaries,
      synthetic_manual_switch_safety_boundary:
        syntheticManualSwitchSafetyBoundary,
    };
  } finally {
    if (websocketClient?.socket) {
      websocketClient.socket.destroy();
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    for (const socket of fixtureWebSocketSockets ?? []) {
      socket.destroy();
    }
    if (fixtureServer?.listening) {
      await closeLoopback(fixtureServer);
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  assert(process.platform === "linux", "Linux release verification must run on a Linux host");
  assert(SUPPORTED_ARCHITECTURES.has(options.architecture), "architecture must be x64 or arm64");
  assert(process.arch === options.architecture, "Node architecture does not match --arch");
  assert(options.artifactPath, "--artifact is required");
  const artifactPath = path.resolve(options.artifactPath);
  const release = await verifyArchive(artifactPath, options.architecture);
  const runtime = await verifyInstalledRuntime({
    artifactPath,
    architecture: options.architecture,
    release,
  });
  const summary = {
    schema_version: 1,
    target: { os: process.platform, architecture: process.arch },
    artifact: {
      name: path.basename(artifactPath),
      sha256: release.digest,
      payload_file_count: release.manifest.files.length,
      electron_required: false,
      display_server_required: false,
      node_modules_present: false,
    },
    install: {
      command: "PREFIX=<absolute-directory> sh <release>/install.sh",
      node_requirement: release.manifest.runtime.node,
    },
    runtime,
    continuity: {
      architecture_mode: "LIMITED_MODE",
      account_switch_tested: false,
      seamless_cross_account_continuity_claimed: false,
    },
  };
  if (options.summaryPath) {
    const summaryPath = path.resolve(options.summaryPath);
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o644 });
  }
  process.stdout.write(`${JSON.stringify({ event: "linux_release_verified", ...summary })}\n`);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`linux release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
