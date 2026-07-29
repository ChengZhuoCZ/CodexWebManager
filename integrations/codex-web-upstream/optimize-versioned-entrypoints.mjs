#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const INDEX_NAME = "index.html";
const ASSET_NAME = "app-initial-BTphDPeq.js";
const BOOTSTRAP_NAME = "index-6UcaOV-H.js";
const RPC_NAME = "rpc-ArWg2Nqw.js";
const APP_MAIN_NAME = "app-main-DW9SEGGt.js";
const ASSET_URL = `./assets/${ASSET_NAME}`;
const BOOTSTRAP_URL = `./assets/${BOOTSTRAP_NAME}`;
const RPC_URL = `./assets/${RPC_NAME}`;
const APP_MAIN_URL = `./assets/${APP_MAIN_NAME}`;
const BOOTSTRAP_RPC_SPECIFIER = `./${RPC_NAME}`;
const BOOTSTRAP_APP_MAIN_SPECIFIER = `./${APP_MAIN_NAME}`;
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_BYTES = 64 * 1024;
const MAX_ENTRYPOINT_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MIN_BROTLI_REDUCTION_BPS = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSIONED_ASSET_HREF_PATTERN =
  /href="(\.\/assets\/app-initial-BTphDPeq\.js\?v=[a-f0-9]{16})"/gu;
const INLINE_STARTUP_FASTPATH_MARKER =
  "    <script data-codex-tailnet-startup-fastpath>";

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return value;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function modulePreload(url) {
  return [
    "    <link",
    '      rel="modulepreload"',
    "      crossorigin",
    `      href="${url}"`,
    "    />",
  ].join("\n");
}

export function compressVersionedText(bytes) {
  return brotliCompressSync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
}

async function readRegularFile(filePath, maximum) {
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
      throw new Error("versioned optimization input boundary is invalid");
    }
    return Object.freeze({ bytes: await handle.readFile(), stat });
  } finally {
    await handle?.close();
  }
}

function validateLayout({
  index,
  asset,
  assetBrotli,
  bootstrap,
  rpc,
  appMain,
}) {
  const webview = path.dirname(index);
  const assets = path.join(webview, "assets");
  if (
    path.basename(index) !== INDEX_NAME ||
    asset !== path.join(assets, ASSET_NAME) ||
    assetBrotli !== `${asset}.br` ||
    bootstrap !== path.join(assets, BOOTSTRAP_NAME) ||
    rpc !== path.join(assets, RPC_NAME) ||
    appMain !== path.join(assets, APP_MAIN_NAME)
  ) {
    throw new Error("versioned optimization layout is invalid");
  }
}

export function hintVersionedEntrypoints(indexBytes, bootstrapBytes) {
  if (!Buffer.isBuffer(indexBytes) || !Buffer.isBuffer(bootstrapBytes)) {
    throw new Error("versioned entrypoint input is invalid");
  }
  const index = indexBytes.toString("utf8");
  const bootstrap = bootstrapBytes.toString("utf8");
  if (
    !Buffer.from(index).equals(indexBytes) ||
    !Buffer.from(bootstrap).equals(bootstrapBytes) ||
    countOccurrences(index, INLINE_STARTUP_FASTPATH_MARKER) !== 1 ||
    countOccurrences(index, `src="${BOOTSTRAP_URL}"`) !== 1 ||
    countOccurrences(index, `href="${RPC_URL}"`) !== 0 ||
    countOccurrences(index, `href="${APP_MAIN_URL}"`) !== 0 ||
    countOccurrences(bootstrap, `"${BOOTSTRAP_RPC_SPECIFIER}"`) !== 1 ||
    countOccurrences(bootstrap, `\`${BOOTSTRAP_RPC_SPECIFIER}\``) !== 1 ||
    countOccurrences(bootstrap, `"${BOOTSTRAP_APP_MAIN_SPECIFIER}"`) !== 1 ||
    countOccurrences(bootstrap, `\`${BOOTSTRAP_APP_MAIN_SPECIFIER}\``) !== 1
  ) {
    throw new Error("versioned entrypoint boundary is invalid");
  }

  const versionedMatches = [...index.matchAll(VERSIONED_ASSET_HREF_PATTERN)];
  if (versionedMatches.length !== 1) {
    throw new Error("versioned asset hint is invalid");
  }
  const assetUrl = versionedMatches[0][1];
  const assetHint = modulePreload(assetUrl);
  if (
    countOccurrences(index, assetHint) !== 1 ||
    index.indexOf(assetHint) > index.indexOf(INLINE_STARTUP_FASTPATH_MARKER)
  ) {
    throw new Error("versioned asset order is invalid");
  }

  const entrypointHints = [
    modulePreload(RPC_URL),
    modulePreload(APP_MAIN_URL),
  ].join("\n");
  const output = Buffer.from(
    index.replace(assetHint, `${assetHint}\n${entrypointHints}`),
  );
  return Object.freeze({
    assetUrl,
    bytes: output,
    hintedUrls: Object.freeze([RPC_URL, APP_MAIN_URL]),
  });
}

async function writeTemporary(filePath, bytes, mode) {
  await fs.writeFile(filePath, bytes, { flag: "wx", mode });
  await fs.chmod(filePath, mode);
}

export async function optimizeVersionedEntrypointsFile({
  indexFile,
  expectedIndexSha256,
  assetFile,
  expectedAssetSha256,
  expectedAssetBrotliSha256,
  bootstrapFile,
  expectedBootstrapSha256,
  rpcFile,
  expectedRpcSha256,
  appMainFile,
  expectedAppMainSha256,
  compressText = compressVersionedText,
} = {}) {
  const temporaryFiles = [];
  try {
    const index = assertAbsolute(indexFile, "index file");
    const asset = assertAbsolute(assetFile, "asset file");
    const assetBrotli = `${asset}.br`;
    const bootstrap = assertAbsolute(bootstrapFile, "bootstrap file");
    const rpc = assertAbsolute(rpcFile, "RPC entrypoint");
    const appMain = assertAbsolute(appMainFile, "application entrypoint");
    validateLayout({ index, asset, assetBrotli, bootstrap, rpc, appMain });

    const expectedHashes = [
      expectedIndexSha256,
      expectedAssetSha256,
      expectedAssetBrotliSha256,
      expectedBootstrapSha256,
      expectedRpcSha256,
      expectedAppMainSha256,
    ];
    if (
      expectedHashes.some(
        (value) =>
          typeof value !== "string" || !SHA256_PATTERN.test(value),
      ) ||
      typeof compressText !== "function"
    ) {
      throw new Error("versioned optimization input is invalid");
    }

    const [
      indexInput,
      assetInput,
      assetBrotliInput,
      bootstrapInput,
      rpcInput,
      appMainInput,
    ] = await Promise.all([
      readRegularFile(index, MAX_INDEX_BYTES),
      readRegularFile(asset, MAX_ASSET_BYTES),
      readRegularFile(assetBrotli, MAX_ASSET_BYTES),
      readRegularFile(bootstrap, MAX_BOOTSTRAP_BYTES),
      readRegularFile(rpc, MAX_ENTRYPOINT_BYTES),
      readRegularFile(appMain, MAX_ENTRYPOINT_BYTES),
    ]);
    const inputs = [
      [indexInput.bytes, expectedIndexSha256],
      [assetInput.bytes, expectedAssetSha256],
      [assetBrotliInput.bytes, expectedAssetBrotliSha256],
      [bootstrapInput.bytes, expectedBootstrapSha256],
      [rpcInput.bytes, expectedRpcSha256],
      [appMainInput.bytes, expectedAppMainSha256],
    ];
    if (inputs.some(([bytes, expected]) => sha256(bytes) !== expected)) {
      throw new Error("versioned optimization input hash changed");
    }
    if (
      !brotliDecompressSync(assetBrotliInput.bytes).equals(assetInput.bytes)
    ) {
      throw new Error("versioned asset Brotli input is inconsistent");
    }

    const hinted = hintVersionedEntrypoints(
      indexInput.bytes,
      bootstrapInput.bytes,
    );
    const nextAssetBrotli = Buffer.from(await compressText(assetInput.bytes));
    if (
      !brotliDecompressSync(nextAssetBrotli).equals(assetInput.bytes) ||
      nextAssetBrotli.length >= assetBrotliInput.bytes.length ||
      (assetBrotliInput.bytes.length - nextAssetBrotli.length) * 10_000 <
        assetBrotliInput.bytes.length * MIN_BROTLI_REDUCTION_BPS
    ) {
      throw new Error("versioned Brotli reduction is insufficient");
    }

    const nextIndexGzip = gzipSync(hinted.bytes, { level: 9 });
    const nextIndexBrotli = Buffer.from(await compressText(hinted.bytes));
    if (!brotliDecompressSync(nextIndexBrotli).equals(hinted.bytes)) {
      throw new Error("versioned index Brotli output is inconsistent");
    }

    const replacements = [
      {
        bytes: nextAssetBrotli,
        destination: assetBrotli,
        mode: assetBrotliInput.stat.mode & 0o777,
      },
      {
        bytes: nextIndexGzip,
        destination: `${index}.gz`,
        mode: indexInput.stat.mode & 0o777,
      },
      {
        bytes: nextIndexBrotli,
        destination: `${index}.br`,
        mode: indexInput.stat.mode & 0o777,
      },
      {
        bytes: hinted.bytes,
        destination: index,
        mode: indexInput.stat.mode & 0o777,
      },
    ];
    for (const replacement of replacements) {
      const temporary = path.join(
        path.dirname(replacement.destination),
        `.${path.basename(replacement.destination)}.${randomUUID()}.next`,
      );
      temporaryFiles.push(temporary);
      await writeTemporary(
        temporary,
        replacement.bytes,
        replacement.mode,
      );
    }
    for (let index = 0; index < replacements.length; index += 1) {
      await fs.rename(temporaryFiles[index], replacements[index].destination);
      temporaryFiles[index] = undefined;
    }

    return Object.freeze({
      event: "versioned_entrypoints_optimized",
      asset_url: hinted.assetUrl,
      hinted_urls: hinted.hintedUrls,
      index_input_sha256: expectedIndexSha256,
      index_output_sha256: sha256(hinted.bytes),
      index_output_bytes: hinted.bytes.length,
      index_gzip_sha256: sha256(nextIndexGzip),
      index_gzip_bytes: nextIndexGzip.length,
      index_brotli_sha256: sha256(nextIndexBrotli),
      index_brotli_bytes: nextIndexBrotli.length,
      asset_identity_sha256: expectedAssetSha256,
      asset_brotli_input_sha256: expectedAssetBrotliSha256,
      asset_brotli_output_sha256: sha256(nextAssetBrotli),
      asset_brotli_input_bytes: assetBrotliInput.bytes.length,
      asset_brotli_output_bytes: nextAssetBrotli.length,
      asset_brotli_reduction_bytes:
        assetBrotliInput.bytes.length - nextAssetBrotli.length,
    });
  } catch {
    throw new Error("versioned entrypoint optimization failed");
  } finally {
    await Promise.all(
      temporaryFiles
        .filter((temporary) => temporary !== undefined)
        .map((temporary) => fs.rm(temporary, { force: true }).catch(() => {})),
    );
  }
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set([
    "--index",
    "--expected-index-sha256",
    "--asset",
    "--expected-asset-sha256",
    "--expected-asset-brotli-sha256",
    "--bootstrap",
    "--expected-bootstrap-sha256",
    "--rpc",
    "--expected-rpc-sha256",
    "--app-main",
    "--expected-app-main-sha256",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(option) ||
      typeof value !== "string" ||
      values.has(option)
    ) {
      throw new Error("versioned optimization option is invalid");
    }
    values.set(option, value);
  }
  for (const required of allowed) {
    if (!values.has(required)) {
      throw new Error("versioned optimization command is incomplete");
    }
  }
  return Object.freeze({
    indexFile: values.get("--index"),
    expectedIndexSha256: values.get("--expected-index-sha256"),
    assetFile: values.get("--asset"),
    expectedAssetSha256: values.get("--expected-asset-sha256"),
    expectedAssetBrotliSha256: values.get(
      "--expected-asset-brotli-sha256",
    ),
    bootstrapFile: values.get("--bootstrap"),
    expectedBootstrapSha256: values.get("--expected-bootstrap-sha256"),
    rpcFile: values.get("--rpc"),
    expectedRpcSha256: values.get("--expected-rpc-sha256"),
    appMainFile: values.get("--app-main"),
    expectedAppMainSha256: values.get("--expected-app-main-sha256"),
  });
}

async function main() {
  const result = await optimizeVersionedEntrypointsFile(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write("versioned entrypoint optimization failed\n");
    process.exitCode = 1;
  });
}

export {
  APP_MAIN_NAME,
  APP_MAIN_URL,
  ASSET_NAME,
  BOOTSTRAP_APP_MAIN_SPECIFIER,
  BOOTSTRAP_NAME,
  BOOTSTRAP_RPC_SPECIFIER,
  MIN_BROTLI_REDUCTION_BPS,
  RPC_NAME,
  RPC_URL,
};
