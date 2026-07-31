import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRoutedWebOverlay } from "../../../integrations/codex-web/build-routed-overlay.mjs";
import { readLinuxReleaseArchive } from "../scripts/build-linux-release.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("builds the same pinned overlay from independent candidate directories", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-overlay-build-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ["src/server/main.js", "scratch/asar/webview/index.html"];
  const manifest = { schema_version: 1, files: [] };
  for (const relativePath of files) {
    const bytes = Buffer.from(`fixture:${relativePath}\n`);
    manifest.files.push({ path: relativePath, sha256: sha256(bytes) });
    for (const name of ["a", "b"]) {
      const target = path.join(root, name, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: name === "a" ? 0o600 : 0o644 });
    }
  }
  const outputA = path.join(root, "a.tar.gz");
  const outputB = path.join(root, "b.tar.gz");
  const [resultA, resultB] = await Promise.all([
    buildRoutedWebOverlay({ candidate: path.join(root, "a"), output: outputA, manifest }),
    buildRoutedWebOverlay({ candidate: path.join(root, "b"), output: outputB, manifest }),
  ]);
  assert.equal(resultA.archive_sha256, resultB.archive_sha256);
  assert.deepEqual(await fs.readFile(outputA), await fs.readFile(outputB));
  assert.deepEqual(readLinuxReleaseArchive(await fs.readFile(outputA)).map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    content: entry.content.toString(),
  })), files.map((relativePath) => ({
    path: relativePath,
    mode: 0o644,
    content: `fixture:${relativePath}\n`,
  })));
});

test("rejects a changed candidate before publishing an archive", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-overlay-reject-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "candidate"));
  await fs.writeFile(path.join(root, "candidate/file.js"), "changed\n");
  const output = path.join(root, "output.tar.gz");
  await assert.rejects(buildRoutedWebOverlay({
    candidate: path.join(root, "candidate"),
    output,
    manifest: { schema_version: 1, files: [{ path: "file.js", sha256: "0".repeat(64) }] },
  }), /overlay build failed/);
  await assert.rejects(fs.access(output));
});
