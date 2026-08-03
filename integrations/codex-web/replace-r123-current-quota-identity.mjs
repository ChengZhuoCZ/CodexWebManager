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
const ASSETS_RELATIVE = "scratch/asar/webview/assets";
const OLD_LABEL = "Refresh Primary weekly quota";
const NEW_LABEL = "Refresh current account weekly quota";

export const R123_CURRENT_QUOTA_IDENTITY_CONTRACT = Object.freeze({
  predecessor_index_sha256: "ca1bd8b371a3001ef9bdaa5764c5da1a57b27206d2c7a10121a98791f02464d0",
  predecessor_preload_name: "preload-ba57f3d6.js",
  predecessor_preload_sha256: "ba57f3d68765fd06d0830c8d1bae5d01c35b02835f71624607733dd869d82dfb",
  controller_name: "router-account-controller-041ab79a.js",
  controller_sha256: "041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429",
  predecessor_status_bridge_sha256: "ea4fdbf76505c7d8dc330fcbd415ccb8ac59c27493b62e171f5a7905952e9bdd",
  successor_status_bridge_sha256: "30a7a21262e168269fd9be386a091310723b12b59e2e1c546a152ad836fdfce8",
  account_management_sha256: "d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRegularFile(target, expected, maximumBytes) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximumBytes || (metadata.mode & 0o022) !== 0
  ) throw new Error("R123 input boundary is invalid");
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== expected) throw new Error("R123 input changed");
  return bytes;
}

function replaceExactlyOnce(value, anchor, replacement) {
  const first = value.indexOf(anchor);
  if (first < 0 || value.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("R123 source anchor changed");
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

async function writeNewTriplet(target, bytes) {
  const encodings = compressed(bytes);
  for (const [suffix, value] of [["", bytes], [".gz", encodings.gzip], [".br", encodings.brotli]]) {
    await fs.writeFile(`${target}${suffix}`, value, { flag: "wx", mode: 0o644 });
    await fs.chmod(`${target}${suffix}`, 0o644);
  }
  return encodings;
}

async function removeTriplet(target) {
  for (const suffix of ["", ".gz", ".br"]) await fs.unlink(`${target}${suffix}`);
}

async function replaceRegularFile(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function replaceR123CurrentQuotaIdentity({
  candidate,
  statusBridge,
  contract = R123_CURRENT_QUOTA_IDENTITY_CONTRACT,
} = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof statusBridge !== "string" || !path.isAbsolute(statusBridge)
  ) throw new Error("R123 replacement option is invalid");
  const root = await fs.lstat(candidate);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("R123 candidate root is invalid");

  const assets = path.join(candidate, ASSETS_RELATIVE);
  const indexTarget = path.join(candidate, INDEX_RELATIVE);
  const preloadTarget = path.join(assets, contract.predecessor_preload_name);
  const installedBridge = path.join(candidate, "src/server/router-status-bridge.js");
  const [indexBytes, preloadBytes, successorBridge] = await Promise.all([
    readRegularFile(indexTarget, contract.predecessor_index_sha256, 256 * 1024),
    readRegularFile(preloadTarget, contract.predecessor_preload_sha256, 1024 * 1024),
    readRegularFile(statusBridge, contract.successor_status_bridge_sha256, 256 * 1024),
    readRegularFile(path.join(assets, contract.controller_name), contract.controller_sha256, 256 * 1024),
    readRegularFile(installedBridge, contract.predecessor_status_bridge_sha256, 256 * 1024),
    readRegularFile(
      path.join(candidate, "src/server/router-account-management.js"),
      contract.account_management_sha256,
      256 * 1024,
    ),
  ]);

  const nextPreload = Buffer.from(replaceExactlyOnce(preloadBytes.toString("utf8"), OLD_LABEL, NEW_LABEL));
  const nextPreloadSha256 = sha256(nextPreload);
  const nextPreloadName = `preload-${nextPreloadSha256.slice(0, 8)}.js`;
  const nextPreloadTarget = path.join(assets, nextPreloadName);
  const nextIndex = Buffer.from(replaceExactlyOnce(
    indexBytes.toString("utf8"),
    `./assets/${contract.predecessor_preload_name}`,
    `./assets/${nextPreloadName}`,
  ));
  const temporaryIndex = `${indexTarget}.r123-${randomUUID()}.next`;
  const preloadCompressed = await writeNewTriplet(nextPreloadTarget, nextPreload);
  const indexCompressed = compressed(nextIndex);
  try {
    await fs.writeFile(temporaryIndex, nextIndex, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporaryIndex, 0o644);
    await fs.writeFile(`${indexTarget}.gz`, indexCompressed.gzip, { mode: 0o644 });
    await fs.writeFile(`${indexTarget}.br`, indexCompressed.brotli, { mode: 0o644 });
    await fs.rename(temporaryIndex, indexTarget);
    await replaceRegularFile(installedBridge, successorBridge);
    await removeTriplet(preloadTarget);
  } catch (error) {
    await fs.rm(temporaryIndex, { force: true }).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    event: "r123_current_quota_identity_installed",
    index_sha256: sha256(nextIndex),
    index_gzip_sha256: sha256(indexCompressed.gzip),
    index_brotli_sha256: sha256(indexCompressed.brotli),
    react_preload_name: nextPreloadName,
    react_preload_sha256: nextPreloadSha256,
    react_preload_gzip_sha256: sha256(preloadCompressed.gzip),
    react_preload_brotli_sha256: sha256(preloadCompressed.brotli),
    router_bridge_sha256: sha256(successorBridge),
    quota_identity: "native_app_server_credential",
    model_request_sent: false,
    account_switch_sent: false,
  });
}

function parseArguments(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === "--candidate") output.candidate = value;
    else if (flag === "--status-bridge") output.statusBridge = value;
    else throw new Error("R123 replacement option is invalid");
  }
  if (values.length !== 4) throw new Error("R123 replacement command is incomplete");
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR123CurrentQuotaIdentity(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => { process.stderr.write("R123 current quota identity replacement failed\n"); process.exitCode = 1; },
  );
}
