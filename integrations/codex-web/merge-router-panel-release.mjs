#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const INDEX_RELATIVE = "scratch/asar/webview/index.html";
const APP_RELATIVE = "scratch/asar/webview/assets/app-initial-BTphDPeq.js";
const ASSETS_RELATIVE = "scratch/asar/webview/assets";
const VERSIONED_PRELOAD = /\.\/assets\/(preload-[a-f0-9]{8}\.js)/gu;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[a-f0-9]{16}$/u;
const PRELOAD_NAME = /^preload-[a-f0-9]{8}\.js$/u;

export const PINNED_R87_R86_PANEL_CONTRACT = Object.freeze({
  qualified_index_sha256: "5e89e6e9cb38ebb82fde42526a113458d0072e40bd4cd9f10393a320e793bef9",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  qualified_app_version: "e2d356e06763a828",
  qualified_preload_name: "preload-65708a1c.js",
  panel_index_sha256: "4c2a7f7ed127570385e44bb9b44a91b63714e15d24906c4756ea3463bfe246dd",
  panel_preload_sha256: "d153ef5adef87db419a7499cd95c01c477d1f5919193398f27f9aed7367047c9",
  panel_preload_name: "preload-d153ef5a.js",
});

const CONTRACT_KEYS = Object.freeze([
  "qualified_index_sha256",
  "qualified_app_sha256",
  "qualified_preload_sha256",
  "qualified_app_version",
  "qualified_preload_name",
  "panel_index_sha256",
  "panel_preload_sha256",
  "panel_preload_name",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absoluteDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

function validateContract(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...CONTRACT_KEYS].sort().join(",") ||
    !SHA256.test(value.qualified_index_sha256) ||
    !SHA256.test(value.qualified_app_sha256) ||
    !SHA256.test(value.qualified_preload_sha256) ||
    !VERSION.test(value.qualified_app_version) ||
    !PRELOAD_NAME.test(value.qualified_preload_name) ||
    !SHA256.test(value.panel_index_sha256) ||
    !SHA256.test(value.panel_preload_sha256) ||
    !PRELOAD_NAME.test(value.panel_preload_name) ||
    value.qualified_preload_name === value.panel_preload_name
  ) {
    throw new Error("router panel contract is invalid");
  }
  return Object.freeze({ ...value });
}

async function readRegular(root, relativePath, maximum) {
  const target = path.join(root, relativePath);
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximum || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("router panel input boundary is invalid");
  }
  return fs.readFile(target);
}

function decodeUtf8(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new Error("router panel input encoding is invalid");
  }
  return value;
}

function exactlyOnePreload(indexText, expectedName) {
  const matches = [...indexText.matchAll(VERSIONED_PRELOAD)];
  if (matches.length !== 1 || matches[0][1] !== expectedName) {
    throw new Error("router panel preload anchor is invalid");
  }
  return matches[0][0];
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

export async function mergeRouterPanelOntoQualifiedRelease({
  candidate,
  panelRelease,
  contract = PINNED_R87_R86_PANEL_CONTRACT,
} = {}) {
  let phase = "validate_options";
  try {
    const candidateRoot = absoluteDirectory(candidate, "candidate release");
    const panelRoot = absoluteDirectory(panelRelease, "panel release");
    const checked = validateContract(contract);
    if (candidateRoot === panelRoot) {
      throw new Error("router panel release paths are invalid");
    }
    for (const root of [candidateRoot, panelRoot]) {
      const metadata = await fs.lstat(root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("router panel release boundary is invalid");
      }
    }

    phase = "validate_qualified_index";
    const qualifiedIndex = await readRegular(candidateRoot, INDEX_RELATIVE, 256 * 1024);
    if (sha256(qualifiedIndex) !== checked.qualified_index_sha256) {
      throw new Error("qualified index hash changed");
    }
    const qualifiedIndexText = decodeUtf8(qualifiedIndex);
    const qualifiedPreloadAnchor = exactlyOnePreload(
      qualifiedIndexText,
      checked.qualified_preload_name,
    );
    const appReference = `app-initial-BTphDPeq.js?v=${checked.qualified_app_version}`;
    if (qualifiedIndexText.split(appReference).length - 1 !== 2) {
      throw new Error("qualified App Host index contract changed");
    }

    phase = "validate_qualified_app";
    const qualifiedApp = await readRegular(candidateRoot, APP_RELATIVE, 16 * 1024 * 1024);
    if (
      sha256(qualifiedApp) !== checked.qualified_app_sha256 ||
      !decodeUtf8(qualifiedApp).includes("connect-app-host")
    ) {
      throw new Error("qualified App Host bundle changed");
    }

    phase = "validate_qualified_preload";
    const qualifiedPreload = await readRegular(
      candidateRoot,
      `${ASSETS_RELATIVE}/${checked.qualified_preload_name}`,
      4 * 1024 * 1024,
    );
    if (sha256(qualifiedPreload) !== checked.qualified_preload_sha256) {
      throw new Error("qualified preload changed");
    }

    phase = "validate_panel_index";
    const panelIndex = await readRegular(panelRoot, INDEX_RELATIVE, 256 * 1024);
    if (sha256(panelIndex) !== checked.panel_index_sha256) {
      throw new Error("panel index hash changed");
    }
    exactlyOnePreload(decodeUtf8(panelIndex), checked.panel_preload_name);

    phase = "validate_panel_preload";
    const panelPreload = await readRegular(
      panelRoot,
      `${ASSETS_RELATIVE}/${checked.panel_preload_name}`,
      4 * 1024 * 1024,
    );
    if (sha256(panelPreload) !== checked.panel_preload_sha256) {
      throw new Error("panel preload hash changed");
    }

    phase = "validate_panel_contract";
    const panelText = decodeUtf8(panelPreload);
    for (const marker of [
      "Router accounts",
      "/__backend/codex-router/status",
      "Cross-account continuity is not verified",
      "connect-app-host",
      "__ELECTRON_SHIM__",
    ]) {
      if (!panelText.includes(marker)) {
        throw new Error("panel preload contract changed");
      }
    }

    phase = "prepare_output";
    const index = Buffer.from(
      qualifiedIndexText.replace(
        qualifiedPreloadAnchor,
        `./assets/${checked.panel_preload_name}`,
      ),
    );
    const indexText = decodeUtf8(index);
    if (
      indexText.split(appReference).length - 1 !== 2 ||
      exactlyOnePreload(indexText, checked.panel_preload_name) !==
        `./assets/${checked.panel_preload_name}`
    ) {
      throw new Error("hybrid index contract changed");
    }
    const panelCompressed = compressed(panelPreload);
    const indexCompressed = compressed(index);

    phase = "write_panel";
    const panelRelative = `${ASSETS_RELATIVE}/${checked.panel_preload_name}`;
    await writeReleaseFile(candidateRoot, panelRelative, panelPreload);
    await writeReleaseFile(candidateRoot, `${panelRelative}.gz`, panelCompressed.gzip);
    await writeReleaseFile(candidateRoot, `${panelRelative}.br`, panelCompressed.brotli);
    await writeReleaseFile(candidateRoot, INDEX_RELATIVE, index);
    await writeReleaseFile(candidateRoot, `${INDEX_RELATIVE}.gz`, indexCompressed.gzip);
    await writeReleaseFile(candidateRoot, `${INDEX_RELATIVE}.br`, indexCompressed.brotli);

    phase = "verify_output";
    const appAfter = await readRegular(candidateRoot, APP_RELATIVE, 16 * 1024 * 1024);
    if (sha256(appAfter) !== checked.qualified_app_sha256) {
      throw new Error("qualified App Host bundle was modified");
    }

    return Object.freeze({
      event: "router_panel_merged_onto_qualified_release",
      qualified_app_unchanged: true,
      qualified_app_sha256: checked.qualified_app_sha256,
      panel_preload_name: checked.panel_preload_name,
      panel_preload_sha256: sha256(panelPreload),
      panel_preload_gzip_sha256: sha256(panelCompressed.gzip),
      panel_preload_brotli_sha256: sha256(panelCompressed.brotli),
      index_sha256: sha256(index),
      index_gzip_sha256: sha256(indexCompressed.gzip),
      index_brotli_sha256: sha256(indexCompressed.brotli),
    });
  } catch {
    throw new Error(`router panel merge failed at ${phase}`);
  }
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--panel-release", "panelRelease"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("router panel merge option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("router panel merge command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mergeRouterPanelOntoQualifiedRelease(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
