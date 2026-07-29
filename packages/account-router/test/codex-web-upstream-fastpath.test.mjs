import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

import {
  buildMinifiedPrecompressedAsset,
  createPinnedTerserOptimizer,
  esbuildArguments,
  EXPECTED_ESBUILD_VERSION,
  EXPECTED_TERSER_ENTRY_SHA256,
  EXPECTED_TERSER_VERSION,
  MIN_TERSER_BROTLI_REDUCTION_BPS,
  terserArguments,
  versionedAssetUrl,
} from "../../../integrations/codex-web-upstream/build-minified-precompressed-asset.mjs";
import {
  inlineVersionedStartupFastpath,
  inlineVersionedStartupFastpathFile,
} from "../../../integrations/codex-web-upstream/inline-versioned-startup-fastpath.mjs";
import { localStartupRpcResponse } from "../../../integrations/codex-web-upstream/codex-remote-fastpath.mjs";

const precompressedAssetPatch = new URL(
  "../../../integrations/codex-web-upstream/tailnet-precompressed-asset.patch",
  import.meta.url,
);
const startupBackgroundPatch = new URL(
  "../../../integrations/codex-web-upstream/tailnet-startup-background.patch",
  import.meta.url,
);
const statsigLoggingPatch = new URL(
  "../../../integrations/codex-web-upstream/tailnet-statsig-logging-disabled.patch",
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

test("precompressed asset patch delegates negotiation and validators to the pinned static plugin", async (context) => {
  const patch = await readFile(precompressedAssetPatch, "utf8");

  assert.match(patch, /preCompressed:\s*true/);
  assert.match(patch, /scratch\/asar\/webview/);
  assert.match(patch, /filePath\.endsWith\(["']\.br["']\)/);
  assert.match(patch, /filePath\.endsWith\(["']\.gz["']\)/);
  assert.match(patch, /filePath\.slice\(0,\s*-3\)/);
  assert.match(patch, /setHeader\(["']Vary["'],\s*["']Accept-Encoding["']\)/);
  assert.doesNotMatch(patch, /createReadStream|acceptsEncoding|Content-Encoding/);
  assert.doesNotMatch(patch, /backend-api|responses|Authorization|Cookie/);

  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-static-patch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const serverDirectory = path.join(directory, "src", "server");
  await mkdir(serverDirectory, { recursive: true });
  await writeFile(
    path.join(serverDirectory, "main.js"),
    `    await app.register(static_1.default, {
        root: node_path_1.default.resolve(__dirname, "../../scratch/asar/webview"),
        prefix: "/",
        cacheControl: false,
        setHeaders(response, filePath) {
            response.setHeader("Cache-Control", cacheControlForWebviewFile(filePath));
        },
    });
    app.get("/", async (_request, reply) => {
`,
  );
  const dryRun = spawnSync(
    "patch",
    ["-p1", "--dry-run", "-i", fileURLToPath(precompressedAssetPatch)],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(
    dryRun.status,
    0,
    `patch dry-run failed: ${dryRun.stderr || dryRun.stdout}`,
  );
});

test("startup background patch replaces the transparent white flash without changing requests", async () => {
  const patch = await readFile(startupBackgroundPatch, "utf8");

  assert.match(patch, /--startup-background: rgb\(/);
  assert.match(patch, /prefers-color-scheme: dark/);
  assert.match(patch, /electron-dark/);
  assert.doesNotMatch(patch, /backend-api|responses|Authorization|Cookie|fetch\(/);
});

test("routed Statsig patch disables post-login event collection without changing network routes", async (context) => {
  const patch = await readFile(statsigLoggingPatch, "utf8");
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  assert.match(patch, /loggingEnabled:\s*`disabled`/);
  assert.deepEqual(additions, ["+        loggingEnabled: `disabled`,"]);
  assert.doesNotMatch(
    additions.join("\n"),
    /backend-api|responses|Authorization|Cookie|fetch\(|networkOverrideFunc:/,
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-statsig-patch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, "scratch", "asar", "webview", "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(
    path.join(assets, "app-initial-BTphDPeq.js"),
    `      (Etu = {
        overrideAdapter: window.__ELECTRON_SHIM__.overrideAdapter,
        networkConfig: {
          preventAllNetworkTraffic: true,
          api: xtu,
          logEventUrl: r9l,
          sdkExceptionUrl: Stu,
          networkOverrideFunc: Qeu,
        },
      }),
`,
  );
  const dryRun = spawnSync(
    "patch",
    ["-p1", "--dry-run", "-i", fileURLToPath(statsigLoggingPatch)],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(
    dryRun.status,
    0,
    `patch dry-run failed: ${dryRun.stderr || dryRun.stdout}`,
  );
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
  const startupFastpathFile = path.join(
    directory,
    "tailnet-startup-fastpath.js",
  );
  const original = Buffer.from(
    `const intentionallyLongFixtureName = "${"x".repeat(8192)}";\n`,
  );
  const primaryMinified = Buffer.from(
    `const a="${"x".repeat(4096)}";\n`,
  );
  const minified = Buffer.from('const a="x";\n');
  const originalPreload = Buffer.from(
    "const intentionallyLongPreloadFixtureName = 41 + 1;\n",
  );
  const minifiedPreload = Buffer.from("const p=42;\n");
  const stylesheet = Buffer.from("body { color: rgb(1, 2, 3); }\n");
  const originalIndex = Buffer.from(indexFixture());
  const startupFastpath = Buffer.from(
    "(() => { globalThis.__startupFixture = true; })();\n",
  );
  await writeFile(asset, original, { mode: 0o640 });
  await writeFile(preloadFile, originalPreload, { mode: 0o640 });
  await writeFile(stylesheetFile, stylesheet, { mode: 0o640 });
  await writeFile(indexFile, originalIndex, { mode: 0o640 });
  await writeFile(startupFastpathFile, startupFastpath, { mode: 0o640 });
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
  const expectedStartupFastpathSha256 = createHash("sha256")
    .update(startupFastpath)
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
    startupFastpathFile,
    expectedStartupFastpathSha256,
    minify: async ({ inputFile, outputFile }) => {
      if (inputFile === asset) {
        await writeFile(outputFile, primaryMinified);
        return;
      }
      assert.equal(inputFile, preloadFile);
      await writeFile(outputFile, minifiedPreload);
    },
    optimizeMain: async ({ inputFile, outputFile }) => {
      assert.notEqual(inputFile, asset);
      assert.notEqual(outputFile, asset);
      await writeFile(outputFile, minified);
    },
  });

  assert.equal(result.input_bytes, original.length);
  assert.equal(result.primary_output_bytes, primaryMinified.length);
  assert.equal(result.output_bytes, minified.length);
  assert.equal(result.esbuild_version, EXPECTED_ESBUILD_VERSION);
  assert.equal(result.terser_version, EXPECTED_TERSER_VERSION);
  assert.ok(result.primary_gzip_bytes > result.gzip_bytes);
  assert.ok(result.primary_brotli_bytes > result.brotli_bytes);
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
  assert.equal(result.startup_fastpath_bytes, startupFastpath.length);
  assert.equal(
    result.startup_fastpath_sha256,
    expectedStartupFastpathSha256,
  );
  const versionedIndex = await readFile(indexFile, "utf8");
  assert.deepEqual(
    gunzipSync(await readFile(`${indexFile}.gz`)),
    Buffer.from(versionedIndex),
  );
  assert.deepEqual(
    brotliDecompressSync(await readFile(`${indexFile}.br`)),
    Buffer.from(versionedIndex),
  );
  assert.ok(result.index_gzip_bytes > 0);
  assert.ok(result.index_gzip_bytes < Buffer.byteLength(versionedIndex));
  assert.ok(result.index_brotli_bytes > 0);
  assert.ok(result.index_brotli_bytes < result.index_gzip_bytes);
  assert.equal((await stat(`${indexFile}.gz`)).mode & 0o777, 0o640);
  assert.equal((await stat(`${indexFile}.br`)).mode & 0o777, 0o640);
  const outputSha256 = createHash("sha256").update(minified).digest("hex");
  const versionedUrl = versionedAssetUrl(outputSha256);
  assert.equal(result.asset_url, versionedUrl);
  assert.ok(
    versionedIndex.indexOf('<script type="importmap">') <
      versionedIndex.indexOf('<script type="module" src="./assets/preload.js">'),
  );
  assert.ok(
    versionedIndex.indexOf('<script type="importmap">') <
      versionedIndex.indexOf(`href="${versionedUrl}"`),
  );
  assert.ok(
    versionedIndex.indexOf(`href="${versionedUrl}"`) <
      versionedIndex.indexOf(
        '<script data-codex-tailnet-startup-fastpath>',
      ),
  );
  assert.ok(
    versionedIndex.indexOf(
      '<script data-codex-tailnet-startup-fastpath>',
    ) <
      versionedIndex.indexOf(
        '<script type="module" src="./assets/preload.js">',
      ),
  );
  assert.match(versionedIndex, /globalThis\.__startupFixture = true/);
  assert.doesNotMatch(
    versionedIndex,
    /<script src="\.\/tailnet-startup-fastpath\.js"><\/script>/,
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
  assert.equal(
    versionedIndex.split(versionedUrl).length - 1,
    2,
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
  const startupFastpathFile = path.join(
    directory,
    "tailnet-startup-fastpath.js",
  );
  const assetBytes = Buffer.from("const fixture = true;\n");
  const preloadBytes = Buffer.from("const preloadFixture = true;\n");
  const stylesheetBytes = Buffer.from("body { color: black; }\n");
  const indexBytes = Buffer.from(indexFixture());
  const startupFastpathBytes = Buffer.from("(() => {})();\n");
  await writeFile(asset, assetBytes, { mode: 0o600 });
  await writeFile(preloadFile, preloadBytes, { mode: 0o600 });
  await writeFile(stylesheetFile, stylesheetBytes, { mode: 0o600 });
  await writeFile(indexFile, indexBytes, { mode: 0o600 });
  await writeFile(startupFastpathFile, startupFastpathBytes, { mode: 0o600 });
  const assetSha256 = createHash("sha256").update(assetBytes).digest("hex");
  const preloadSha256 = createHash("sha256")
    .update(preloadBytes)
    .digest("hex");
  const stylesheetSha256 = createHash("sha256")
    .update(stylesheetBytes)
    .digest("hex");
  const indexSha256 = createHash("sha256").update(indexBytes).digest("hex");
  const startupFastpathSha256 = createHash("sha256")
    .update(startupFastpathBytes)
    .digest("hex");
  const pinnedStartupFastpath = {
    startupFastpathFile,
    expectedStartupFastpathSha256: startupFastpathSha256,
  };
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
      ...pinnedStartupFastpath,
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
      ...pinnedStartupFastpath,
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
      ...pinnedStartupFastpath,
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
      ...pinnedStartupFastpath,
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
      expectedIndexSha256: indexSha256,
      startupFastpathFile,
      expectedStartupFastpathSha256: "0".repeat(64),
      minify: async () => {
        called = true;
      },
    }),
    /asset build failed/,
  );
  assert.equal(called, false);
  const unsafeStartupFastpath = Buffer.from(
    '(() => { globalThis.fixture = "</script>"; })();\n',
  );
  await writeFile(startupFastpathFile, unsafeStartupFastpath, {
    mode: 0o600,
  });
  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: assetSha256,
      preloadFile,
      expectedPreloadSha256: preloadSha256,
      stylesheetFile,
      expectedStylesheetSha256: stylesheetSha256,
      indexFile,
      expectedIndexSha256: indexSha256,
      startupFastpathFile,
      expectedStartupFastpathSha256: createHash("sha256")
        .update(unsafeStartupFastpath)
        .digest("hex"),
      minify: async ({ outputFile }) => {
        await writeFile(outputFile, "let x=1;\n");
      },
    }),
    /asset build failed/,
  );
  await writeFile(startupFastpathFile, startupFastpathBytes, { mode: 0o600 });
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
      ...pinnedStartupFastpath,
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
  assert.deepEqual(
    terserArguments("/absolute/input.js", "/absolute/output.js"),
    [
      "/absolute/input.js",
      "--module",
      "--ecma",
      "2022",
      "--compress",
      "passes=2",
      "--mangle",
      "--output",
      "/absolute/output.js",
    ],
  );
  assert.equal(EXPECTED_ESBUILD_VERSION, "0.27.0");
  assert.equal(EXPECTED_TERSER_VERSION, "5.49.0");
  assert.equal(
    EXPECTED_TERSER_ENTRY_SHA256,
    "312a3f9b37d3f5316ee384bfdc347313dae6f0f9056c44b3cae56c8e4e9f4496",
  );
  assert.equal(MIN_TERSER_BROTLI_REDUCTION_BPS, 100);
  assert.equal(
    versionedAssetUrl("a".repeat(64)),
    "./assets/app-initial-BTphDPeq.js?v=aaaaaaaaaaaaaaaa",
  );
});

test("pinned Terser optimizer rejects an untrusted entry before execution", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codex-terser-entry-reject-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const terserFile = path.join(directory, "terser");
  const inputFile = path.join(directory, "input.js");
  const outputFile = path.join(directory, "output.js");
  await writeFile(
    terserFile,
    '#!/usr/bin/env node\nprocess.stdout.write("terser 5.49.0\\n");\n',
    { mode: 0o700 },
  );
  await writeFile(inputFile, "const fixture = true;\n", { mode: 0o600 });

  await assert.rejects(
    createPinnedTerserOptimizer(terserFile)({ inputFile, outputFile }),
    /terser entry hash is not pinned/,
  );
  await assert.rejects(stat(outputFile), /ENOENT/);
});

test("atomically inlines a pinned startup fastpath into an already-versioned index", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codex-versioned-startup-inline-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const indexFile = path.join(directory, "index.html");
  const startupFastpathFile = path.join(
    directory,
    "tailnet-startup-fastpath.js",
  );
  const versionedUrl =
    "./assets/app-initial-BTphDPeq.js?v=aaaaaaaaaaaaaaaa";
  const startupFastpath = Buffer.from(
    "(() => { globalThis.__versionedStartupFixture = true; })();\n",
  );
  const versionedIndex = Buffer.from(
    indexFixture()
      .replace(
        [
          "    <link",
          '      rel="modulepreload"',
          "      crossorigin",
          '      href="./assets/app-initial-BTphDPeq.js"',
          "    />",
          "",
        ].join("\n"),
        "",
      )
      .replace(
        '    <script src="./tailnet-startup-fastpath.js"></script>',
        [
          '    <script type="importmap">',
          `      {"imports":{"./assets/app-initial-BTphDPeq.js":"${versionedUrl}"}}`,
          "    </script>",
          "    <link",
          '      rel="modulepreload"',
          "      crossorigin",
          `      href="${versionedUrl}"`,
          "    />",
          '    <script src="./tailnet-startup-fastpath.js"></script>',
        ].join("\n"),
      ),
  );
  await writeFile(indexFile, versionedIndex, { mode: 0o640 });
  await writeFile(startupFastpathFile, startupFastpath, { mode: 0o640 });
  const indexSha256 = createHash("sha256")
    .update(versionedIndex)
    .digest("hex");
  const startupFastpathSha256 = createHash("sha256")
    .update(startupFastpath)
    .digest("hex");

  await assert.rejects(
    inlineVersionedStartupFastpathFile({
      indexFile,
      expectedIndexSha256: "0".repeat(64),
      startupFastpathFile,
      expectedStartupFastpathSha256: startupFastpathSha256,
    }),
    /versioned startup inline failed/,
  );
  assert.deepEqual(await readFile(indexFile), versionedIndex);
  assert.throws(
    () =>
      inlineVersionedStartupFastpath(
        Buffer.from(
          versionedIndex
            .toString("utf8")
            .replace(
              [
                '    <script src="./tailnet-startup-fastpath.js"></script>',
                '    <script type="module" src="./assets/preload.js"></script>',
              ].join("\n"),
              [
                '    <script type="module" src="./assets/preload.js"></script>',
                '    <script src="./tailnet-startup-fastpath.js"></script>',
              ].join("\n"),
            ),
        ),
        startupFastpath,
      ),
    /versioned startup order is invalid/,
  );

  const result = await inlineVersionedStartupFastpathFile({
    indexFile,
    expectedIndexSha256: indexSha256,
    startupFastpathFile,
    expectedStartupFastpathSha256: startupFastpathSha256,
  });

  const output = await readFile(indexFile, "utf8");
  assert.deepEqual(
    gunzipSync(await readFile(`${indexFile}.gz`)),
    Buffer.from(output),
  );
  assert.deepEqual(
    brotliDecompressSync(await readFile(`${indexFile}.br`)),
    Buffer.from(output),
  );
  assert.ok(result.index_gzip_bytes > 0);
  assert.ok(result.index_gzip_bytes < Buffer.byteLength(output));
  assert.ok(result.index_brotli_bytes > 0);
  assert.ok(result.index_brotli_bytes < result.index_gzip_bytes);
  assert.equal((await stat(`${indexFile}.gz`)).mode & 0o777, 0o640);
  assert.equal((await stat(`${indexFile}.br`)).mode & 0o777, 0o640);
  assert.equal(result.event, "versioned_startup_fastpath_inlined");
  assert.equal(result.asset_url, versionedUrl);
  assert.equal(result.startup_fastpath_bytes, startupFastpath.length);
  assert.equal(
    (output.match(/data-codex-tailnet-startup-fastpath/g) ?? []).length,
    1,
  );
  assert.match(output, /globalThis\.__versionedStartupFixture = true/);
  assert.doesNotMatch(
    output,
    /<script src="\.\/tailnet-startup-fastpath\.js"><\/script>/,
  );
  assert.ok(
    output.indexOf(`href="${versionedUrl}"`) <
      output.indexOf("data-codex-tailnet-startup-fastpath"),
  );
  assert.ok(
    output.indexOf("data-codex-tailnet-startup-fastpath") <
      output.indexOf('<script type="module" src="./assets/preload.js">'),
  );
  assert.equal((await stat(indexFile)).mode & 0o777, 0o640);
  await assert.rejects(
    inlineVersionedStartupFastpathFile({
      indexFile,
      expectedIndexSha256: result.index_output_sha256,
      startupFastpathFile,
      expectedStartupFastpathSha256: startupFastpathSha256,
    }),
    /versioned startup inline failed/,
  );
  assert.equal(
    createHash("sha256").update(await readFile(indexFile)).digest("hex"),
    result.index_output_sha256,
  );
});
