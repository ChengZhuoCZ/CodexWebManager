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
import { replaceStandaloneRouterPanel } from "./replace-standalone-router-panel.mjs";

const ASSETS_RELATIVE = "scratch/asar/webview/assets";
const LIFECYCLE_NAME = "router-account-surface-lifecycle.js";

export const R115_OWNED_ACCOUNT_SURFACE_CONTRACT = Object.freeze({
  predecessor_index_sha256: "2791f3ad2fa2d761a0484cdb6ae595965dd7d3dc4c222b6b01d76509e86656bf",
  predecessor_panel_name: "router-account-panel-8a5b3659.js",
  predecessor_panel_sha256: "8a5b36594e6fd0c1dce9601d02ddefaa2ba0dc52a14babc2e3d9bd90fee1487d",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-270c1de0.js",
  replacement_panel_sha256: "270c1de071c9f8af11938114fc7e102f2e8005762f1940c7730bc12c094f0fb2",
  lifecycle_name: LIFECYCLE_NAME,
  lifecycle_sha256: "1a4ffdf16ab912adc5d9c2960a0a0ce50db87e434d956da8613c35b243ee1fcd",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readLifecycle(target) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > 64 * 1024 || (metadata.mode & 0o022) !== 0
  ) throw new Error("R115 lifecycle input boundary is invalid");
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

async function writeNew(target, bytes) {
  await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  await fs.chmod(target, 0o644);
}

export async function replaceR115OwnedAccountSurface({
  candidate,
  panelModule,
  surfaceLifecycle,
} = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof panelModule !== "string" || !path.isAbsolute(panelModule) ||
    typeof surfaceLifecycle !== "string" || !path.isAbsolute(surfaceLifecycle)
  ) throw new Error("R115 owned account-surface option is invalid");

  const lifecycle = await readLifecycle(surfaceLifecycle);
  if (sha256(lifecycle) !== R115_OWNED_ACCOUNT_SURFACE_CONTRACT.lifecycle_sha256) {
    throw new Error("R115 lifecycle source changed");
  }
  const lifecycleText = lifecycle.toString("utf8");
  if (
    !lifecycleText.includes("reduceAccountSurfaceState") ||
    !lifecycleText.includes("native_menu_closed") ||
    !lifecycleText.includes("accountDialog: state.dialogOpen")
  ) throw new Error("R115 lifecycle contract changed");

  const {
    lifecycle_name: _lifecycleName,
    lifecycle_sha256: _lifecycleSha256,
    ...panelContract
  } = R115_OWNED_ACCOUNT_SURFACE_CONTRACT;
  const result = await replaceStandaloneRouterPanel({
    candidate,
    panelModule,
    contract: panelContract,
  });
  const lifecycleTarget = path.join(candidate, ASSETS_RELATIVE, LIFECYCLE_NAME);
  const lifecycleCompressed = compressed(lifecycle);
  await writeNew(lifecycleTarget, lifecycle);
  await writeNew(`${lifecycleTarget}.gz`, lifecycleCompressed.gzip);
  await writeNew(`${lifecycleTarget}.br`, lifecycleCompressed.brotli);
  return Object.freeze({
    ...result,
    event: "r115_owned_account_surface_replaced",
    lifecycle_name: LIFECYCLE_NAME,
    lifecycle_sha256: sha256(lifecycle),
    lifecycle_gzip_sha256: sha256(lifecycleCompressed.gzip),
    lifecycle_brotli_sha256: sha256(lifecycleCompressed.brotli),
    upstream_react_tree_mutated: false,
  });
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--panel-module", "panelModule"],
    ["--surface-lifecycle", "surfaceLifecycle"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R115 owned account-surface option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 3) {
    throw new Error("R115 owned account-surface command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR115OwnedAccountSurface(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
