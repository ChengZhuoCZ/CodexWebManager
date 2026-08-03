#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = "scratch/asar/webview/index.html";
const ASSETS = "scratch/asar/webview/assets";
const CONTROLLER = "router-account-controller-041ab79a.js";
const STATUS_BRIDGE = "src/server/router-status-bridge.js";
const ACCOUNT_MANAGEMENT = "src/server/router-account-management.js";
const PREDECESSOR = Object.freeze({
  index: "f51092f7915326b14a55cb0fdfaac018ef78aad54939d9384c5287486e17855e",
  controller: "041ab79a6516f72e257f1adf207e27a30fbe0129241aea4b89a031cf5eec0429",
  statusBridge: "54d170bfaa484d936149e9ea130052d63a6533e49a4f437b6c338fc55de1ecb1",
  accountManagement: "a676d6fb4a80cc3faa839bd39f72831fe2d862225e6afa1fa6676a3225cc3dec",
});
const SUCCESSOR = Object.freeze({
  statusBridge: "ea4fdbf76505c7d8dc330fcbd415ccb8ac59c27493b62e171f5a7905952e9bdd",
  accountManagement: "d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9",
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regular(filePath, expected) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error("R119 input is invalid");
  }
  const bytes = await fs.readFile(filePath);
  if (digest(bytes) !== expected) throw new Error("R119 predecessor changed");
  return bytes;
}

async function atomicWrite(filePath, bytes, mode = 0o644) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function replaceR119ManagerFraming({ candidate, statusBridge, accountManagement } = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof statusBridge !== "string" || !path.isAbsolute(statusBridge) ||
    typeof accountManagement !== "string" || !path.isAbsolute(accountManagement)
  ) throw new Error("R119 paths are invalid");
  const root = await fs.lstat(candidate);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("R119 candidate is invalid");
  const [index, controller, oldStatus, oldManagement, nextStatus, nextManagement] = await Promise.all([
    regular(path.join(candidate, INDEX), PREDECESSOR.index),
    regular(path.join(candidate, ASSETS, CONTROLLER), PREDECESSOR.controller),
    regular(path.join(candidate, STATUS_BRIDGE), PREDECESSOR.statusBridge),
    regular(path.join(candidate, ACCOUNT_MANAGEMENT), PREDECESSOR.accountManagement),
    regular(statusBridge, SUCCESSOR.statusBridge),
    regular(accountManagement, SUCCESSOR.accountManagement),
  ]);
  void index;
  void controller;
  void oldStatus;
  void oldManagement;
  await atomicWrite(path.join(candidate, STATUS_BRIDGE), nextStatus);
  await atomicWrite(path.join(candidate, ACCOUNT_MANAGEMENT), nextManagement);
  return Object.freeze({
    event: "r119_manager_framing_installed",
    status_bridge_sha256: digest(nextStatus),
    account_management_sha256: digest(nextManagement),
    continuity: "new_backend_session",
  });
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === "--candidate") output.candidate = value;
    else if (flag === "--status-bridge") output.statusBridge = value;
    else if (flag === "--account-management") output.accountManagement = value;
    else throw new Error("R119 argument is invalid");
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR119ManagerFraming(parseArgs(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => { process.stderr.write("R119 manager framing replacement failed\n"); process.exitCode = 1; },
  );
}
