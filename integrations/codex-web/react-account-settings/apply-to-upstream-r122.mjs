#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_SHA256 = "9650646532dd9e9da7e03f0adf6cff58478c1e0a50069a13dbf8e9454b047501";
const ORIGINAL_SHIM_SHA256 = "1c9af4be504dbbf288bbf47f8bb91bca64ef66e5d4908eafc824a6336962fafb";
const PATCHED_SHIM_SHA256 = "28315fab993b78206fe4c37cce728bc55add53a934073d84757c6d17587495c4";
const PACKAGE_SHA256 = "46cdfe8a118f5963ca8fff7babf31ef1e5d8ad01f2824cd849123c775c088cea";
const PACKAGE_LOCK_SHA256 = "26a65b45d37673fa940690359b5b337a5789e1ad2b145dedfa4e5fecab7b2a97";
const VITE_CONFIG_SHA256 = "ddcd625927e3f831b33eac0d25aa39e3223424d71d712ba083daf10ca0ed4e4a";
const PRELOAD_INPUT_SHA256 = "0e27fe62e3ee829b76b7e11ce2e1a8cc917d67f6316311a26159444e8c89d7f5";
const EXPECTED_PRELOAD_SHA256 = "ba57f3d68765fd06d0830c8d1bae5d01c35b02835f71624607733dd869d82dfb";

const IMPORT_ANCHOR = `import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";`;
const IMPORT_REPLACEMENT = `${IMPORT_ANCHOR}
import { installAccountSettingsWindow } from "./account-settings-window";`;
const START_ANCHOR = `};

ensureSocket();

export const contextBridge = {`;
const START_REPLACEMENT = `};

installAccountSettingsWindow();
ensureSocket();

export const contextBridge = {`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRegularFile(target, maximumBytes) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximumBytes || (metadata.mode & 0o022) !== 0
  ) throw new Error("R122 upstream input boundary is invalid");
  return fs.readFile(target);
}

async function expectHash(target, expected, maximumBytes = 8 * 1024 * 1024) {
  const bytes = await readRegularFile(target, maximumBytes);
  if (sha256(bytes) !== expected) throw new Error("R122 upstream input changed");
  return bytes;
}

function replaceExactlyOnce(value, anchor, replacement) {
  const first = value.indexOf(anchor);
  if (first < 0 || value.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("R122 upstream source anchor changed");
  }
  return `${value.slice(0, first)}${replacement}${value.slice(first + anchor.length)}`;
}

export async function applyR122NativeMenuContract({ upstreamRoot, source } = {}) {
  if (
    typeof upstreamRoot !== "string" || !path.isAbsolute(upstreamRoot) ||
    typeof source !== "string" || !path.isAbsolute(source)
  ) throw new Error("R122 source build option is invalid");
  const rootMetadata = await fs.lstat(upstreamRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("R122 upstream root is invalid");
  }
  await Promise.all([
    expectHash(path.join(upstreamRoot, "package.json"), PACKAGE_SHA256),
    expectHash(path.join(upstreamRoot, "package-lock.json"), PACKAGE_LOCK_SHA256),
    expectHash(path.join(upstreamRoot, "vite.browser.config.ts"), VITE_CONFIG_SHA256),
    expectHash(
      path.join(upstreamRoot, "scratch/asar/.vite/build/preload.js"),
      PRELOAD_INPUT_SHA256,
    ),
  ]);
  const [sourceBytes, shimBytes] = await Promise.all([
    expectHash(source, SOURCE_SHA256, 256 * 1024),
    expectHash(path.join(upstreamRoot, "src/browser/shim.ts"), ORIGINAL_SHIM_SHA256),
  ]);
  const sourceTarget = path.join(upstreamRoot, "src/browser/account-settings-window.tsx");
  const sourceTargetMetadata = await fs.lstat(path.dirname(sourceTarget));
  if (!sourceTargetMetadata.isDirectory() || sourceTargetMetadata.isSymbolicLink()) {
    throw new Error("R122 browser source root is invalid");
  }
  await fs.writeFile(sourceTarget, sourceBytes, { flag: "wx", mode: 0o644 });
  let shim = shimBytes.toString("utf8");
  shim = replaceExactlyOnce(shim, IMPORT_ANCHOR, IMPORT_REPLACEMENT);
  shim = replaceExactlyOnce(shim, START_ANCHOR, START_REPLACEMENT);
  if (sha256(shim) !== PATCHED_SHIM_SHA256) {
    throw new Error("R122 patched shim changed");
  }
  await fs.writeFile(path.join(upstreamRoot, "src/browser/shim.ts"), shim, {
    encoding: "utf8",
    mode: 0o644,
  });
  return Object.freeze({
    event: "r122_native_menu_contract_source_applied",
    upstream_revision: "c3e92f0fc16dcbbdd334b3d4f7228c5795a8adf7",
    source_sha256: SOURCE_SHA256,
    patched_shim_sha256: PATCHED_SHIM_SHA256,
    expected_preload_sha256: EXPECTED_PRELOAD_SHA256,
    build_command: "pnpm run build:browser",
  });
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--upstream-root", "upstreamRoot"],
    ["--source", "source"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R122 source build option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R122 source build command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyR122NativeMenuContract(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
