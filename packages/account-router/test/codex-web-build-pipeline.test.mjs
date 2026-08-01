import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const upstream = process.env.M6_3_CODEX_WEB_ROOT;
const integrationTest = upstream && path.isAbsolute(upstream) ? test : test.skip;

integrationTest("rebuilds the exact routed Web overlay from the clean pinned upstream", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-web-pipeline-"));
  const workRoot = `${root}-work`;
  context.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(workRoot, { recursive: true, force: true }),
  ]));
  const previous = process.env.M69_ROUTED_WEB_PREVIOUS ??
    "/opt/0xcaff-codex-web-router/releases/c3e92f0f-20260729-m69-router-r23";
  assert.ok(path.isAbsolute(previous));
  const execution = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, "../../../integrations/codex-web/build-routed-web-pipeline.mjs"),
    upstream,
    previous,
    workRoot,
    path.join(root, "candidate"),
    path.join(root, "overlay.tar.gz"),
  ], {
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.archive_sha256, "6a8060aaf32c67190412d0f97e9b57da9e89638143ec76484da9927dc00744b9");
  assert.equal(result.archive_bytes, 313733);
  assert.equal(result.files, 13);
  assert.equal(result.upstream_revision, "888692f7d885118c6a92bbaf60cf2121f5947adf");
  assert.equal(result.real_model_request_sent, false);
  assert.equal(result.account_switch_tested, false);
});
