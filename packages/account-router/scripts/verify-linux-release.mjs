#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    child.kill("SIGTERM");
    const [listenerExitCode, listenerExitSignal] = await waitForExit(child);
    child = undefined;
    const listenerStdout = listenerStalled.getStdout();
    const listenerStderr = listenerStalled.getStderr();
    const listenerStartInterruption = {
      signal: "SIGTERM",
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
      "installed router did not stop cleanly during stalled listener start",
    );

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
      listener_start_interruption: listenerStartInterruption,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
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
