import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

import {
  buildMinifiedPrecompressedAsset,
  esbuildArguments,
  EXPECTED_ESBUILD_VERSION,
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

test("precompressed asset patch prefers Brotli and is limited to the pinned content-hashed bundle", async () => {
  const patch = await readFile(precompressedAssetPatch, "utf8");

  assert.match(patch, /app-initial-BTphDPeq\.js/);
  assert.match(patch, /accept-encoding/);
  assert.match(patch, /acceptsEncoding/);
  assert.match(patch, /["']br["']/);
  assert.match(patch, /\.br/);
  assert.match(patch, /Content-Encoding/);
  assert.match(patch, /Vary/);
  assert.match(patch, /immutable/);
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
  const asset = path.join(directory, "app-initial-BTphDPeq.js");
  const original = Buffer.from("const intentionallyLongFixtureName = 40 + 2;\n");
  const minified = Buffer.from("const a=42;\n");
  await writeFile(asset, original, { mode: 0o640 });
  const expectedSha256 = createHash("sha256").update(original).digest("hex");

  const result = await buildMinifiedPrecompressedAsset({
    assetFile: asset,
    expectedSha256,
    minify: async ({ inputFile, outputFile }) => {
      assert.equal(inputFile, asset);
      await writeFile(outputFile, minified);
    },
  });

  assert.equal(result.input_bytes, original.length);
  assert.equal(result.output_bytes, minified.length);
  assert.equal(result.esbuild_version, EXPECTED_ESBUILD_VERSION);
  assert.deepEqual(await readFile(asset), minified);
  assert.deepEqual(gunzipSync(await readFile(`${asset}.gz`)), minified);
  assert.deepEqual(brotliDecompressSync(await readFile(`${asset}.br`)), minified);
  assert.equal((await stat(asset)).mode & 0o777, 0o640);
});

test("minified asset builder rejects unpinned input and fixes the esbuild contract", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-minified-reject-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const asset = path.join(directory, "app-initial-BTphDPeq.js");
  await writeFile(asset, "const fixture = true;\n", { mode: 0o600 });
  let called = false;

  await assert.rejects(
    buildMinifiedPrecompressedAsset({
      assetFile: asset,
      expectedSha256: "0".repeat(64),
      minify: async () => {
        called = true;
      },
    }),
    /asset build failed/,
  );
  assert.equal(called, false);
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
});
