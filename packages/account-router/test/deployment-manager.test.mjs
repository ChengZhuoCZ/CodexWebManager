import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeploymentManager } from "../src/deployment-manager.mjs";

const NOW = Date.parse("2026-07-27T08:00:00.000Z");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtureRoot(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-deployment-manager-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRelease(root, version, marker) {
  const releaseName = `codex-account-router-${version}-linux-x64`;
  const releaseDirectory = path.join(root, "incoming", releaseName);
  const executable = Buffer.from(`#!/bin/sh\n# ${marker}\n`);
  await mkdir(path.join(releaseDirectory, "bin"), { recursive: true });
  await writeFile(path.join(releaseDirectory, "bin", "codex-account-router"), executable, {
    mode: 0o755,
  });
  await chmod(path.join(releaseDirectory, "bin", "codex-account-router"), 0o755);
  await writeFile(
    path.join(releaseDirectory, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      name: "@codex-web-manager/account-router",
      version,
      target: { os: "linux", architecture: "x64" },
      schemas: { accounts: 1, circuit_state: 1 },
      files: [{
        path: "bin/codex-account-router",
        mode: "0755",
        size: executable.length,
        sha256: sha256(executable),
      }],
    }, null, 2)}\n`,
    { mode: 0o644 },
  );
  return { releaseDirectory, releaseName };
}

async function installExistingRelease(prefix, release) {
  const target = path.join(prefix, "releases", release.releaseName);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target);
  await writeFile(path.join(target, "manifest.json"), await readFile(
    path.join(release.releaseDirectory, "manifest.json"),
  ));
  await mkdir(path.join(target, "bin"));
  await writeFile(
    path.join(target, "bin", "codex-account-router"),
    await readFile(path.join(release.releaseDirectory, "bin", "codex-account-router")),
    { mode: 0o755 },
  );
  await symlink(`releases/${release.releaseName}`, path.join(prefix, "current"));
}

async function writeOperationalFiles(configFile, stateFile, alias = "Fixture A") {
  await mkdir(path.dirname(configFile), { recursive: true });
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify({
    version: 1,
    accounts: [{
      id: "fixture-account-a",
      alias,
      enabled: true,
      priority: 1,
      max_concurrency: 1,
      provider: "openai-codex",
      secret_provider: "codex-auth",
      credential_ref: "fixture-a",
    }],
  })}\n`, { mode: 0o600 });
  await writeFile(stateFile, `${JSON.stringify({
    version: 1,
    saved_at: "2026-07-27T08:00:00.000Z",
    accounts: [],
    weekly_quota: [{
      account_id: "fixture-account-a",
      observed_at: "2026-07-27T08:00:00.000Z",
      remaining_ratio: 0.5,
      resets_at: "2026-07-28T00:00:00.000Z",
    }],
  })}\n`, { mode: 0o600 });
  await chmod(configFile, 0o600);
  await chmod(stateFile, 0o600);
}

async function managerFixture(context) {
  const root = await fixtureRoot(context);
  const prefix = path.join(root, "opt", "codex-account-router");
  const configFile = path.join(root, "etc", "codex-account-router", "accounts.json");
  const stateFile = path.join(root, "var", "lib", "codex-account-router", "circuit-state.json");
  const backupRoot = path.join(root, "var", "backups", "codex-account-router");
  const oldRelease = await writeRelease(root, "0.1.0", "old");
  const newRelease = await writeRelease(root, "0.2.0", "new");
  await installExistingRelease(prefix, oldRelease);
  await writeOperationalFiles(configFile, stateFile);
  const serviceEvents = [];
  const serviceController = {
    async stop() { serviceEvents.push("stop"); },
    async start() { serviceEvents.push("start"); },
  };
  const healthCheck = async () => true;
  const manager = createDeploymentManager({
    architecture: "x64",
    backupRoot,
    configFile,
    healthCheck,
    now: () => NOW,
    platform: "linux",
    prefix,
    serviceController,
    stateFile,
  });
  return {
    backupRoot,
    configFile,
    manager,
    newRelease,
    oldRelease,
    prefix,
    root,
    serviceController,
    serviceEvents,
    stateFile,
  };
}

test("upgrade snapshots config/state, activates an immutable release, and rolls back in one call", async (context) => {
  const fixture = await managerFixture(context);
  const upgraded = await fixture.manager.upgrade({
    releaseDirectory: fixture.newRelease.releaseDirectory,
  });
  assert.equal(upgraded.release, fixture.newRelease.releaseName);
  assert.match(upgraded.snapshot_id, /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/);
  assert.equal(
    await readlink(path.join(fixture.prefix, "current")),
    `releases/${fixture.newRelease.releaseName}`,
  );
  const snapshotDirectory = path.join(fixture.backupRoot, upgraded.snapshot_id);
  const snapshotMetadata = await lstat(snapshotDirectory);
  assert.equal(snapshotMetadata.mode & 0o077, 0);
  const snapshotManifest = JSON.parse(
    await readFile(path.join(snapshotDirectory, "manifest.json"), "utf8"),
  );
  assert.equal(snapshotManifest.previous_release, fixture.oldRelease.releaseName);
  assert.equal(snapshotManifest.credentials_included, false);
  assert.deepEqual(snapshotManifest.schemas, { accounts: 1, circuit_state: 1 });

  await writeOperationalFiles(fixture.configFile, fixture.stateFile, "Mutated");
  const rolledBack = await fixture.manager.rollback({ snapshotId: upgraded.snapshot_id });
  assert.equal(rolledBack.release, fixture.oldRelease.releaseName);
  assert.equal(
    await readlink(path.join(fixture.prefix, "current")),
    `releases/${fixture.oldRelease.releaseName}`,
  );
  assert.match(await readFile(fixture.configFile, "utf8"), /Fixture A/);
  assert.doesNotMatch(await readFile(fixture.configFile, "utf8"), /Mutated/);
  assert.equal(
    JSON.parse(await readFile(fixture.stateFile, "utf8")).weekly_quota[0].remaining_ratio,
    0.5,
  );
  assert.deepEqual(fixture.serviceEvents, ["stop", "start", "stop", "start"]);
});

test("failed post-upgrade health check automatically restores the snapshot", async (context) => {
  const fixture = await managerFixture(context);
  let healthChecks = 0;
  const manager = createDeploymentManager({
    architecture: "x64",
    backupRoot: fixture.backupRoot,
    configFile: fixture.configFile,
    healthCheck: async () => {
      healthChecks += 1;
      return healthChecks > 1;
    },
    now: () => NOW,
    platform: "linux",
    prefix: fixture.prefix,
    serviceController: fixture.serviceController,
    stateFile: fixture.stateFile,
  });
  await assert.rejects(
    manager.upgrade({ releaseDirectory: fixture.newRelease.releaseDirectory }),
    /upgrade health verification failed/,
  );
  assert.equal(
    await readlink(path.join(fixture.prefix, "current")),
    `releases/${fixture.oldRelease.releaseName}`,
  );
  assert.match(await readFile(fixture.configFile, "utf8"), /Fixture A/);
  assert.deepEqual(fixture.serviceEvents, ["stop", "start", "stop", "start"]);
});

test("deployment manager rejects unsafe roots, snapshot ids, releases, and schema changes", async (context) => {
  const fixture = await managerFixture(context);
  assert.throws(
    () => createDeploymentManager({
      backupRoot: "relative",
      configFile: fixture.configFile,
      healthCheck: async () => true,
      prefix: fixture.prefix,
      serviceController: fixture.serviceController,
      stateFile: fixture.stateFile,
    }),
    /absolute/,
  );
  await assert.rejects(
    fixture.manager.rollback({ snapshotId: "../escape" }),
    /snapshot id/,
  );
  const manifestPath = path.join(fixture.newRelease.releaseDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.schemas.accounts = 2;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    fixture.manager.upgrade({ releaseDirectory: fixture.newRelease.releaseDirectory }),
    /schema/,
  );
});

test("the pinned 0.1.0 release is treated as the documented implicit schema-1 baseline", async (context) => {
  const fixture = await managerFixture(context);
  const oldManifestPath = path.join(
    fixture.prefix,
    "releases",
    fixture.oldRelease.releaseName,
    "manifest.json",
  );
  const oldManifest = JSON.parse(await readFile(oldManifestPath, "utf8"));
  delete oldManifest.schemas;
  await writeFile(oldManifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`);
  const snapshot = await fixture.manager.backup();
  assert.match(snapshot.snapshot_id, /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/);
});
