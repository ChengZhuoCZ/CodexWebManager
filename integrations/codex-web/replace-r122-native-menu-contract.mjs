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

export const R122_NATIVE_MENU_CONTRACT = Object.freeze({
  predecessor_index_sha256: "731d8f71bc1dca7ccd359c21d391530f8da4d53955fecaf5bbf8575045f37441",
  predecessor_preload_name: "preload-e9339fb8.js",
  predecessor_preload_sha256: "e9339fb81b42e829904b96e06374d4d04c56be32ada333659935ed0c051db3f2",
  controller_name: "router-account-controller-041ab79a.js",
  controller_sha256: "041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429",
  status_bridge_sha256: "ea4fdbf76505c7d8dc330fcbd415ccb8ac59c27493b62e171f5a7905952e9bdd",
  account_management_sha256: "d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9",
  successor_preload_name: "preload-ba57f3d6.js",
  successor_preload_sha256: "ba57f3d68765fd06d0830c8d1bae5d01c35b02835f71624607733dd869d82dfb",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRegularFile(target, expected, maximumBytes) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximumBytes || (metadata.mode & 0o022) !== 0
  ) throw new Error("R122 input boundary is invalid");
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== expected) throw new Error("R122 input changed");
  return bytes;
}

function replaceExactlyOnce(value, anchor, replacement) {
  const first = value.indexOf(anchor);
  if (first < 0 || value.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("R122 predecessor index anchor changed");
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

export async function replaceR122NativeMenuContract({
  candidate,
  reactPreload,
  contract = R122_NATIVE_MENU_CONTRACT,
} = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof reactPreload !== "string" || !path.isAbsolute(reactPreload)
  ) throw new Error("R122 replacement option is invalid");
  const candidateMetadata = await fs.lstat(candidate);
  if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()) {
    throw new Error("R122 candidate root is invalid");
  }

  if (!contract || typeof contract !== "object") {
    throw new Error("R122 replacement contract is invalid");
  }
  const assets = path.join(candidate, ASSETS_RELATIVE);
  const indexTarget = path.join(candidate, INDEX_RELATIVE);
  const [indexBytes, preloadBytes] = await Promise.all([
    readRegularFile(indexTarget, contract.predecessor_index_sha256, 256 * 1024),
    readRegularFile(reactPreload, contract.successor_preload_sha256, 1024 * 1024),
    readRegularFile(
      path.join(assets, contract.predecessor_preload_name),
      contract.predecessor_preload_sha256,
      1024 * 1024,
    ),
    readRegularFile(
      path.join(assets, contract.controller_name),
      contract.controller_sha256,
      256 * 1024,
    ),
    readRegularFile(
      path.join(candidate, "src/server/router-status-bridge.js"),
      contract.status_bridge_sha256,
      256 * 1024,
    ),
    readRegularFile(
      path.join(candidate, "src/server/router-account-management.js"),
      contract.account_management_sha256,
      256 * 1024,
    ),
  ]);
  const oldReference = `./assets/${contract.predecessor_preload_name}`;
  const newReference = `./assets/${contract.successor_preload_name}`;
  const nextIndex = Buffer.from(replaceExactlyOnce(
    indexBytes.toString("utf8"),
    oldReference,
    newReference,
  ));
  if (nextIndex.includes(Buffer.from(contract.predecessor_preload_name))) {
    throw new Error("R122 predecessor remained referenced");
  }

  const preloadTarget = path.join(assets, contract.successor_preload_name);
  const temporaryIndex = `${indexTarget}.r122-new`;
  const preloadCompressed = await writeCompressed(preloadTarget, preloadBytes);
  const indexCompressed = compressed(nextIndex);
  await writeNew(temporaryIndex, nextIndex);
  await fs.writeFile(`${indexTarget}.gz`, indexCompressed.gzip, { mode: 0o644 });
  await fs.writeFile(`${indexTarget}.br`, indexCompressed.brotli, { mode: 0o644 });
  await fs.rename(temporaryIndex, indexTarget);
  await removeAssetTriplet(path.join(assets, contract.predecessor_preload_name));

  return Object.freeze({
    event: "r122_native_menu_contract_replaced",
    index_sha256: sha256(nextIndex),
    index_gzip_sha256: sha256(indexCompressed.gzip),
    index_brotli_sha256: sha256(indexCompressed.brotli),
    react_preload_name: contract.successor_preload_name,
    react_preload_sha256: sha256(preloadBytes),
    react_preload_gzip_sha256: sha256(preloadCompressed.gzip),
    react_preload_brotli_sha256: sha256(preloadCompressed.brotli),
    native_menu_layout: "native-contract",
    shadow_dom: false,
    native_menu_entry_count: 1,
  });
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--react-preload", "reactPreload"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R122 replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R122 replacement command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR122NativeMenuContract(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
