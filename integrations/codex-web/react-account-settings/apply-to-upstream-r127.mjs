#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_REVISION = "c3e92f0fc16dcbbdd334b3d4f7228c5795a8adf7";
const ORIGINAL_SHIM_SHA256 = "1c9af4be504dbbf288bbf47f8bb91bca64ef66e5d4908eafc824a6336962fafb";
const PACKAGE_SHA256 = "46cdfe8a118f5963ca8fff7babf31ef1e5d8ad01f2824cd849123c775c088cea";
const PACKAGE_LOCK_SHA256 = "26a65b45d37673fa940690359b5b337a5789e1ad2b145dedfa4e5fecab7b2a97";
const VITE_CONFIG_SHA256 = "ddcd625927e3f831b33eac0d25aa39e3223424d71d712ba083daf10ca0ed4e4a";
const PRELOAD_INPUT_SHA256 = "0e27fe62e3ee829b76b7e11ce2e1a8cc917d67f6316311a26159444e8c89d7f5";
const INPUTS = Object.freeze({
  accountEntry: Object.freeze({
    file: "account-settings-entry.ts",
    sha256: "b45e555a241e85e20c264e4321ba91290f7714f5ed94d16b99a0510c33d072ee",
  }),
  accountSettings: Object.freeze({
    file: "account-settings-window.tsx",
    sha256: "baf5bda0921674800115a2a8229d5c0e9b87f82165379927d68fab53a3fcdc32",
  }),
  browserMessagePolicy: Object.freeze({
    file: "browser-message-policy.ts",
    sha256: "c101b238357da9cdf95a576da4946a95cbad4402cc106f0b852d76c02869565b",
  }),
  browserSession: Object.freeze({
    file: "browser-session.ts",
    sha256: "c0d17926725e8e030d5fdc1beadb6315a282b7dc28f2c8dc7b0e2a46587bee80",
  }),
});

const IMPORT_ANCHOR = `import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";`;
const IMPORT_REPLACEMENT = `${IMPORT_ANCHOR}
import { installAccountSettingsEntry } from "./account-settings-entry";
import { installBrowserFetchPolicy } from "./browser-session";`;
const START_ANCHOR = `};

ensureSocket();

export const contextBridge = {`;
const START_REPLACEMENT = `};

installBrowserFetchPolicy();
installAccountSettingsEntry();
ensureSocket();

export const contextBridge = {`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readPinnedFile(target, expected, maximumBytes = 8 * 1024 * 1024) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximumBytes || (metadata.mode & 0o022) !== 0
  ) throw new Error("R127 source boundary is invalid");
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== expected) throw new Error("R127 source input changed");
  return bytes;
}

function replaceExactlyOnce(value, anchor, replacement) {
  const first = value.indexOf(anchor);
  if (first < 0 || value.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("R127 source anchor changed");
  }
  return `${value.slice(0, first)}${replacement}${value.slice(first + anchor.length)}`;
}

export async function applyR127StartupPolicy({ upstreamRoot, sourceRoot } = {}) {
  if (
    typeof upstreamRoot !== "string" || !path.isAbsolute(upstreamRoot) ||
    typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)
  ) throw new Error("R127 source build option is invalid");
  const root = await fs.lstat(upstreamRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("R127 upstream root is invalid");

  const browserRoot = path.join(upstreamRoot, "src/browser");
  const sourceBrowserRoot = path.join(sourceRoot, "src/browser");
  const accountSource = path.join(
    sourceRoot,
    "react-account-settings/account-settings-window.tsx",
  );
  const [shimBytes, entryBytes, accountBytes, policyBytes, sessionBytes] = await Promise.all([
    readPinnedFile(path.join(browserRoot, "shim.ts"), ORIGINAL_SHIM_SHA256),
    readPinnedFile(
      path.join(sourceRoot, `react-account-settings/${INPUTS.accountEntry.file}`),
      INPUTS.accountEntry.sha256,
      64 * 1024,
    ),
    readPinnedFile(accountSource, INPUTS.accountSettings.sha256, 256 * 1024),
    readPinnedFile(
      path.join(sourceBrowserRoot, INPUTS.browserMessagePolicy.file),
      INPUTS.browserMessagePolicy.sha256,
      256 * 1024,
    ),
    readPinnedFile(
      path.join(sourceBrowserRoot, INPUTS.browserSession.file),
      INPUTS.browserSession.sha256,
      64 * 1024,
    ),
    readPinnedFile(path.join(upstreamRoot, "package.json"), PACKAGE_SHA256),
    readPinnedFile(path.join(upstreamRoot, "package-lock.json"), PACKAGE_LOCK_SHA256),
    readPinnedFile(path.join(upstreamRoot, "vite.browser.config.ts"), VITE_CONFIG_SHA256),
    readPinnedFile(
      path.join(upstreamRoot, "scratch/asar/.vite/build/preload.js"),
      PRELOAD_INPUT_SHA256,
    ),
  ]);

  let shim = shimBytes.toString("utf8");
  shim = replaceExactlyOnce(shim, IMPORT_ANCHOR, IMPORT_REPLACEMENT);
  shim = replaceExactlyOnce(shim, START_ANCHOR, START_REPLACEMENT);
  const targets = [
    [path.join(browserRoot, INPUTS.accountEntry.file), entryBytes],
    [path.join(browserRoot, INPUTS.accountSettings.file), accountBytes],
    [path.join(browserRoot, INPUTS.browserMessagePolicy.file), policyBytes],
    [path.join(browserRoot, INPUTS.browserSession.file), sessionBytes],
  ];
  for (const [target, bytes] of targets) {
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  }
  await fs.writeFile(path.join(browserRoot, "shim.ts"), shim, { mode: 0o644 });
  return Object.freeze({
    event: "r127_startup_policy_source_applied",
    upstream_revision: UPSTREAM_REVISION,
    patched_shim_sha256: sha256(shim),
    exact_telemetry_short_circuit: true,
    native_account_window: true,
    build_command: "pnpm run build:browser",
  });
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] === "--upstream-root") options.upstreamRoot = values[index + 1];
    else if (values[index] === "--source-root") options.sourceRoot = values[index + 1];
    else throw new Error("R127 source build option is invalid");
  }
  if (values.length !== 4 || Object.keys(options).length !== 2) {
    throw new Error("R127 source build command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyR127StartupPolicy(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
