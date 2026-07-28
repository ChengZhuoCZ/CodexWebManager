import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

import {
  buildMinifiedPrecompressedAsset,
  esbuildArguments,
  EXPECTED_ESBUILD_VERSION,
  versionedAssetUrl,
} from "../../../integrations/codex-web-upstream/build-minified-precompressed-asset.mjs";
import { localStartupRpcResponse } from "../../../integrations/codex-web-upstream/codex-remote-fastpath.mjs";

const precompressedAssetPatch = new URL(
  "../../../integrations/codex-web-upstream/tailnet-precompressed-asset.patch",
  import.meta.url,
);
const startupBackgroundPatch = new URL(
  "../../../integrations/codex-web-upstream/tailnet-startup-background.patch",
  import.meta.url,
);

function indexFixture() {
  return `<!doctype html>
<html>
  <head>
    <base href="/" />
    <script src="./tailnet-startup-fastpath.js"></script>
    <script type="module" src="./assets/preload.js"></script>
    <script type="module" crossorigin src="./assets/index-fixture.js"></script>
    <link
      rel="modulepreload"
      crossorigin
      href="./assets/app-initial-BTphDPeq.js"
    />
  </head>
</html>
`;
}

test("locally terminates only default empty startup catalog reads", () => {
  const cases = [
    [
      { id: "app-1", method: "app/list", params: { cursor: null, limit: 50 } },
      { data: [], nextCursor: null },
    ],
    [
      { id: 2, method: "mcpServerStatus/list", params: {} },
      { data: [], nextCursor: null },
    ],
    [
      { id: "plugin-3", method: "plugin/list" },
      {
        featuredPluginIds: [],
        marketplaceLoadErrors: [],
        marketplaces: [],
      },
    ],
  ];

  for (const [request, expected] of cases) {
    assert.deepEqual(
      JSON.parse(localStartupRpcResponse(JSON.stringify(request))),
      { id: request.id, result: expected },
    );
  }
});

test("forwards explicit refreshes, thread-scoped reads, and every non-catalog method", () => {
  const forwarded = [
    { id: 1, method: "app/list", params: { forceRefetch: true } },
    { id: 2, method: "app/list", params: { threadId: "thread-fixture" } },
    { id: 3, method: "mcpServerStatus/list", params: { threadId: "thread-fixture" } },
    { id: 4, method: "plugin/list", params: { forceRefetch: true } },
    { id: 5, method: "thread/list", params: {} },
    { id: 6, method: "turn/start", params: { input: "secret-canary" } },
  ];
  for (const request of forwarded) {
    assert.equal(localStartupRpcResponse(JSON.stringify(request)), null);
  }
});

test("fails closed for malformed or oversized input without reflecting it", () => {
  assert.equal(localStartupRpcResponse("not-json"), null);
  assert.equal(
    localStartupRpcResponse(
      JSON.stringify({ id: "x", method: "app/list", params: [] }),
    ),
    null,
  );
  assert.equal(
    localStartupRpcResponse(
      JSON.stringify({ id: "x".repeat(257), method: "app/list", params: {} }),
    ),
    null,
  );
  assert.equal(localStartupRpcResponse("x".repeat(1024 * 1024 + 1)), null);
});

test("precompressed asset patch delegates negotiation and validators to the pinned static plugin", async () => {
  const patch = await readFile(precompressedAssetPatch, "utf8");

  assert.match(patch, /preCompressed:\s*true/);
  assert.match(patch, /scratch\/asar\/webview/);
  assert.doesNotMatch(patch, /createReadStream|acceptsEncoding|Content-Encoding/);
  assert.doesNotMatch(patch, /backend-api|responses|Authorization|Cookie/);
});

test("startup background patch replaces the transparent white flash without changing requests", async () => {
  const patch = await readFile(startupBackgroundPatch, "utf8");

  assert.match(patch, /--startup-background: rgb\(/);
  assert.match(patch, /prefers-color-scheme: dark/);
  assert.match(patch, /electron-dark/);
  assert.doesNotMatch(patch, /backend-api|responses|Authorization|Cookie|fetch\(/);
});

test("builds deterministic precompressed files only after a pinned minifier produces smaller valid JavaScript", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-minified-asset-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, "assets");
  await mkdir(assets);
  const asset = path.join(assets, "app-initial-BTphDPeq.js");
  const preloadFile = path.join(assets, "preload.js");
  const stylesheetFile = path.join(assets, "app-initial-Czet5G9g.css");
  const indexFile = path.join(directory, "index.html");
  const original = Buffer.from("const intentionallyLongFixtureName = 40 + 2;\n");
  const minified = Buffer.from("const a=42;\n");
  const originalPreload = Buffer.from(
    "const intentionallyLongPreloadFixtureName = 41 + 1;\n",
  );
  const minifiedPreload = Buffer.from("const p=42;\n");
  const stylesheet = Buffer.from("body { color: rgb(1, 2, 3); }\n");
  const originalIndex = Buffer.from(indexFixture());
  await writeFile(asset, original, { mode: 0o640 });
  await writeFile(preloadFile, originalPreload, { mode: 0o640 });
  await writeFile(stylesheetFile, stylesheet, { mode: 0o640 });
  await writeFile(indexFile, originalIndex, { mode: 0o640 });
  const expectedSha256 = createHash("sha256").update(original).digest("hex");
  const expectedPreloadSha256 = createHash("sha256")
    .update(originalPreload)
    .digest("hex");
  const expectedStylesheetSha256 = createHash("sha256")
    .update(stylesheet)
    .digest("hex");
  const expectedIndexSha256 = createHash("sha256")
    .update(originalIndex)
    .digest("hex");

  const result = await buildMinifiedPrecompressedAsset({
    assetFile: asset,
    expectedSha256,
    preloadFile,
    expectedPreloadSha256,
    stylesheetFile,
    expectedStylesheetSha256,
    indexFile,
    expectedIndexSha256,
    minify: async ({ inputFile, outputFile }) => {
      if (inputFile === asset) {
        await writeFile(outputFile, minified);
        return;
      }
      assert.equal(inputFile, preloadFile);
      await writeFile(outputFile, minifiedPreload);
    },
  });

  assert.equal(result.input_bytes, original.length);
  assert.equal(result.output_bytes, minified.length);
  assert.equal(result.esbuild_version, EXPECTED_ESBUILD_VERSION);
  assert.deepEqual(await readFile(asset), minified);
  assert.deepEqual(gunzipSync(await readFile(`${asset}.gz`)), minified);
  assert.deepEqual(brotliDecompressSync(await readFile(`${asset}.br`)), minified);
  assert.deepEqual(await readFile(preloadFile), minifiedPreload);
  assert.deepEqual(
    gunzipSync(await readFile(`${preloadFile}.gz`)),
    minifiedPreload,
  );
  assert.deepEqual(
    brotliDecompressSync(await readFile(`${preloadFile}.br`)),
    minifiedPreload,
  );
  assert.deepEqual(await readFile(stylesheetFile), stylesheet);
  assert.deepEqual(
    gunzipSync(await readFile(`${stylesheetFile}.gz`)),
    stylesheet,
  );
  assert.deepEqual(
    brotliDecompressSync(await readFile(`${stylesheetFile}.br`)),
    stylesheet,
  );
  assert.equal((await stat(asset)).mode & 0o777, 0o640);
  assert.equal((await stat(preloadFile)).mode & 0o777, 0o640);
  assert.equal((await stat(stylesheetFile)).mode & 0o777, 0o640);
  assert.equal(result.preload_input_bytes, originalPreload.length);
  assert.equal(result.preload_output_bytes, minifiedPreload.length);
  assert.equal(result.stylesheet_bytes, stylesheet.length);
  const versionedIndex = await readFile(indexFile, "utf8");
  const outputSha256 = createHash("sha256").update(minified).digest("hex");
  const versionedUrl = versionedAssetUrl(outputSha256);
  assert.equal(result.asset_url, versionedUrl);
  assert.ok(
    versionedIndex.indexOf('<script type="importmap">') <
      versionedIndex.indexOf('<script type="module" src="./assets/preload.js">'),
  );
  assert.ok(
    versionedIndex.includes(
      `{"imports":{"./assets/app-initial-BTphDPeq.js":"${versionedUrl}"}}`,
    ),
  );
  assert.ok(versionedIndex.includes(`href="${versionedUrl}"`));
  assert.equal(
    (versionedIndex.match(/<script type="importmap">/g) ?? []).length,
    1,
  );
  assert.equal((await stat(indexFile)).mode & 0o777, 0o640);
});

test("minified asset builder rejects unpinned input and fixes the esbuild contract", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-minified-reject-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, "assets");
  await mkdir(assets);
  const asset = path.join(assets, "app-initial-BTphDPeq.js");
  const preloadFile = path.join(assets, "preload.js");
  const stylesheetFile = path.join(assets, "app-initial-Czet5G9g.css");
  const indexFile = path.join(directory, "index.html");
  const assetBytes = Buffer.from("const fixture = true;\n");
  const preloadBytes = Buffer.from("const preloadFixture = true;\n");
  const stylesheetBytes = Buffer.from("body { color: black; }\n");
  const indexBytes = Buffer.from(indexFixture());
  await writeFile(asset, assetBytes, { mode: 0o600 });
  await writeFile(preloadFile, preloadBytes, { mode: 0o600 });
  await writeFile(stylesheetFile, stylesheetBytes, { mode: 0o600 });
  await writeFile(indexFile, indexBytes, { mode: 0o600 });
  const assetSha256 = createHash("sha256").update(assetBytes).digest("hex");
  const preloadSha256 = createHash("sha256")
    .update(preloadBytes)
    .digest("hex");
  const stylesheetSha256 = createHash("sha256")
    .update(stylesheetBytes)
    .digest("hex");
  const indexSha256 = createHash("sha256").update(indexBytes).digest("hex");
  let called = false;

  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: "0".repeat(64),
      preloadFile,
      expectedPreloadSha256: preloadSha256,
      stylesheetFile,
      expectedStylesheetSha256: stylesheetSha256,
      indexFile,
      expectedIndexSha256: indexSha256,
      minify: async () => {
        called = true;
      },
    }),
    /asset build failed/,
  );
  assert.equal(called, false);
  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: assetSha256,
      preloadFile,
      expectedPreloadSha256: "0".repeat(64),
      stylesheetFile,
      expectedStylesheetSha256: stylesheetSha256,
      indexFile,
      expectedIndexSha256: indexSha256,
      minify: async () => {
        called = true;
      },
    }),
    /asset build failed/,
  );
  assert.equal(called, false);
  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: assetSha256,
      preloadFile,
      expectedPreloadSha256: preloadSha256,
      stylesheetFile,
      expectedStylesheetSha256: "0".repeat(64),
      indexFile,
      expectedIndexSha256: indexSha256,
      minify: async () => {
        called = true;
      },
    }),
    /asset build failed/,
  );
  assert.equal(called, false);
  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: assetSha256,
      preloadFile,
      expectedPreloadSha256: preloadSha256,
      stylesheetFile,
      expectedStylesheetSha256: stylesheetSha256,
      indexFile,
      expectedIndexSha256: "0".repeat(64),
      minify: async () => {
        called = true;
      },
    }),
    /asset build failed/,
  );
  assert.equal(called, false);
  const alreadyVersionedIndex = Buffer.from(
    indexFixture().replace(
      '    <script type="module" src="./assets/preload.js"></script>',
      '    <script type="importmap">{"imports":{}}</script>\n' +
        '    <script type="module" src="./assets/preload.js"></script>',
    ),
  );
  await writeFile(indexFile, alreadyVersionedIndex, { mode: 0o600 });
  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: assetSha256,
      preloadFile,
      expectedPreloadSha256: preloadSha256,
      stylesheetFile,
      expectedStylesheetSha256: stylesheetSha256,
      indexFile,
      expectedIndexSha256: createHash("sha256")
        .update(alreadyVersionedIndex)
        .digest("hex"),
      minify: async ({ outputFile }) => {
        await writeFile(outputFile, "let x=1;\n");
      },
    }),
    /asset build failed/,
  );
  assert.deepEqual(await readFile(asset), assetBytes);
  assert.deepEqual(await readFile(indexFile), alreadyVersionedIndex);
  assert.deepEqual(
    esbuildArguments("/absolute/input.js", "/absolute/output.js"),
    [
      "/absolute/input.js",
      "--minify",
      "--target=chrome120",
      "--format=esm",
      "--legal-comments=none",
      "--outfile=/absolute/output.js",
    ],
  );
  assert.equal(EXPECTED_ESBUILD_VERSION, "0.27.0");
  assert.equal(
    versionedAssetUrl("a".repeat(64)),
    "./assets/app-initial-BTphDPeq.js?v=aaaaaaaaaaaaaaaa",
  );
});
