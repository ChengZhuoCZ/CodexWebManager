#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

export const EXPECTED_ESBUILD_VERSION = "0.27.0";
export const EXPECTED_TERSER_VERSION = "5.49.0";
export const EXPECTED_TERSER_ENTRY_SHA256 =
  "312a3f9b37d3f5316ee384bfdc347313dae6f0f9056c44b3cae56c8e4e9f4496";
export const MIN_TERSER_BROTLI_REDUCTION_BPS = 100;

const ASSET_NAME = "app-initial-BTphDPeq.js";
const ASSET_URL = `./assets/${ASSET_NAME}`;
const PRELOAD_NAME = "preload.js";
const STYLESHEET_NAME = "app-initial-Czet5G9g.css";
const INDEX_NAME = "index.html";
const STARTUP_FASTPATH_NAME = "tailnet-startup-fastpath.js";
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_STARTUP_FASTPATH_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_TIMEOUT_MS = 120_000;
const PRELOAD_URL = `./assets/${PRELOAD_NAME}`;
const PRELOAD_MODULE_SCRIPT = preloadModuleScript(PRELOAD_URL);
const STARTUP_FASTPATH_SCRIPT =
  '    <script src="./tailnet-startup-fastpath.js"></script>';
const INLINE_STARTUP_FASTPATH_MARKER =
  "    <script data-codex-tailnet-startup-fastpath>";

function modulePreloadBlock(assetUrl) {
  return [
    "    <link",
    '      rel="modulepreload"',
    "      crossorigin",
    `      href="${assetUrl}"`,
    "    />",
  ].join("\n");
}

function preloadModuleScript(preloadUrl) {
  return `    <script type="module" src="${preloadUrl}"></script>`;
}

const MAIN_MODULE_PRELOAD_BLOCK = modulePreloadBlock(ASSET_URL);

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return value;
}

export function esbuildArguments(inputFile, outputFile) {
  const input = assertAbsolute(inputFile, "esbuild input");
  const output = assertAbsolute(outputFile, "esbuild output");
  return [
    input,
    "--minify",
    "--target=chrome120",
    "--format=esm",
    "--legal-comments=none",
    `--outfile=${output}`,
  ];
}

export function terserArguments(inputFile, outputFile) {
  const input = assertAbsolute(inputFile, "terser input");
  const output = assertAbsolute(outputFile, "terser output");
  return [
    input,
    "--module",
    "--ecma",
    "2022",
    "--compress",
    "passes=2",
    "--mangle",
    "--output",
    output,
  ];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function versionedAssetUrl(outputSha256) {
  if (
    typeof outputSha256 !== "string" ||
    !SHA256_PATTERN.test(outputSha256)
  ) {
    throw new Error("asset output hash is invalid");
  }
  return `${ASSET_URL}?v=${outputSha256.slice(0, 16)}`;
}

export function versionedPreloadUrl(outputSha256) {
  if (
    typeof outputSha256 !== "string" ||
    !SHA256_PATTERN.test(outputSha256)
  ) {
    throw new Error("preload output hash is invalid");
  }
  return `./assets/preload-${outputSha256.slice(0, 8)}.js`;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function inlineStartupFastpath(startupFastpathBytes) {
  const source = startupFastpathBytes.toString("utf8");
  if (
    !Buffer.from(source).equals(startupFastpathBytes) ||
    /<\/script/iu.test(source)
  ) {
    throw new Error("startup fastpath inline boundary is invalid");
  }
  return [
    INLINE_STARTUP_FASTPATH_MARKER,
    source.trimEnd(),
    "    </script>",
  ].join("\n");
}

function versionIndex(
  indexBytes,
  outputSha256,
  preloadOutputSha256,
  startupFastpathBytes,
) {
  const index = indexBytes.toString("utf8");
  if (
    !Buffer.from(index).equals(indexBytes) ||
    countOccurrences(index, PRELOAD_MODULE_SCRIPT) !== 1 ||
    countOccurrences(index, STARTUP_FASTPATH_SCRIPT) !== 1 ||
    countOccurrences(index, `${MAIN_MODULE_PRELOAD_BLOCK}\n`) !== 1 ||
    index.includes(INLINE_STARTUP_FASTPATH_MARKER) ||
    index.includes('<script type="importmap">') ||
    index.includes(`${ASSET_URL}?v=`)
  ) {
    throw new Error("index boundary is invalid");
  }
  const assetUrl = versionedAssetUrl(outputSha256);
  const preloadUrl = versionedPreloadUrl(preloadOutputSha256);
  const importMap = [
    '    <script type="importmap">',
    `      ${JSON.stringify({ imports: { [ASSET_URL]: assetUrl } })}`,
    "    </script>",
  ].join("\n");
  const earlyMainModuleHint = [
    importMap,
    modulePreloadBlock(assetUrl),
    inlineStartupFastpath(startupFastpathBytes),
  ].join("\n");
  return Object.freeze({
    assetUrl,
    preloadUrl,
    bytes: Buffer.from(
      index
        .replace(`${MAIN_MODULE_PRELOAD_BLOCK}\n`, "")
        .replace(STARTUP_FASTPATH_SCRIPT, earlyMainModuleHint)
        .replace(PRELOAD_MODULE_SCRIPT, preloadModuleScript(preloadUrl)),
    ),
  });
}

async function readRegularFile(filePath, { maximum = MAX_ASSET_BYTES } = {}) {
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maximum ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("asset file boundary is invalid");
    }
    return Object.freeze({ bytes: await handle.readFile(), stat });
  } finally {
    await handle?.close();
  }
}

function run(executable, argumentsList, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let outputBytes = 0;
    const child = spawn(executable, argumentsList, {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("asset command timed out"));
    }, OPERATION_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4_096) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("asset command failed"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || outputBytes > 4_096) {
        reject(new Error("asset command failed"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export function createPinnedEsbuildMinifier(esbuildFile) {
  const executable = assertAbsolute(esbuildFile, "esbuild executable");
  let versionChecked = false;
  return async ({ inputFile, outputFile }) => {
    if (!versionChecked) {
      const version = await run(executable, ["--version"], { captureStdout: true });
      if (version !== EXPECTED_ESBUILD_VERSION) {
        throw new Error("esbuild version is not pinned");
      }
      versionChecked = true;
    }
    await run(executable, esbuildArguments(inputFile, outputFile));
  };
}

export function createPinnedTerserOptimizer(terserFile) {
  const executable = assertAbsolute(terserFile, "terser executable");
  let versionChecked = false;
  return async ({ inputFile, outputFile }) => {
    if (!versionChecked) {
      const entry = await readRegularFile(executable, {
        maximum: 4 * 1024 * 1024,
      });
      if (sha256(entry.bytes) !== EXPECTED_TERSER_ENTRY_SHA256) {
        throw new Error("terser entry hash is not pinned");
      }
      const version = await run(
        process.execPath,
        [executable, "--version"],
        { captureStdout: true },
      );
      if (version !== `terser ${EXPECTED_TERSER_VERSION}`) {
        throw new Error("terser version is not pinned");
      }
      versionChecked = true;
    }
    await run(
      process.execPath,
      [executable, ...terserArguments(inputFile, outputFile)],
    );
  };
}

async function writeTemporary(filePath, bytes, mode) {
  await fs.writeFile(filePath, bytes, {
    flag: "wx",
    mode,
  });
  await fs.chmod(filePath, mode);
}

function precompress(bytes) {
  return Object.freeze({
    gzip: gzipSync(bytes, { level: 9 }),
    brotli: brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
  });
}

export async function buildMinifiedPrecompressedAsset({
  assetFile,
  expectedSha256,
  preloadFile,
  expectedPreloadSha256,
  stylesheetFile,
  expectedStylesheetSha256,
  indexFile,
  expectedIndexSha256,
  startupFastpathFile,
  expectedStartupFastpathSha256,
  minify,
  optimizeMain,
} = {}) {
  const temporaryFiles = [];
  try {
    const asset = assertAbsolute(assetFile, "asset file");
    const preload = assertAbsolute(preloadFile, "preload file");
    const stylesheet = assertAbsolute(stylesheetFile, "stylesheet file");
    const index = assertAbsolute(indexFile, "index file");
    const startupFastpath = assertAbsolute(
      startupFastpathFile,
      "startup fastpath file",
    );
    const assetsDirectory = path.dirname(asset);
    if (
      path.basename(asset) !== ASSET_NAME ||
      path.basename(preload) !== PRELOAD_NAME ||
      path.basename(stylesheet) !== STYLESHEET_NAME ||
      path.basename(index) !== INDEX_NAME ||
      path.dirname(preload) !== assetsDirectory ||
      path.dirname(stylesheet) !== assetsDirectory ||
      path.resolve(path.dirname(index), "assets", ASSET_NAME) !== asset ||
      path.resolve(path.dirname(index), STARTUP_FASTPATH_NAME) !==
        startupFastpath ||
      typeof expectedSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedSha256) ||
      typeof expectedPreloadSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedPreloadSha256) ||
      typeof expectedStylesheetSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedStylesheetSha256) ||
      typeof expectedIndexSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedIndexSha256) ||
      typeof expectedStartupFastpathSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedStartupFastpathSha256) ||
      typeof minify !== "function" ||
      (optimizeMain !== undefined && typeof optimizeMain !== "function")
    ) {
      throw new Error("asset build input is invalid");
    }
    const input = await readRegularFile(asset);
    const preloadInput = await readRegularFile(preload);
    const stylesheetInput = await readRegularFile(stylesheet);
    const indexInput = await readRegularFile(index, { maximum: MAX_INDEX_BYTES });
    const startupFastpathInput = await readRegularFile(startupFastpath, {
      maximum: MAX_STARTUP_FASTPATH_BYTES,
    });
    if (sha256(input.bytes) !== expectedSha256) {
      throw new Error("asset input hash changed");
    }
    if (sha256(preloadInput.bytes) !== expectedPreloadSha256) {
      throw new Error("preload input hash changed");
    }
    if (sha256(stylesheetInput.bytes) !== expectedStylesheetSha256) {
      throw new Error("stylesheet input hash changed");
    }
    if (sha256(indexInput.bytes) !== expectedIndexSha256) {
      throw new Error("index input hash changed");
    }
    if (
      sha256(startupFastpathInput.bytes) !== expectedStartupFastpathSha256
    ) {
      throw new Error("startup fastpath input hash changed");
    }
    await run(process.execPath, ["--check", startupFastpath]);

    const nonce = randomUUID();
    // Keep the final suffix as .js so `node --check` uses the ESM syntax path.
    const temporaryAsset = path.join(path.dirname(asset), `.${ASSET_NAME}.${nonce}.next.js`);
    const temporaryOptimizedAsset = path.join(
      path.dirname(asset),
      `.${ASSET_NAME}.${nonce}.optimized.js`,
    );
    const temporaryGzip = `${temporaryAsset}.gz`;
    const temporaryBrotli = `${temporaryAsset}.br`;
    const temporaryPreload = path.join(
      assetsDirectory,
      `.${PRELOAD_NAME}.${nonce}.next.js`,
    );
    const temporaryPreloadGzip = `${temporaryPreload}.gz`;
    const temporaryPreloadBrotli = `${temporaryPreload}.br`;
    const temporaryStylesheetGzip = path.join(
      assetsDirectory,
      `.${STYLESHEET_NAME}.${nonce}.next.gz`,
    );
    const temporaryStylesheetBrotli = path.join(
      assetsDirectory,
      `.${STYLESHEET_NAME}.${nonce}.next.br`,
    );
    const temporaryIndex = path.join(path.dirname(index), `.${INDEX_NAME}.${nonce}.next`);
    const temporaryIndexGzip = `${temporaryIndex}.gz`;
    const temporaryIndexBrotli = `${temporaryIndex}.br`;
    temporaryFiles.push(
      temporaryAsset,
      temporaryOptimizedAsset,
      temporaryGzip,
      temporaryBrotli,
      temporaryPreload,
      temporaryPreloadGzip,
      temporaryPreloadBrotli,
      temporaryStylesheetGzip,
      temporaryStylesheetBrotli,
      temporaryIndex,
      temporaryIndexGzip,
      temporaryIndexBrotli,
    );

    await minify({ inputFile: asset, outputFile: temporaryAsset });
    const primaryOutput = await readRegularFile(temporaryAsset);
    if (primaryOutput.bytes.length >= input.bytes.length) {
      throw new Error("minified asset is not smaller");
    }
    await run(process.execPath, ["--check", temporaryAsset]);
    let finalAsset = temporaryAsset;
    let output = primaryOutput;
    let primaryCompressed;
    if (optimizeMain !== undefined) {
      await optimizeMain({
        inputFile: temporaryAsset,
        outputFile: temporaryOptimizedAsset,
      });
      const optimizedOutput = await readRegularFile(temporaryOptimizedAsset);
      await run(process.execPath, ["--check", temporaryOptimizedAsset]);
      primaryCompressed = precompress(primaryOutput.bytes);
      const optimizedCompressed = precompress(optimizedOutput.bytes);
      const brotliReduction =
        primaryCompressed.brotli.length - optimizedCompressed.brotli.length;
      if (
        optimizedOutput.bytes.length >= primaryOutput.bytes.length ||
        optimizedCompressed.gzip.length >= primaryCompressed.gzip.length ||
        brotliReduction <= 0 ||
        brotliReduction * 10_000 <
          primaryCompressed.brotli.length *
            MIN_TERSER_BROTLI_REDUCTION_BPS
      ) {
        throw new Error("optimized asset reduction is insufficient");
      }
      finalAsset = temporaryOptimizedAsset;
      output = optimizedOutput;
    }

    await minify({ inputFile: preload, outputFile: temporaryPreload });
    const preloadOutput = await readRegularFile(temporaryPreload);
    if (preloadOutput.bytes.length >= preloadInput.bytes.length) {
      throw new Error("minified preload is not smaller");
    }
    await run(process.execPath, ["--check", temporaryPreload]);

    const outputSha256 = sha256(output.bytes);
    const preloadOutputSha256 = sha256(preloadOutput.bytes);
    const preloadUrl = versionedPreloadUrl(preloadOutputSha256);
    const versionedPreload = path.resolve(path.dirname(index), preloadUrl);
    if (
      path.dirname(versionedPreload) !== assetsDirectory ||
      path.basename(versionedPreload) !==
        `preload-${preloadOutputSha256.slice(0, 8)}.js`
    ) {
      throw new Error("versioned preload boundary is invalid");
    }
    const temporaryVersionedPreload = path.join(
      assetsDirectory,
      `.${path.basename(versionedPreload)}.${nonce}.next.js`,
    );
    const temporaryVersionedPreloadGzip = `${temporaryVersionedPreload}.gz`;
    const temporaryVersionedPreloadBrotli = `${temporaryVersionedPreload}.br`;
    temporaryFiles.push(
      temporaryVersionedPreload,
      temporaryVersionedPreloadGzip,
      temporaryVersionedPreloadBrotli,
    );
    const versionedIndex = versionIndex(
      indexInput.bytes,
      outputSha256,
      preloadOutputSha256,
      startupFastpathInput.bytes,
    );
    const mode = input.stat.mode & 0o777;
    const preloadMode = preloadInput.stat.mode & 0o777;
    const stylesheetMode = stylesheetInput.stat.mode & 0o777;
    const indexMode = indexInput.stat.mode & 0o777;
    const compressed = precompress(output.bytes);
    const compressedPreload = precompress(preloadOutput.bytes);
    const compressedStylesheet = precompress(stylesheetInput.bytes);
    const compressedIndex = precompress(versionedIndex.bytes);
    await writeTemporary(temporaryGzip, compressed.gzip, mode);
    await writeTemporary(temporaryBrotli, compressed.brotli, mode);
    await writeTemporary(
      temporaryPreloadGzip,
      compressedPreload.gzip,
      preloadMode,
    );
    await writeTemporary(
      temporaryPreloadBrotli,
      compressedPreload.brotli,
      preloadMode,
    );
    await writeTemporary(
      temporaryVersionedPreload,
      preloadOutput.bytes,
      preloadMode,
    );
    await writeTemporary(
      temporaryVersionedPreloadGzip,
      compressedPreload.gzip,
      preloadMode,
    );
    await writeTemporary(
      temporaryVersionedPreloadBrotli,
      compressedPreload.brotli,
      preloadMode,
    );
    await writeTemporary(
      temporaryStylesheetGzip,
      compressedStylesheet.gzip,
      stylesheetMode,
    );
    await writeTemporary(
      temporaryStylesheetBrotli,
      compressedStylesheet.brotli,
      stylesheetMode,
    );
    await writeTemporary(
      temporaryIndexGzip,
      compressedIndex.gzip,
      indexMode,
    );
    await writeTemporary(
      temporaryIndexBrotli,
      compressedIndex.brotli,
      indexMode,
    );
    await writeTemporary(temporaryIndex, versionedIndex.bytes, indexMode);

    await fs.rename(temporaryGzip, `${asset}.gz`);
    await fs.rename(temporaryBrotli, `${asset}.br`);
    await fs.rename(temporaryPreloadGzip, `${preload}.gz`);
    await fs.rename(temporaryPreloadBrotli, `${preload}.br`);
    await fs.rename(temporaryVersionedPreloadGzip, `${versionedPreload}.gz`);
    await fs.rename(
      temporaryVersionedPreloadBrotli,
      `${versionedPreload}.br`,
    );
    await fs.rename(temporaryVersionedPreload, versionedPreload);
    await fs.rename(temporaryStylesheetGzip, `${stylesheet}.gz`);
    await fs.rename(temporaryStylesheetBrotli, `${stylesheet}.br`);
    await fs.rename(temporaryIndexGzip, `${index}.gz`);
    await fs.rename(temporaryIndexBrotli, `${index}.br`);
    await fs.chmod(finalAsset, mode);
    await fs.rename(finalAsset, asset);
    await fs.chmod(temporaryPreload, preloadMode);
    await fs.rename(temporaryPreload, preload);
    await fs.rename(temporaryIndex, index);

    return Object.freeze({
      event: "minified_precompressed_asset_built",
      esbuild_version: EXPECTED_ESBUILD_VERSION,
      terser_version:
        optimizeMain === undefined ? null : EXPECTED_TERSER_VERSION,
      asset_url: versionedIndex.assetUrl,
      preload_url: versionedIndex.preloadUrl,
      input_sha256: expectedSha256,
      output_sha256: outputSha256,
      index_input_sha256: expectedIndexSha256,
      index_output_sha256: sha256(versionedIndex.bytes),
      startup_fastpath_sha256: expectedStartupFastpathSha256,
      preload_input_sha256: expectedPreloadSha256,
      preload_output_sha256: preloadOutputSha256,
      stylesheet_sha256: expectedStylesheetSha256,
      input_bytes: input.bytes.length,
      primary_output_bytes: primaryOutput.bytes.length,
      output_bytes: output.bytes.length,
      primary_gzip_bytes: primaryCompressed?.gzip.length ?? compressed.gzip.length,
      primary_brotli_bytes:
        primaryCompressed?.brotli.length ?? compressed.brotli.length,
      index_input_bytes: indexInput.bytes.length,
      index_output_bytes: versionedIndex.bytes.length,
      index_gzip_bytes: compressedIndex.gzip.length,
      index_brotli_bytes: compressedIndex.brotli.length,
      index_gzip_sha256: sha256(compressedIndex.gzip),
      index_brotli_sha256: sha256(compressedIndex.brotli),
      startup_fastpath_bytes: startupFastpathInput.bytes.length,
      gzip_bytes: compressed.gzip.length,
      brotli_bytes: compressed.brotli.length,
      preload_input_bytes: preloadInput.bytes.length,
      preload_output_bytes: preloadOutput.bytes.length,
      preload_gzip_bytes: compressedPreload.gzip.length,
      preload_brotli_bytes: compressedPreload.brotli.length,
      stylesheet_bytes: stylesheetInput.bytes.length,
      stylesheet_gzip_bytes: compressedStylesheet.gzip.length,
      stylesheet_brotli_bytes: compressedStylesheet.brotli.length,
    });
  } catch {
    throw new Error("asset build failed");
  } finally {
    await Promise.all(
      temporaryFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})),
    );
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !new Set([
        "--asset",
        "--esbuild",
        "--terser",
        "--expected-sha256",
        "--preload",
        "--expected-preload-sha256",
        "--stylesheet",
        "--expected-stylesheet-sha256",
        "--index",
        "--expected-index-sha256",
        "--startup-fastpath",
        "--expected-startup-fastpath-sha256",
      ]).has(option) ||
      typeof value !== "string" ||
      values.has(option)
    ) {
      throw new Error("asset build option is invalid");
    }
    values.set(option, value);
  }
  for (const required of [
    "--asset",
    "--esbuild",
    "--expected-sha256",
    "--preload",
    "--expected-preload-sha256",
    "--stylesheet",
    "--expected-stylesheet-sha256",
    "--index",
    "--expected-index-sha256",
    "--startup-fastpath",
    "--expected-startup-fastpath-sha256",
  ]) {
    if (!values.has(required)) throw new Error("asset build command is incomplete");
  }
  return Object.freeze({
    assetFile: values.get("--asset"),
    esbuildFile: values.get("--esbuild"),
    terserFile: values.get("--terser"),
    expectedSha256: values.get("--expected-sha256"),
    preloadFile: values.get("--preload"),
    expectedPreloadSha256: values.get("--expected-preload-sha256"),
    stylesheetFile: values.get("--stylesheet"),
    expectedStylesheetSha256: values.get("--expected-stylesheet-sha256"),
    indexFile: values.get("--index"),
    expectedIndexSha256: values.get("--expected-index-sha256"),
    startupFastpathFile: values.get("--startup-fastpath"),
    expectedStartupFastpathSha256: values.get(
      "--expected-startup-fastpath-sha256",
    ),
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await buildMinifiedPrecompressedAsset({
    assetFile: options.assetFile,
    expectedSha256: options.expectedSha256,
    preloadFile: options.preloadFile,
    expectedPreloadSha256: options.expectedPreloadSha256,
    stylesheetFile: options.stylesheetFile,
    expectedStylesheetSha256: options.expectedStylesheetSha256,
    indexFile: options.indexFile,
    expectedIndexSha256: options.expectedIndexSha256,
    startupFastpathFile: options.startupFastpathFile,
    expectedStartupFastpathSha256:
      options.expectedStartupFastpathSha256,
    minify: createPinnedEsbuildMinifier(options.esbuildFile),
    optimizeMain:
      options.terserFile === undefined
        ? undefined
        : createPinnedTerserOptimizer(options.terserFile),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write("asset build failed\n");
    process.exitCode = 1;
  });
}
