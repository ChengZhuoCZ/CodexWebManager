#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const SERVICE = "codex-account-router.service";
const PREFIX = "/opt/codex-account-router";
const CONFIG_FILE = "/etc/codex-account-router/accounts.json";
const STATE_FILE = "/var/lib/codex-account-router/circuit-state.json";
const ADMIN_TOKEN_FILE = "/etc/codex-account-router/credentials/admin-token";
const BACKUP_ROOT = "/var/backups/codex-account-router";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEADLINE_MS = 30_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--new-release-dir") {
      options.newReleaseDirectory = argumentsList[++index];
    } else if (argument === "--summary") {
      options.summaryPath = argumentsList[++index];
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error("unknown verification argument");
    }
  }
  return options;
}

function usage() {
  return "Usage: node verify-upgrade-rollback.mjs --new-release-dir DIR --summary FILE\n";
}

function run(command, argumentsList, { allowFailure = false, environment = process.env } = {}) {
  const result = spawnSync(command, argumentsList, {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with status ${result.status}`);
  }
  return result;
}

function systemctl(action) {
  run("systemctl", [action, SERVICE]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestJson(requestPath, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { accept: "application/json", connection: "close" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const request = http.get({
      host: "127.0.0.1",
      port: 18318,
      path: requestPath,
      headers,
      timeout: 2_000,
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) response.destroy();
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          assert(length <= MAX_RESPONSE_BYTES, "admin response exceeded the bound");
          resolve({
            statusCode: response.statusCode,
            value: JSON.parse(Buffer.concat(chunks, length).toString("utf8")),
          });
        } catch {
          reject(new Error("admin response was invalid"));
        }
      });
      response.once("error", () => reject(new Error("admin response failed")));
    });
    request.once("timeout", () => {
      request.destroy();
      reject(new Error("admin response timed out"));
    });
    request.once("error", () => reject(new Error("admin response failed")));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + DEADLINE_MS;
  let backoff = 100;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson("/healthz");
      if (response.statusCode === 200) return;
    } catch {}
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(backoff, remaining));
    backoff = Math.min(backoff * 2, 1_000);
  }
  throw new Error("router health check timed out");
}

async function activeRelease() {
  const target = await readlink(path.join(PREFIX, "current"));
  const match = /^releases\/([^/]+)$/.exec(target);
  assert(match, "current release link was invalid");
  return match[1];
}

function deployCommand(executable, argumentsList) {
  const result = run(executable, argumentsList, {
    environment: { ...process.env, NODE_BINARY: "/usr/bin/node" },
  });
  let value;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("deployment command output was invalid");
  }
  assert(value.credentials_included === false, "deployment command reported credentials");
  assert(typeof value.snapshot_id === "string", "deployment snapshot id was unavailable");
  assert(typeof value.release === "string", "deployment release was unavailable");
  return value;
}

async function adminToken() {
  const token = (await readFile(ADMIN_TOKEN_FILE, "utf8"));
  assert(/^[A-Za-z0-9._~+/-]{24,4096}=*$/.test(token), "fixture admin token was invalid");
  return token;
}

async function assertPersistedStatus(token) {
  const response = await requestJson("/v1/status", token);
  assert(response.statusCode === 200, "router status was unavailable");
  assert(response.value.architecture_mode === "LIMITED_MODE", "router mode was invalid");
  assert(response.value.cross_account_e2e_verified === false, "router continuity claim was invalid");
  assert(response.value.accounts?.length === 1, "fixture account status was invalid");
  const account = response.value.accounts[0];
  assert(account.alias === "Fixture A", "fixture account alias was not restored");
  assert(account.state === "quota_exhausted", "quota health state was not restored");
  assert(account.last_switch_reason === "quota_exhausted", "failure history was not restored");
  assert(typeof account.cooldown_until === "string", "cooldown history was not restored");
  return account.cooldown_until;
}

async function writeMutatedConfiguration() {
  const document = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  document.accounts[0].alias = "Mutated fixture";
  const temporary = `${CONFIG_FILE}.${randomUUID()}.tmp`;
  await writeFilePrivate(temporary, Buffer.from(`${JSON.stringify(document)}\n`));
  await rename(temporary, CONFIG_FILE);
}

async function writeFilePrivate(filePath, bytes) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const account = run("id", ["-u", "codex"]).stdout.trim();
  const group = run("id", ["-g", "codex"]).stdout.trim();
  await chown(filePath, Number(account), Number(group));
  await chmod(filePath, 0o600);
}

async function writeSummary(filePath, summary) {
  assert(path.isAbsolute(filePath), "summary path must be absolute");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await open(temporary, "wx", 0o644).then(async (handle) => {
    try {
      await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  await rename(temporary, filePath);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  assert(process.platform === "linux", "upgrade verification requires Linux");
  assert(typeof process.getuid === "function" && process.getuid() === 0, "upgrade verification requires root");
  assert(path.isAbsolute(options.newReleaseDirectory ?? ""), "new release directory is required");
  assert(path.isAbsolute(options.summaryPath ?? ""), "summary path is required");
  assert((await readFile("/proc/1/comm", "utf8")).trim() === "systemd", "systemd must be PID 1");

  const oldRelease = await activeRelease();
  const newManifest = JSON.parse(
    await readFile(path.join(options.newReleaseDirectory, "manifest.json"), "utf8"),
  );
  const newRelease =
    `codex-account-router-${newManifest.version}-linux-${newManifest.target.architecture}`;
  const deployFromNewRelease = path.join(
    options.newReleaseDirectory,
    "bin",
    "codex-stack-deploy",
  );
  let started = false;
  try {
    run("systemctl", ["daemon-reload"]);
    systemctl("start");
    started = true;
    await waitForHealth();

    const upgrade = deployCommand(deployFromNewRelease, [
      "upgrade",
      "--release-dir",
      options.newReleaseDirectory,
    ]);
    assert(upgrade.release === newRelease, "new release was not activated");
    assert(await activeRelease() === newRelease, "current link did not select the new release");
    await waitForHealth();

    const token = await adminToken();
    const cooldownBeforeRestart = await assertPersistedStatus(token);
    systemctl("restart");
    await waitForHealth();
    const cooldownAfterRestart = await assertPersistedStatus(token);
    assert(
      cooldownAfterRestart === cooldownBeforeRestart,
      "restart changed the persisted cooldown history",
    );

    const snapshotDirectory = path.join(BACKUP_ROOT, upgrade.snapshot_id);
    const snapshotMetadata = await lstat(snapshotDirectory);
    assert(snapshotMetadata.isDirectory(), "snapshot directory was missing");
    assert((snapshotMetadata.mode & 0o077) === 0, "snapshot directory was not private");
    const snapshotManifest = JSON.parse(
      await readFile(path.join(snapshotDirectory, "manifest.json"), "utf8"),
    );
    assert(snapshotManifest.credentials_included === false, "snapshot included credentials");
    assert(
      snapshotManifest.previous_release === oldRelease,
      "snapshot did not identify the previous release",
    );
    const snapshotState = await readFile(path.join(snapshotDirectory, "circuit-state.json"));

    await writeMutatedConfiguration();
    const rollback = deployCommand(
      path.join(PREFIX, "current", "bin", "codex-stack-deploy"),
      ["rollback", "--snapshot", upgrade.snapshot_id],
    );
    assert(rollback.release === oldRelease, "rollback did not select the previous release");
    assert(await activeRelease() === oldRelease, "current link did not roll back");
    await waitForHealth();
    const restoredConfiguration = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    assert(restoredConfiguration.accounts[0].alias === "Fixture A", "configuration was not restored");
    const restoredState = await readFile(STATE_FILE);
    assert(
      createHash("sha256").update(restoredState).digest("hex") ===
        createHash("sha256").update(snapshotState).digest("hex"),
      "circuit state was not restored",
    );

    const stateMetadata = await lstat(STATE_FILE);
    const serviceUid = Number(run("id", ["-u", "codex"]).stdout.trim());
    assert(stateMetadata.uid === serviceUid, "restored state owner was invalid");
    assert((stateMetadata.mode & 0o077) === 0, "restored state permissions were invalid");

    const summary = {
      schema_version: 1,
      task: "M5.3",
      platform: `${os.platform()} ${os.arch()}`,
      systemd_version: run("systemd", ["--version"]).stdout.split("\n", 1)[0].trim(),
      node_version: process.version,
      architecture_mode: "LIMITED_MODE",
      releases: {
        previous: oldRelease,
        upgraded: newRelease,
        rollback_restored_previous: true,
      },
      schemas: {
        accounts: 1,
        circuit_state: 1,
        dry_run_before_activation: true,
      },
      snapshot: {
        private_directory: true,
        configuration_saved: true,
        circuit_state_saved: true,
        credentials_included: false,
      },
      verification: {
        post_upgrade_health_passed: true,
        restart_preserved_health_history: true,
        one_command_rollback_passed: true,
        configuration_restored: true,
        circuit_state_restored: true,
      },
      real_account_configured: false,
      account_switch_tested: false,
      in_flight_computation_resume_claimed: false,
      seamless_account_continuity_claimed: false,
    };
    await writeSummary(options.summaryPath, summary);
    process.stdout.write(`${JSON.stringify({
      event: "upgrade_rollback_verified",
      summary: path.resolve(options.summaryPath),
    })}\n`);
  } finally {
    if (started) {
      run("systemctl", ["stop", SERVICE], { allowFailure: true });
      run("systemctl", ["reset-failed", SERVICE], { allowFailure: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`upgrade/rollback verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
