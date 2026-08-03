#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const INDEX_RELATIVE = "scratch/asar/webview/index.html";
const ASSETS_RELATIVE = "scratch/asar/webview/assets";

export const R116_REACT_ACCOUNT_SETTINGS_CONTRACT = Object.freeze({
  predecessor_index_sha256: "16f9bbe52966d139140d58fb2c5f90099d116da20657c71dbe85f0e2bbbe5368",
  predecessor_panel_name: "router-account-panel-270c1de0.js",
  predecessor_panel_sha256: "270c1de071c9f8af11938114fc7e102f2e8005762f1940c7730bc12c094f0fb2",
  predecessor_lifecycle_name: "router-account-surface-lifecycle.js",
  predecessor_lifecycle_sha256: "1a4ffdf16ab912adc5d9c2960a0a0ce50db87e434d956da8613c35b243ee1fcd",
  predecessor_preload_name: "preload-65708a1c.js",
  predecessor_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  qualified_app_name: "app-initial-BTphDPeq.js",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  controller_name: "router-account-controller-e506d62f.js",
  controller_sha256: "e506d62f667ec5d418de552989000238b95f725426a3d3410530d68bb8cbb0bd",
  react_preload_name: "preload-e102b9bc.js",
  react_preload_sha256: "e102b9bc5a877847b51df6e45a65c9e262412e26015227306a8f2b190cacdc4c",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRegularFile(target, expected, maximumBytes) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximumBytes || (metadata.mode & 0o022) !== 0
  ) throw new Error("R116 input boundary is invalid");
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== expected) throw new Error("R116 input changed");
  return bytes;
}

function replaceExactlyOnce(value, anchor, replacement) {
  const first = value.indexOf(anchor);
  if (first < 0 || value.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("R116 predecessor index anchor changed");
  }
  return `${value.slice(0, first)}${replacement}${value.slice(first + anchor.length)}`;
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

async function writeNew(target, bytes) {
  await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  await fs.chmod(target, 0o644);
}

async function writeCompressed(target, bytes) {
  const encodings = compressed(bytes);
  await writeNew(target, bytes);
  await writeNew(`${target}.gz`, encodings.gzip);
  await writeNew(`${target}.br`, encodings.brotli);
  return encodings;
}

async function removeAssetTriplet(target) {
  for (const suffix of ["", ".gz", ".br"]) {
    try {
      await fs.unlink(`${target}${suffix}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function replaceR116ReactAccountSettings({
  candidate,
  controllerModule,
  reactPreload,
} = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof controllerModule !== "string" || !path.isAbsolute(controllerModule) ||
    typeof reactPreload !== "string" || !path.isAbsolute(reactPreload)
  ) throw new Error("R116 replacement option is invalid");
  const candidateMetadata = await fs.lstat(candidate);
  if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()) {
    throw new Error("R116 candidate root is invalid");
  }

  const contract = R116_REACT_ACCOUNT_SETTINGS_CONTRACT;
  const assets = path.join(candidate, ASSETS_RELATIVE);
  const indexTarget = path.join(candidate, INDEX_RELATIVE);
  const [indexBytes, controllerBytes, preloadBytes] = await Promise.all([
    readRegularFile(indexTarget, contract.predecessor_index_sha256, 256 * 1024),
    readRegularFile(controllerModule, contract.controller_sha256, 128 * 1024),
    readRegularFile(reactPreload, contract.react_preload_sha256, 1024 * 1024),
    readRegularFile(
      path.join(assets, contract.predecessor_panel_name),
      contract.predecessor_panel_sha256,
      256 * 1024,
    ),
    readRegularFile(
      path.join(assets, contract.predecessor_lifecycle_name),
      contract.predecessor_lifecycle_sha256,
      64 * 1024,
    ),
    readRegularFile(
      path.join(assets, contract.predecessor_preload_name),
      contract.predecessor_preload_sha256,
      1024 * 1024,
    ),
    readRegularFile(
      path.join(assets, contract.qualified_app_name),
      contract.qualified_app_sha256,
      20 * 1024 * 1024,
    ),
  ]);
  const predecessorScripts = `    <script type="module" src="./assets/${contract.predecessor_preload_name}"></script>\n` +
    `    <script type="module" src="./assets/${contract.predecessor_panel_name}"></script>`;
  const successorScripts = `    <script type="module" src="./assets/${contract.controller_name}"></script>\n` +
    `    <script type="module" src="./assets/${contract.react_preload_name}"></script>`;
  const nextIndex = Buffer.from(replaceExactlyOnce(
    indexBytes.toString("utf8"),
    predecessorScripts,
    successorScripts,
  ));
  if (
    nextIndex.includes(Buffer.from(contract.predecessor_panel_name)) ||
    nextIndex.includes(Buffer.from(contract.predecessor_lifecycle_name)) ||
    nextIndex.includes(Buffer.from(contract.predecessor_preload_name))
  ) throw new Error("R116 predecessor remained referenced");

  const controllerTarget = path.join(assets, contract.controller_name);
  const preloadTarget = path.join(assets, contract.react_preload_name);
  const temporaryIndex = `${indexTarget}.r116-new`;
  const controllerCompressed = await writeCompressed(controllerTarget, controllerBytes);
  const preloadCompressed = await writeCompressed(preloadTarget, preloadBytes);
  const indexCompressed = compressed(nextIndex);
  await writeNew(temporaryIndex, nextIndex);
  await fs.writeFile(`${indexTarget}.gz`, indexCompressed.gzip, { mode: 0o644 });
  await fs.writeFile(`${indexTarget}.br`, indexCompressed.brotli, { mode: 0o644 });
  await fs.rename(temporaryIndex, indexTarget);
  await removeAssetTriplet(path.join(assets, contract.predecessor_panel_name));
  await removeAssetTriplet(path.join(assets, contract.predecessor_lifecycle_name));
  await removeAssetTriplet(path.join(assets, contract.predecessor_preload_name));

  return Object.freeze({
    event: "r116_react_account_settings_replaced",
    index_sha256: sha256(nextIndex),
    index_gzip_sha256: sha256(indexCompressed.gzip),
    index_brotli_sha256: sha256(indexCompressed.brotli),
    controller_name: contract.controller_name,
    controller_sha256: sha256(controllerBytes),
    controller_gzip_sha256: sha256(controllerCompressed.gzip),
    controller_brotli_sha256: sha256(controllerCompressed.brotli),
    react_preload_name: contract.react_preload_name,
    react_preload_sha256: sha256(preloadBytes),
    react_preload_gzip_sha256: sha256(preloadCompressed.gzip),
    react_preload_brotli_sha256: sha256(preloadCompressed.brotli),
    shadow_dom: false,
    native_menu_entry_count: 1,
  });
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--controller-module", "controllerModule"],
    ["--react-preload", "reactPreload"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R116 replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 3) {
    throw new Error("R116 replacement command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR116ReactAccountSettings(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
