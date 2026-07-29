#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const ASSET_URL = "./assets/app-initial-BTphDPeq.js";
const INDEX_NAME = "index.html";
const STARTUP_FASTPATH_NAME = "tailnet-startup-fastpath.js";
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_STARTUP_FASTPATH_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSIONED_ASSET_HREF_PATTERN =
  /href="(\.\/assets\/app-initial-BTphDPeq\.js\?v=[a-f0-9]{16})"/gu;
const PRELOAD_MODULE_SCRIPT =
  '    <script type="module" src="./assets/preload.js"></script>';
const STARTUP_FASTPATH_SCRIPT =
  '    <script src="./tailnet-startup-fastpath.js"></script>';
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
      throw new Error("inline input boundary is invalid");
    }
    return Object.freeze({ bytes: await handle.readFile(), stat });
  } finally {
    await handle?.close();
  }
}

function inlineStartupFastpath(startupFastpathBytes) {
  const source = startupFastpathBytes.toString("utf8");
  if (
    !Buffer.from(source).equals(startupFastpathBytes) ||
    /<\/script/iu.test(source)
  ) {
    throw new Error("startup fastpath inline boundary is invalid");
  }
  new Script(source, { filename: STARTUP_FASTPATH_NAME });
  return [
    INLINE_STARTUP_FASTPATH_MARKER,
    source.trimEnd(),
    "    </script>",
  ].join("\n");
}

export function inlineVersionedStartupFastpath(
  indexBytes,
  startupFastpathBytes,
) {
  if (
    !Buffer.isBuffer(indexBytes) ||
    !Buffer.isBuffer(startupFastpathBytes)
  ) {
    throw new Error("inline input is invalid");
  }
  const index = indexBytes.toString("utf8");
  if (
    !Buffer.from(index).equals(indexBytes) ||
    countOccurrences(index, STARTUP_FASTPATH_SCRIPT) !== 1 ||
    countOccurrences(index, PRELOAD_MODULE_SCRIPT) !== 1 ||
    countOccurrences(index, '<script type="importmap">') !== 1 ||
    index.includes(INLINE_STARTUP_FASTPATH_MARKER) ||
    index.includes(`href="${ASSET_URL}"`)
  ) {
    throw new Error("versioned index boundary is invalid");
  }

  const versionedMatches = [...index.matchAll(VERSIONED_ASSET_HREF_PATTERN)];
  if (versionedMatches.length !== 1) {
    throw new Error("versioned asset hint is invalid");
  }
  const assetUrl = versionedMatches[0][1];
  const importMap = JSON.stringify({
    imports: {
      [ASSET_URL]: assetUrl,
    },
  });
  const importMapIndex = index.indexOf(importMap);
  const hintIndex = index.indexOf(`href="${assetUrl}"`);
  const startupIndex = index.indexOf(STARTUP_FASTPATH_SCRIPT);
  const preloadIndex = index.indexOf(PRELOAD_MODULE_SCRIPT);
  if (
    countOccurrences(index, assetUrl) !== 2 ||
    countOccurrences(index, importMap) !== 1 ||
    !(
      importMapIndex >= 0 &&
      importMapIndex < hintIndex &&
      hintIndex < startupIndex &&
      startupIndex < preloadIndex
    )
  ) {
    throw new Error("versioned startup order is invalid");
  }

  const output = Buffer.from(
    index.replace(
      STARTUP_FASTPATH_SCRIPT,
      inlineStartupFastpath(startupFastpathBytes),
    ),
  );
  return Object.freeze({ assetUrl, bytes: output });
}

export async function inlineVersionedStartupFastpathFile({
  indexFile,
  expectedIndexSha256,
  startupFastpathFile,
  expectedStartupFastpathSha256,
} = {}) {
  let temporaryIndex;
  try {
    const index = assertAbsolute(indexFile, "index file");
    const startupFastpath = assertAbsolute(
      startupFastpathFile,
      "startup fastpath file",
    );
    if (
      path.basename(index) !== INDEX_NAME ||
      path.resolve(path.dirname(index), STARTUP_FASTPATH_NAME) !==
        startupFastpath ||
      typeof expectedIndexSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedIndexSha256) ||
      typeof expectedStartupFastpathSha256 !== "string" ||
      !SHA256_PATTERN.test(expectedStartupFastpathSha256)
    ) {
      throw new Error("inline input is invalid");
    }

    const indexInput = await readRegularFile(index, MAX_INDEX_BYTES);
    const startupFastpathInput = await readRegularFile(
      startupFastpath,
      MAX_STARTUP_FASTPATH_BYTES,
    );
    if (
      sha256(indexInput.bytes) !== expectedIndexSha256 ||
      sha256(startupFastpathInput.bytes) !== expectedStartupFastpathSha256
    ) {
      throw new Error("inline input hash changed");
    }

    const output = inlineVersionedStartupFastpath(
      indexInput.bytes,
      startupFastpathInput.bytes,
    );
    const mode = indexInput.stat.mode & 0o777;
    temporaryIndex = path.join(
      path.dirname(index),
      `.${INDEX_NAME}.${randomUUID()}.next`,
    );
    await fs.writeFile(temporaryIndex, output.bytes, {
      flag: "wx",
      mode,
    });
    await fs.chmod(temporaryIndex, mode);
    await fs.rename(temporaryIndex, index);
    temporaryIndex = undefined;

    return Object.freeze({
      event: "versioned_startup_fastpath_inlined",
      asset_url: output.assetUrl,
      index_input_sha256: expectedIndexSha256,
      index_output_sha256: sha256(output.bytes),
      startup_fastpath_sha256: expectedStartupFastpathSha256,
      index_input_bytes: indexInput.bytes.length,
      index_output_bytes: output.bytes.length,
      startup_fastpath_bytes: startupFastpathInput.bytes.length,
    });
  } catch {
    throw new Error("versioned startup inline failed");
  } finally {
    if (temporaryIndex !== undefined) {
      await fs.rm(temporaryIndex, { force: true }).catch(() => {});
    }
  }
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set([
    "--index",
    "--expected-index-sha256",
    "--startup-fastpath",
    "--expected-startup-fastpath-sha256",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(option) ||
      typeof value !== "string" ||
      values.has(option)
    ) {
      throw new Error("inline option is invalid");
    }
    values.set(option, value);
  }
  for (const required of allowed) {
    if (!values.has(required)) {
      throw new Error("inline command is incomplete");
    }
  }
  return Object.freeze({
    indexFile: values.get("--index"),
    expectedIndexSha256: values.get("--expected-index-sha256"),
    startupFastpathFile: values.get("--startup-fastpath"),
    expectedStartupFastpathSha256: values.get(
      "--expected-startup-fastpath-sha256",
    ),
  });
}

async function main() {
  const result = await inlineVersionedStartupFastpathFile(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write("versioned startup inline failed\n");
    process.exitCode = 1;
  });
}
