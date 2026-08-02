#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gunzipSync,
  gzipSync,
} from "node:zlib";

const INDEX_RELATIVE = "scratch/asar/webview/index.html";
const APP_RELATIVE = "scratch/asar/webview/assets/app-initial-BTphDPeq.js";
const ASSETS_RELATIVE = "scratch/asar/webview/assets";
const SHA256 = /^[a-f0-9]{64}$/u;
const PANEL_NAME = /^router-account-panel-[a-f0-9]{8}\.js$/u;
const PRELOAD_NAME = /^preload-[a-f0-9]{8}\.js$/u;

export const PINNED_PANEL_REPLACEMENT_CONTRACT = Object.freeze({
  predecessor_index_sha256: "f9116342677d6d51fc033fe87779f63b07ea5aca4f30a9e545b262e8a42d28da",
  predecessor_panel_name: "router-account-panel-c4f3be1f.js",
  predecessor_panel_sha256: "c4f3be1f8122da4f8a2f9da61054c325126af412d5cf09d4ca037e4163e058f9",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-8a0772e9.js",
  replacement_panel_sha256: "8a0772e986abc68ffa48fe98356f43d27cb8916676ee1fb43664c29ba4626aeb",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

function validateContract(value) {
  const keys = [
    "predecessor_index_sha256",
    "predecessor_panel_name",
    "predecessor_panel_sha256",
    "qualified_app_sha256",
    "qualified_preload_name",
    "qualified_preload_sha256",
    "replacement_panel_name",
    "replacement_panel_sha256",
  ];
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    !SHA256.test(value.predecessor_index_sha256) ||
    !PANEL_NAME.test(value.predecessor_panel_name) ||
    !SHA256.test(value.predecessor_panel_sha256) ||
    !SHA256.test(value.qualified_app_sha256) ||
    !PRELOAD_NAME.test(value.qualified_preload_name) ||
    !SHA256.test(value.qualified_preload_sha256) ||
    !PANEL_NAME.test(value.replacement_panel_name) ||
    !SHA256.test(value.replacement_panel_sha256) ||
    value.predecessor_panel_name === value.replacement_panel_name
  ) {
    throw new Error("panel replacement contract is invalid");
  }
  return Object.freeze({ ...value });
}

async function readRegular(target, maximum) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximum || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("panel replacement input boundary is invalid");
  }
  return fs.readFile(target);
}

function decodeUtf8(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new Error("panel replacement input encoding is invalid");
  }
  return value;
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

async function assertCompressedCopies(root, relativePath, expected) {
  const gzip = await readRegular(path.join(root, `${relativePath}.gz`), 512 * 1024);
  const brotli = await readRegular(path.join(root, `${relativePath}.br`), 512 * 1024);
  if (!gunzipSync(gzip).equals(expected) || !brotliDecompressSync(brotli).equals(expected)) {
    throw new Error("compressed predecessor changed");
  }
}

async function writeReleaseFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function replaceStandaloneRouterPanel({
  candidate,
  panelModule,
  contract = PINNED_PANEL_REPLACEMENT_CONTRACT,
} = {}) {
  let phase = "validate_options";
  try {
    const candidateRoot = absolutePath(candidate, "candidate release");
    const panelPath = absolutePath(panelModule, "replacement panel module");
    const checked = validateContract(contract);
    const root = await fs.lstat(candidateRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("candidate release boundary is invalid");
    }

    phase = "validate_predecessor";
    const index = await readRegular(path.join(candidateRoot, INDEX_RELATIVE), 256 * 1024);
    const predecessorRelative = `${ASSETS_RELATIVE}/${checked.predecessor_panel_name}`;
    const predecessor = await readRegular(path.join(candidateRoot, predecessorRelative), 256 * 1024);
    const app = await readRegular(path.join(candidateRoot, APP_RELATIVE), 16 * 1024 * 1024);
    const preload = await readRegular(
      path.join(candidateRoot, ASSETS_RELATIVE, checked.qualified_preload_name),
      4 * 1024 * 1024,
    );
    if (
      sha256(index) !== checked.predecessor_index_sha256 ||
      sha256(predecessor) !== checked.predecessor_panel_sha256 ||
      sha256(app) !== checked.qualified_app_sha256 ||
      sha256(preload) !== checked.qualified_preload_sha256 ||
      !decodeUtf8(app).includes("connect-app-host")
    ) {
      throw new Error("predecessor release changed");
    }
    await assertCompressedCopies(candidateRoot, INDEX_RELATIVE, index);
    await assertCompressedCopies(candidateRoot, predecessorRelative, predecessor);

    const indexText = decodeUtf8(index);
    const predecessorScript =
      `<script type="module" src="./assets/${checked.predecessor_panel_name}"></script>`;
    const replacementScript =
      `<script type="module" src="./assets/${checked.replacement_panel_name}"></script>`;
    if (
      indexText.split(predecessorScript).length - 1 !== 1 ||
      indexText.includes(replacementScript)
    ) {
      throw new Error("predecessor index contract changed");
    }

    phase = "validate_replacement";
    const replacement = await readRegular(panelPath, 256 * 1024);
    if (sha256(replacement) !== checked.replacement_panel_sha256) {
      throw new Error("replacement panel changed");
    }
    const replacementText = decodeUtf8(replacement);
    for (const marker of [
      "Router accounts",
      "/__backend/codex-router/status",
      "/__backend/codex-router/switch",
      "Cross-account continuity is not verified",
      "installRouterAccountPanel",
      "recoveryEligible",
    ]) {
      if (!replacementText.includes(marker)) {
        throw new Error("replacement panel contract changed");
      }
    }

    phase = "prepare_output";
    const nextIndex = Buffer.from(indexText.replace(predecessorScript, replacementScript));
    const nextText = decodeUtf8(nextIndex);
    if (
      nextText.includes(predecessorScript) ||
      nextText.split(replacementScript).length - 1 !== 1
    ) {
      throw new Error("replacement index contract changed");
    }
    const replacementCompressed = compressed(replacement);
    const indexCompressed = compressed(nextIndex);

    phase = "write_output";
    const replacementRelative = `${ASSETS_RELATIVE}/${checked.replacement_panel_name}`;
    await writeReleaseFile(candidateRoot, replacementRelative, replacement);
    await writeReleaseFile(candidateRoot, `${replacementRelative}.gz`, replacementCompressed.gzip);
    await writeReleaseFile(candidateRoot, `${replacementRelative}.br`, replacementCompressed.brotli);
    await writeReleaseFile(candidateRoot, INDEX_RELATIVE, nextIndex);
    await writeReleaseFile(candidateRoot, `${INDEX_RELATIVE}.gz`, indexCompressed.gzip);
    await writeReleaseFile(candidateRoot, `${INDEX_RELATIVE}.br`, indexCompressed.brotli);
    await fs.rm(path.join(candidateRoot, predecessorRelative));
    await fs.rm(path.join(candidateRoot, `${predecessorRelative}.gz`));
    await fs.rm(path.join(candidateRoot, `${predecessorRelative}.br`));

    return Object.freeze({
      event: "standalone_router_panel_replaced",
      qualified_app_unchanged: true,
      qualified_preload_unchanged: true,
      predecessor_panel_removed: true,
      panel_name: checked.replacement_panel_name,
      panel_sha256: sha256(replacement),
      panel_gzip_sha256: sha256(replacementCompressed.gzip),
      panel_brotli_sha256: sha256(replacementCompressed.brotli),
      index_sha256: sha256(nextIndex),
      index_gzip_sha256: sha256(indexCompressed.gzip),
      index_brotli_sha256: sha256(indexCompressed.brotli),
    });
  } catch {
    throw new Error(`standalone panel replacement failed at ${phase}`);
  }
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--panel-module", "panelModule"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("panel replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("panel replacement command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceStandaloneRouterPanel(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
