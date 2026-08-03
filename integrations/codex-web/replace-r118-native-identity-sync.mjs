#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const INDEX = "scratch/asar/webview/index.html";
const ASSETS = "scratch/asar/webview/assets";
const OLD_CONTROLLER = "router-account-controller-e506d62f.js";
const OLD_CONTROLLER_SHA256 = "e506d62f667ec5d418de552989000238b95f725426a3d3410530d68bb8cbb0bd";
const OLD_INDEX_SHA256 = "e83447c096a4150890b88f3e93dbd603d011b9765e9d5a8fe1b58b63a94ec4e1";
const OLD_BRIDGE_SHA256 = "cec53389f8893f9ac2cf821dc2ac3a51b0d7fdd1537a3b32aba137e429515e62";
const NEW_BRIDGE_SHA256 = "54d170bfaa484d936149e9ea130052d63a6533e49a4f437b6c338fc55de1ecb1";
const OLD_ANCHOR = `      if (!response.ok) throw new Error("manual switch request failed");
      await refresh();`;
const NEW_BLOCK = `      if (!response.ok) throw new Error("manual switch request failed");
      if (
        !isRecord(response.body) || response.body.accepted !== true ||
        response.body.account_alias !== account.alias ||
        response.body.continuity !== "new_backend_session" ||
        response.body.native_identity_rebound !== true ||
        response.body.web_restart_required !== true
      ) throw new Error("manual switch response was invalid");
      transientMessage = "Switch complete. Starting a new backend session…";
      publish();
      window.setTimeout(() => window.location.reload(), 1_500);
      return;`;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function r118ControllerSource(controller) {
  if (
    typeof controller !== "string" ||
    controller.split(OLD_ANCHOR).length - 1 !== 1 ||
    controller.includes("native_identity_rebound")
  ) throw new Error("R118 controller anchor is unavailable");
  return controller.replace(OLD_ANCHOR, NEW_BLOCK);
}

function compressed(bytes) {
  return {
    gzip: gzipSync(bytes, { level: 9, mtime: 0 }),
    brotli: brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  };
}

async function regular(filePath) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error("R118 input is invalid");
  }
  return fs.readFile(filePath);
}

async function atomicWrite(filePath, bytes, mode = 0o644) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function replaceR118NativeIdentitySync({ candidate, routerBridge } = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof routerBridge !== "string" || !path.isAbsolute(routerBridge)
  ) throw new Error("R118 paths are invalid");
  const root = await fs.lstat(candidate);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("R118 candidate is invalid");
  const indexPath = path.join(candidate, INDEX);
  const oldControllerPath = path.join(candidate, ASSETS, OLD_CONTROLLER);
  const bridgePath = path.join(candidate, "src/server/router-status-bridge.js");
  const [indexBytes, controllerBytes, oldBridgeBytes, bridgeBytes] = await Promise.all([
    regular(indexPath),
    regular(oldControllerPath),
    regular(bridgePath),
    regular(routerBridge),
  ]);
  if (
    digest(indexBytes) !== OLD_INDEX_SHA256 || digest(controllerBytes) !== OLD_CONTROLLER_SHA256 ||
    digest(oldBridgeBytes) !== OLD_BRIDGE_SHA256 || digest(bridgeBytes) !== NEW_BRIDGE_SHA256
  ) throw new Error("R118 predecessor changed");
  const nextControllerBytes = Buffer.from(
    r118ControllerSource(controllerBytes.toString("utf8")),
    "utf8",
  );
  const nextControllerSha256 = digest(nextControllerBytes);
  const nextController = `router-account-controller-${nextControllerSha256.slice(0, 8)}.js`;
  const nextControllerPath = path.join(candidate, ASSETS, nextController);
  const index = indexBytes.toString("utf8");
  if (index.split(`./assets/${OLD_CONTROLLER}`).length - 1 !== 1) {
    throw new Error("R118 index anchor is unavailable");
  }
  const nextIndexBytes = Buffer.from(
    index.replace(`./assets/${OLD_CONTROLLER}`, `./assets/${nextController}`),
    "utf8",
  );
  const controllerCompressed = compressed(nextControllerBytes);
  const indexCompressed = compressed(nextIndexBytes);
  await atomicWrite(nextControllerPath, nextControllerBytes);
  await atomicWrite(`${nextControllerPath}.gz`, controllerCompressed.gzip);
  await atomicWrite(`${nextControllerPath}.br`, controllerCompressed.brotli);
  await atomicWrite(indexPath, nextIndexBytes);
  await atomicWrite(`${indexPath}.gz`, indexCompressed.gzip);
  await atomicWrite(`${indexPath}.br`, indexCompressed.brotli);
  await atomicWrite(bridgePath, bridgeBytes);
  await Promise.all([
    fs.rm(oldControllerPath),
    fs.rm(`${oldControllerPath}.gz`),
    fs.rm(`${oldControllerPath}.br`),
  ]);
  return Object.freeze({
    event: "r118_native_identity_sync_installed",
    controller_asset: nextController,
    controller_sha256: nextControllerSha256,
    index_sha256: digest(nextIndexBytes),
    router_bridge_sha256: digest(bridgeBytes),
    continuity: "new_backend_session",
  });
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === "--candidate") output.candidate = value;
    else if (flag === "--router-bridge") output.routerBridge = value;
    else throw new Error("R118 argument is invalid");
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR118NativeIdentitySync(parseArgs(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => { process.stderr.write("R118 native identity sync replacement failed\n"); process.exitCode = 1; },
  );
}
