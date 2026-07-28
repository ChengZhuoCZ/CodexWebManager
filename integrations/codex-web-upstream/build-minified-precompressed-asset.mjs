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

const ASSET_NAME = "app-initial-BTphDPeq.js";
const ASSET_URL = `./assets/${ASSET_NAME}`;
const PRELOAD_NAME = "preload.js";
const STYLESHEET_NAME = "app-initial-Czet5G9g.css";
const INDEX_NAME = "index.html";
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_TIMEOUT_MS = 120_000;
const PRELOAD_MODULE_SCRIPT =
  '    <script type="module" src="./assets/preload.js"></script>';
const MAIN_MODULE_PRELOAD_HREF = `href="${ASSET_URL}"`;

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

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function versionIndex(indexBytes, outputSha256) {
  const index = indexBytes.toString("utf8");
  if (
    !Buffer.from(index).equals(indexBytes) ||
    countOccurrences(index, PRELOAD_MODULE_SCRIPT) !== 1 ||
    countOccurrences(index, MAIN_MODULE_PRELOAD_HREF) !== 1 ||
    index.includes('<script type="importmap">') ||
    index.includes(`${ASSET_URL}?v=`)
  ) {
    throw new Error("index boundary is invalid");
  }
  const assetUrl = versionedAssetUrl(outputSha256);
  const importMap = [
    '    <script type="importmap">',
    `      ${JSON.stringify({ imports: { [ASSET_URL]: assetUrl } })}`,
    "    </script>",
    "",
  ].join("\n");
  return Object.freeze({
    assetUrl,
    bytes: Buffer.from(
      index
        .replace(PRELOAD_MODULE_SCRIPT, `${importMap}${PRELOAD_MODULE_SCRIPT}`)
        .replace(MAIN_MODULE_PRELOAD_HREF, `href="${assetUrl}"`),
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
  minify,
} = {}) {
  const temporaryFiles = [];
  try {
    const asset = assertAbsolute(assetFile, "asset file");
    const preload = assertAbsolute(preloadFile, "preload file");
    const stylesheet = assertAbsolute(stylesheetFile, "stylesheet file");
    const index = assertAbsolute(indexFile, "index file");
    const assetsDirectory = path.dirname(asset);
    if (
      path.basename(asset) !== ASSET_NAME ||
      path.basename(preload) !== PRELOAD_NAME ||
      path.basename(stylesheet) !== STYLESHEET_NAME ||
      path.basename(index) !== INDEX_NAME ||
      path.dirname(preload) !== assetsDirectory ||
      path.dirname(stylesheet) !== assetsDirectory ||
      path.resolve(path.dirname(index), "assets", ASSET_NAME) !== asset ||
      typeof expectedSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedSha256) ||
      typeof expectedPreloadSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedPreloadSha256) ||
      typeof expectedStylesheetSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedStylesheetSha256) ||
      typeof expectedIndexSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedIndexSha256) ||
      typeof minify !== "function"
    ) {
      throw new Error("asset build input is invalid");
    }
    const input = await readRegularFile(asset);
    const preloadInput = await readRegularFile(preload);
    const stylesheetInput = await readRegularFile(stylesheet);
    const indexInput = await readRegularFile(index, { maximum: MAX_INDEX_BYTES });
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

    const nonce = randomUUID();
    // Keep the final suffix as .js so `node --check` uses the ESM syntax path.
    const temporaryAsset = path.join(path.dirname(asset), `.${ASSET_NAME}.${nonce}.next.js`);
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
    temporaryFiles.push(
      temporaryAsset,
      temporaryGzip,
      temporaryBrotli,
      temporaryPreload,
      temporaryPreloadGzip,
      temporaryPreloadBrotli,
      temporaryStylesheetGzip,
      temporaryStylesheetBrotli,
      temporaryIndex,
    );

    await minify({ inputFile: asset, outputFile: temporaryAsset });
    const output = await readRegularFile(temporaryAsset);
    if (output.bytes.length >= input.bytes.length) {
      throw new Error("minified asset is not smaller");
    }
    await run(process.execPath, ["--check", temporaryAsset]);

    await minify({ inputFile: preload, outputFile: temporaryPreload });
    const preloadOutput = await readRegularFile(temporaryPreload);
    if (preloadOutput.bytes.length >= preloadInput.bytes.length) {
      throw new Error("minified preload is not smaller");
    }
    await run(process.execPath, ["--check", temporaryPreload]);

    const outputSha256 = sha256(output.bytes);
    const versionedIndex = versionIndex(indexInput.bytes, outputSha256);
    const mode = input.stat.mode & 0o777;
    const preloadMode = preloadInput.stat.mode & 0o777;
    const stylesheetMode = stylesheetInput.stat.mode & 0o777;
    const indexMode = indexInput.stat.mode & 0o777;
    const compressed = precompress(output.bytes);
    const compressedPreload = precompress(preloadOutput.bytes);
    const compressedStylesheet = precompress(stylesheetInput.bytes);
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
      temporaryStylesheetGzip,
      compressedStylesheet.gzip,
      stylesheetMode,
    );
    await writeTemporary(
      temporaryStylesheetBrotli,
      compressedStylesheet.brotli,
      stylesheetMode,
    );
    await writeTemporary(temporaryIndex, versionedIndex.bytes, indexMode);

    await fs.rename(temporaryGzip, `${asset}.gz`);
    await fs.rename(temporaryBrotli, `${asset}.br`);
    await fs.rename(temporaryPreloadGzip, `${preload}.gz`);
    await fs.rename(temporaryPreloadBrotli, `${preload}.br`);
    await fs.rename(temporaryStylesheetGzip, `${stylesheet}.gz`);
    await fs.rename(temporaryStylesheetBrotli, `${stylesheet}.br`);
    await fs.chmod(temporaryAsset, mode);
    await fs.rename(temporaryAsset, asset);
    await fs.chmod(temporaryPreload, preloadMode);
    await fs.rename(temporaryPreload, preload);
    await fs.rename(temporaryIndex, index);

    return Object.freeze({
      event: "minified_precompressed_asset_built",
      esbuild_version: EXPECTED_ESBUILD_VERSION,
      asset_url: versionedIndex.assetUrl,
      input_sha256: expectedSha256,
      output_sha256: outputSha256,
      index_input_sha256: expectedIndexSha256,
      index_output_sha256: sha256(versionedIndex.bytes),
      preload_input_sha256: expectedPreloadSha256,
      preload_output_sha256: sha256(preloadOutput.bytes),
      stylesheet_sha256: expectedStylesheetSha256,
      input_bytes: input.bytes.length,
      output_bytes: output.bytes.length,
      index_input_bytes: indexInput.bytes.length,
      index_output_bytes: versionedIndex.bytes.length,
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
        "--expected-sha256",
        "--preload",
        "--expected-preload-sha256",
        "--stylesheet",
        "--expected-stylesheet-sha256",
        "--index",
        "--expected-index-sha256",
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
  ]) {
    if (!values.has(required)) throw new Error("asset build command is incomplete");
  }
  return Object.freeze({
    assetFile: values.get("--asset"),
    esbuildFile: values.get("--esbuild"),
    expectedSha256: values.get("--expected-sha256"),
    preloadFile: values.get("--preload"),
    expectedPreloadSha256: values.get("--expected-preload-sha256"),
    stylesheetFile: values.get("--stylesheet"),
    expectedStylesheetSha256: values.get("--expected-stylesheet-sha256"),
    indexFile: values.get("--index"),
    expectedIndexSha256: values.get("--expected-index-sha256"),
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
    minify: createPinnedEsbuildMinifier(options.esbuildFile),
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
