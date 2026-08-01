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
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[a-f0-9]{16}$/u;
const PRELOAD_NAME = /^preload-[a-f0-9]{8}\.js$/u;
const PANEL_NAME = /^router-account-panel-[a-f0-9]{8}\.js$/u;

export const PINNED_STANDALONE_PANEL_CONTRACT = Object.freeze({
  qualified_preload_name: "preload-65708a1c.js",
  panel_name: "router-account-panel-f80b0416.js",
  qualified_index_sha256: "5e89e6e9cb38ebb82fde42526a113458d0072e40bd4cd9f10393a320e793bef9",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  qualified_app_version: "e2d356e06763a828",
  panel_sha256: "f80b0416b57cec80ce289b7a316383be44e288a40e73e6009af4101cb9597446",
});

function validateContract(value) {
  const keys = [
    "qualified_preload_name",
    "panel_name",
    "qualified_index_sha256",
    "qualified_app_sha256",
    "qualified_preload_sha256",
    "qualified_app_version",
    "panel_sha256",
  ];
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    !PRELOAD_NAME.test(value.qualified_preload_name) ||
    !PANEL_NAME.test(value.panel_name) ||
    !SHA256.test(value.qualified_index_sha256) ||
    !SHA256.test(value.qualified_app_sha256) ||
    !SHA256.test(value.qualified_preload_sha256) ||
    !VERSION.test(value.qualified_app_version) ||
    !SHA256.test(value.panel_sha256)
  ) {
    throw new Error("standalone panel contract is invalid");
  }
  return Object.freeze({ ...value });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

async function readRegular(target, maximum) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximum || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("standalone panel input boundary is invalid");
  }
  return fs.readFile(target);
}

function decodeUtf8(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new Error("standalone panel input encoding is invalid");
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

export async function installStandaloneRouterPanel({
  candidate,
  panelModule,
  contract = PINNED_STANDALONE_PANEL_CONTRACT,
} = {}) {
  let phase = "validate_options";
  try {
    const candidateRoot = absolutePath(candidate, "candidate release");
    const panelPath = absolutePath(panelModule, "panel module");
    const checked = validateContract(contract);
    const root = await fs.lstat(candidateRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("candidate release boundary is invalid");
    }

    phase = "validate_qualified_index";
    const indexPath = path.join(candidateRoot, INDEX_RELATIVE);
    const indexInput = await readRegular(indexPath, 256 * 1024);
    if (sha256(indexInput) !== checked.qualified_index_sha256) {
      throw new Error("qualified index changed");
    }
    const indexText = decodeUtf8(indexInput);
    const preloadAnchor =
      `<script type="module" src="./assets/${checked.qualified_preload_name}"></script>`;
    const appReference = `app-initial-BTphDPeq.js?v=${checked.qualified_app_version}`;
    if (
      indexText.split(preloadAnchor).length - 1 !== 1 ||
      indexText.split(appReference).length - 1 !== 2 ||
      indexText.includes("router-account-panel-")
    ) {
      throw new Error("qualified index contract changed");
    }

    phase = "validate_qualified_app";
    const app = await readRegular(path.join(candidateRoot, APP_RELATIVE), 16 * 1024 * 1024);
    if (
      sha256(app) !== checked.qualified_app_sha256 ||
      !decodeUtf8(app).includes("connect-app-host")
    ) {
      throw new Error("qualified App Host bridge changed");
    }

    phase = "validate_qualified_preload";
    const qualifiedPreload = await readRegular(
      path.join(candidateRoot, ASSETS_RELATIVE, checked.qualified_preload_name),
      4 * 1024 * 1024,
    );
    if (sha256(qualifiedPreload) !== checked.qualified_preload_sha256) {
      throw new Error("qualified preload changed");
    }

    phase = "validate_panel_module";
    const panel = await readRegular(panelPath, 256 * 1024);
    if (sha256(panel) !== checked.panel_sha256) {
      throw new Error("standalone panel hash changed");
    }
    const panelText = decodeUtf8(panel);
    for (const marker of [
      "Router accounts",
      "/__backend/codex-router/status",
      "/__backend/codex-router/switch",
      "Cross-account continuity is not verified",
      "installRouterAccountPanel",
    ]) {
      if (!panelText.includes(marker)) {
        throw new Error("standalone panel contract changed");
      }
    }

    phase = "prepare_output";
    const panelScript = `<script type="module" src="./assets/${checked.panel_name}"></script>`;
    const index = Buffer.from(indexText.replace(preloadAnchor, `${preloadAnchor}\n    ${panelScript}`));
    const outputText = decodeUtf8(index);
    if (
      outputText.split(preloadAnchor).length - 1 !== 1 ||
      outputText.split(panelScript).length - 1 !== 1 ||
      outputText.split(appReference).length - 1 !== 2
    ) {
      throw new Error("standalone panel index contract changed");
    }
    const panelCompressed = compressed(panel);
    const indexCompressed = compressed(index);

    phase = "write_output";
    const panelRelative = `${ASSETS_RELATIVE}/${checked.panel_name}`;
    await writeReleaseFile(candidateRoot, panelRelative, panel);
    await writeReleaseFile(candidateRoot, `${panelRelative}.gz`, panelCompressed.gzip);
    await writeReleaseFile(candidateRoot, `${panelRelative}.br`, panelCompressed.brotli);
    await writeReleaseFile(candidateRoot, INDEX_RELATIVE, index);
    await writeReleaseFile(candidateRoot, `${INDEX_RELATIVE}.gz`, indexCompressed.gzip);
    await writeReleaseFile(candidateRoot, `${INDEX_RELATIVE}.br`, indexCompressed.brotli);

    return Object.freeze({
      event: "standalone_router_panel_installed",
      qualified_app_unchanged: true,
      qualified_preload_unchanged: true,
      panel_name: checked.panel_name,
      panel_sha256: sha256(panel),
      panel_gzip_sha256: sha256(panelCompressed.gzip),
      panel_brotli_sha256: sha256(panelCompressed.brotli),
      index_sha256: sha256(index),
      index_gzip_sha256: sha256(indexCompressed.gzip),
      index_brotli_sha256: sha256(indexCompressed.brotli),
    });
  } catch {
    throw new Error(`standalone panel install failed at ${phase}`);
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
      throw new Error("standalone panel option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("standalone panel command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installStandaloneRouterPanel(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
