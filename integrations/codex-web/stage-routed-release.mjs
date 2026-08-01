#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const SERVER_FILES = Object.freeze([
  "src/server/main.js",
  "src/server/module.js",
  "src/server/browser-ipc-router.js",
  "src/server/browser-session-auth.js",
  "src/server/browser-upload-store.js",
  "src/server/router-status-bridge.js",
]);
const PRELOAD_RELATIVE = "scratch/asar/webview/assets/preload.js";
const INDEX_RELATIVE = "scratch/asar/webview/index.html";
const VERSIONED_PRELOAD = /\.\/assets\/preload-[a-f0-9]{8}\.js/gu;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function absoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

async function readRegular(root, relativePath, maximum = 64 * 1024 * 1024) {
  const target = path.join(root, relativePath);
  const metadata = await fs.lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
      metadata.size > maximum || (metadata.mode & 0o022) !== 0) {
    throw new Error("routed Web release input boundary is invalid");
  }
  return fs.readFile(target);
}

function compressed(bytes) {
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

async function writeReleaseFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.next`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function stageRoutedWebRelease({
  previous,
  candidate,
  serverBuild,
  browserBuild,
  beforeCommit = null,
} = {}) {
  let staging = null;
  let phase = "validate_options";
  try {
    const previousRoot = absoluteDirectory(previous, "previous release");
    const candidateRoot = absoluteDirectory(candidate, "candidate release");
    const serverRoot = absoluteDirectory(serverBuild, "server build");
    const browserRoot = absoluteDirectory(browserBuild, "browser build");
    if ([previousRoot, serverRoot, browserRoot].includes(candidateRoot) ||
        (beforeCommit !== null && typeof beforeCommit !== "function")) {
      throw new Error("routed Web release paths are invalid");
    }
    phase = "validate_previous";
    const previousMetadata = await fs.lstat(previousRoot);
    if (!previousMetadata.isDirectory() || previousMetadata.isSymbolicLink()) {
      throw new Error("previous release boundary is invalid");
    }
    await fs.lstat(candidateRoot).then(
      () => { throw new Error("candidate release already exists"); },
      (error) => { if (error?.code !== "ENOENT") throw error; },
    );

    phase = "read_preload";
    const preload = await readRegular(browserRoot, PRELOAD_RELATIVE, 4 * 1024 * 1024);
    phase = "read_previous_index";
    const previousIndex = await readRegular(previousRoot, INDEX_RELATIVE, 256 * 1024);
    const indexText = previousIndex.toString("utf8");
    if (!Buffer.from(indexText).equals(previousIndex)) {
      throw new Error("routed Web index encoding is invalid");
    }
    const matches = [...indexText.matchAll(VERSIONED_PRELOAD)];
    if (matches.length !== 1 || indexText.includes("./assets/preload.js")) {
      throw new Error("routed Web preload anchor is invalid");
    }
    const serverOutputs = new Map();
    for (const relativePath of SERVER_FILES) {
      phase = `read_${path.basename(relativePath, ".js").replaceAll("-", "_")}`;
      serverOutputs.set(relativePath, await readRegular(serverRoot, relativePath));
    }

    phase = "copy_previous";
    staging = path.join(path.dirname(candidateRoot),
      `.${path.basename(candidateRoot)}.${randomUUID()}.staging`);
    await fs.mkdir(path.dirname(candidateRoot), { recursive: true, mode: 0o755 });
    await fs.cp(previousRoot, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    phase = "write_overlay";
    for (const [relativePath, bytes] of serverOutputs) {
      await writeReleaseFile(staging, relativePath, bytes);
    }

    const preloadHash = sha256(preload);
    const preloadName = `preload-${preloadHash.slice(0, 8)}.js`;
    const versionedRelative = `scratch/asar/webview/assets/${preloadName}`;
    const preloadCompressed = compressed(preload);
    const index = Buffer.from(indexText.replace(VERSIONED_PRELOAD, `./assets/${preloadName}`));
    const indexCompressed = compressed(index);
    await writeReleaseFile(staging, versionedRelative, preload);
    await writeReleaseFile(staging, `${versionedRelative}.gz`, preloadCompressed.gzip);
    await writeReleaseFile(staging, `${versionedRelative}.br`, preloadCompressed.brotli);
    await writeReleaseFile(staging, INDEX_RELATIVE, index);
    await writeReleaseFile(staging, `${INDEX_RELATIVE}.gz`, indexCompressed.gzip);
    await writeReleaseFile(staging, `${INDEX_RELATIVE}.br`, indexCompressed.brotli);

    phase = "pre_commit";
    await beforeCommit?.({ staging, candidate: candidateRoot });
    phase = "commit";
    await fs.rename(staging, candidateRoot);
    staging = null;
    return Object.freeze({
      event: "routed_web_release_staged",
      preload_name: preloadName,
      preload_sha256: preloadHash,
      preload_gzip_sha256: sha256(preloadCompressed.gzip),
      preload_brotli_sha256: sha256(preloadCompressed.brotli),
      index_sha256: sha256(index),
      index_gzip_sha256: sha256(indexCompressed.gzip),
      index_brotli_sha256: sha256(indexCompressed.brotli),
      server_files: [...SERVER_FILES],
    });
  } catch {
    throw new Error(`routed Web release staging failed at ${phase}`);
  } finally {
    if (staging !== null) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--previous", "previous"],
    ["--candidate", "candidate"],
    ["--server-build", "serverBuild"],
    ["--browser-build", "browserBuild"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("routed Web release option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 4) {
    throw new Error("routed Web release command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageRoutedWebRelease(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
