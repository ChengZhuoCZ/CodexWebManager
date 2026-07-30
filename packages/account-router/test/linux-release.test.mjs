import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLinuxRelease,
  readLinuxReleaseArchive,
} from "../scripts/build-linux-release.mjs";

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-linux-release-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("builds a byte-reproducible x64 Linux archive without desktop dependencies", async (context) => {
  const temporaryRoot = await temporaryDirectory(context);
  const first = await buildLinuxRelease({
    architecture: "x64",
    outputDirectory: path.join(temporaryRoot, "first"),
    sourceDateEpoch: 0,
  });
  const second = await buildLinuxRelease({
    architecture: "x64",
    outputDirectory: path.join(temporaryRoot, "second"),
    sourceDateEpoch: 0,
  });

  const firstArchive = await fs.readFile(first.artifactPath);
  const secondArchive = await fs.readFile(second.artifactPath);
  assert.deepEqual(firstArchive, secondArchive);
  assert.equal(first.sha256, sha256(firstArchive));
  assert.equal(second.sha256, first.sha256);
  assert.equal(
    await fs.readFile(first.checksumPath, "utf8"),
    `${first.sha256}  ${path.basename(first.artifactPath)}\n`,
  );

  const entries = readLinuxReleaseArchive(firstArchive);
  const files = new Map(
    entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]),
  );
  const root = first.releaseName;
  const manifestEntry = files.get(`${root}/manifest.json`);
  assert.ok(manifestEntry);

  const manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  assert.equal(manifest.version, "0.2.15");
  assert.equal(first.releaseName, "codex-account-router-0.2.15-linux-x64");
  assert.deepEqual(manifest.target, { os: "linux", architecture: "x64" });
  assert.equal(manifest.runtime.node, ">=22");
  assert.equal(manifest.runtime.electron_required, false);
  assert.equal(manifest.runtime.display_server_required, false);
  assert.equal(manifest.reproducibility.source_date_epoch, 0);
  assert.deepEqual(manifest.schemas, { accounts: 1, circuit_state: 1 });

  const archivedPaths = entries.map((entry) => entry.path);
  assert.ok(archivedPaths.includes(`${root}/bin/codex-account-router`));
  assert.ok(archivedPaths.includes(`${root}/bin/codex-router-account`));
  assert.ok(archivedPaths.includes(`${root}/bin/codex-router-cli`));
  assert.ok(archivedPaths.includes(`${root}/bin/codex-stack-deploy`));
  assert.ok(archivedPaths.includes(`${root}/install.sh`));
  assert.ok(archivedPaths.includes(`${root}/lib/account-router/src/main.mjs`));
  assert.ok(archivedPaths.includes(`${root}/lib/account-router/src/weekly-quota-tracker.mjs`));
  assert.ok(archivedPaths.includes(`${root}/lib/account-router/package.json`));
  assert.equal(archivedPaths.some((entryPath) => entryPath.includes("node_modules")), false);
  assert.equal(archivedPaths.some((entryPath) => /electron/i.test(entryPath)), false);

  for (const executablePath of [
    `${root}/bin/codex-account-router`,
    `${root}/bin/codex-router-account`,
    `${root}/bin/codex-router-cli`,
    `${root}/bin/codex-stack-deploy`,
    `${root}/install.sh`,
  ]) {
    assert.equal(files.get(executablePath)?.mode, 0o755);
  }
  assert.match(
    files.get(`${root}/install.sh`).content.toString("utf8"),
    /mv -Tf -- "\$temporary_link" "\$prefix\/current"/,
  );
  assert.match(
    files.get(`${root}/lib/account-router/src/runtime-composition.mjs`).content.toString("utf8"),
    /runtime-weekly-events/,
  );

  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const payloadPaths = [...files.keys()]
    .filter((entryPath) => entryPath !== `${root}/manifest.json`)
    .map((entryPath) => entryPath.slice(root.length + 1));
  assert.deepEqual([...manifestPaths].sort(), payloadPaths.sort());
  for (const file of manifest.files) {
    const entry = files.get(`${root}/${file.path}`);
    assert.ok(entry, file.path);
    assert.equal(file.sha256, sha256(entry.content), file.path);
    assert.equal(file.size, entry.content.length, file.path);
    assert.equal(file.mode, entry.mode.toString(8).padStart(4, "0"), file.path);
  }
});

test("rejects unsupported Linux architectures before writing an artifact", async (context) => {
  const outputDirectory = await temporaryDirectory(context);
  await assert.rejects(
    buildLinuxRelease({ architecture: "ia32", outputDirectory }),
    /architecture must be x64 or arm64/i,
  );
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});
