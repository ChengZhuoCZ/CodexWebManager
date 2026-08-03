import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRoutedWebPipeline } from "../../../integrations/codex-web/build-routed-web-pipeline.mjs";

const upstream = process.env.M6_3_CODEX_WEB_ROOT;
const integrationTest = upstream && path.isAbsolute(upstream) ? test : test.skip;

integrationTest("rebuilds the exact routed Web overlay from the clean pinned upstream", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-web-pipeline-"));
  const workRoot = `${root}-work`;
  context.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(workRoot, { recursive: true, force: true }),
  ]));
  const previous = process.env.M69_ROUTED_WEB_PREVIOUS ?? fileURLToPath(
    new URL("./fixtures/routed-web-previous", import.meta.url),
  );
  assert.ok(path.isAbsolute(previous));
  const manifest = JSON.parse(await fs.readFile(
    new URL("./fixtures/routed-web-overlay-manifest.json", import.meta.url),
    "utf8",
  ));
  const result = await buildRoutedWebPipeline({
    upstream,
    previous,
    workRoot,
    candidate: path.join(root, "candidate"),
    output: path.join(root, "overlay.tar.gz"),
    manifest,
  });
  assert.equal(result.archive_sha256, "c72a118b35bd03c0d28602b6c19756c51e0b845dc272ef3ad8a02387bedd15db");
  assert.equal(result.archive_bytes, 314538);
  assert.equal(result.files, 15);
  assert.equal(result.upstream_revision, "888692f7d885118c6a92bbaf60cf2121f5947adf");
  assert.equal(result.real_model_request_sent, false);
  assert.equal(result.account_switch_tested, false);
});
