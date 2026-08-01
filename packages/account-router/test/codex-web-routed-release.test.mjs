import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { stageRoutedWebRelease } from "../../../integrations/codex-web/stage-routed-release.mjs";

const serverFiles = [
  "src/server/main.js",
  "src/server/module.js",
  "src/server/electron/index.js",
  "src/server/browser-ipc-router.js",
  "src/server/browser-session-auth.js",
  "src/server/browser-upload-store.js",
  "src/server/router-status-bridge.js",
];

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { mode: 0o644 });
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-routed-release-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "releases", "previous");
  const candidate = path.join(root, "releases", "candidate");
  const serverBuild = path.join(root, "server-build");
  const browserBuild = path.join(root, "browser-build");
  for (const relativePath of serverFiles) {
    await write(
      previous,
      relativePath,
      relativePath === "src/server/electron/index.js"
        ? "stable predecessor electron shim\n"
        : `old:${relativePath}\n`,
    );
    await write(serverBuild, relativePath, `new:${relativePath}\n`);
  }
  await write(
    previous,
    "scratch/asar/webview/index.html",
    '<script type="module" src="./assets/preload-deadbeef.js"></script>\n',
  );
  await write(previous, "scratch/asar/webview/index.html.gz", "old gzip\n");
  await write(previous, "scratch/asar/webview/index.html.br", "old brotli\n");
  await write(previous, "scratch/asar/webview/assets/preload-deadbeef.js", "old preload\n");
  await write(browserBuild, "scratch/asar/webview/assets/preload.js", "const routed = true;\n");
  return { root, previous, candidate, serverBuild, browserBuild };
}

test("stages a complete routed Web successor without changing the previous release", async (context) => {
  const paths = await fixture(context);
  const previousIndex = await fs.readFile(
    path.join(paths.previous, "scratch/asar/webview/index.html"),
  );
  const result = await stageRoutedWebRelease(paths);
  const expectedPreloadHash = createHash("sha256")
    .update("const routed = true;\n")
    .digest("hex");
  assert.equal(result.preload_sha256, expectedPreloadHash);
  assert.equal(result.preload_name, `preload-${expectedPreloadHash.slice(0, 8)}.js`);
  for (const relativePath of serverFiles) {
    assert.equal(
      await fs.readFile(path.join(paths.candidate, relativePath), "utf8"),
      relativePath === "src/server/electron/index.js"
        ? "stable predecessor electron shim\n"
        : `new:${relativePath}\n`,
    );
  }
  const webview = path.join(paths.candidate, "scratch/asar/webview");
  const index = await fs.readFile(path.join(webview, "index.html"));
  const preload = await fs.readFile(path.join(webview, "assets", result.preload_name));
  assert.equal(preload.toString(), "const routed = true;\n");
  assert.match(index.toString(), new RegExp(`assets/${result.preload_name}`));
  assert.doesNotMatch(index.toString(), /preload-deadbeef/);
  assert.deepEqual(gunzipSync(await fs.readFile(path.join(webview, "index.html.gz"))), index);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(path.join(webview, "index.html.br"))), index);
  assert.deepEqual(
    gunzipSync(await fs.readFile(path.join(webview, "assets", `${result.preload_name}.gz`))),
    preload,
  );
  assert.deepEqual(
    brotliDecompressSync(await fs.readFile(path.join(webview, "assets", `${result.preload_name}.br`))),
    preload,
  );
  assert.deepEqual(
    await fs.readFile(path.join(paths.previous, "scratch/asar/webview/index.html")),
    previousIndex,
  );
});

test("removes the incomplete successor when the pre-commit check fails", async (context) => {
  const paths = await fixture(context);
  await assert.rejects(
    stageRoutedWebRelease({
      ...paths,
      beforeCommit() {
        throw new Error("synthetic pre-commit failure");
      },
    }),
    /routed Web release staging failed/,
  );
  await assert.rejects(fs.access(paths.candidate));
  assert.deepEqual(
    (await fs.readdir(path.dirname(paths.candidate))).sort(),
    ["previous"],
  );
});
