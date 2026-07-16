#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CODEX_WEB_REVISION = "888692f7d885118c6a92bbaf60cf2121f5947adf";
const EXPECTED_MAIN_SHA256 = "93cae9db150ef3a17ac859d0de803b608d64d64ee22beaed5ffb5453641d3788";
const integrationDirectory = fileURLToPath(new URL(".", import.meta.url));
const overlaySource = path.join(integrationDirectory, "src", "server", "router-status-bridge.ts");

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function applyStatusBridge({ codexWebRoot, revision = null } = {}) {
  if (typeof codexWebRoot !== "string" || !path.isAbsolute(codexWebRoot)) {
    throw new Error("codex-web root must be an absolute path");
  }
  if (revision !== EXPECTED_CODEX_WEB_REVISION) {
    throw new Error("codex-web revision is not supported");
  }
  const mainPath = path.join(codexWebRoot, "src", "server", "main.ts");
  const targetOverlay = path.join(codexWebRoot, "src", "server", "router-status-bridge.ts");
  const original = await fs.readFile(mainPath, "utf8");
  if (digest(original) !== EXPECTED_MAIN_SHA256) {
    throw new Error("codex-web main source does not match the pinned revision");
  }
  const importAnchor = 'import { glob } from "glob";';
  const registrationAnchor = "  const app = Fastify({ logger: false });";
  if (!original.includes(importAnchor) || !original.includes(registrationAnchor)) {
    throw new Error("codex-web integration anchors are unavailable");
  }
  const patched = original
    .replace(importAnchor, `${importAnchor}\nimport { registerRouterStatusBridge } from "./router-status-bridge";`)
    .replace(registrationAnchor, `${registrationAnchor}\n  await registerRouterStatusBridge(app, process.env);`);
  await fs.copyFile(overlaySource, targetOverlay, fs.constants.COPYFILE_EXCL);
  try {
    await fs.writeFile(mainPath, patched);
  } catch (error) {
    await fs.rm(targetOverlay, { force: true });
    throw error;
  }
}

async function cli() {
  const codexWebRoot = process.argv[2];
  if (!codexWebRoot || !path.isAbsolute(codexWebRoot)) {
    throw new Error("usage: apply-status-bridge.mjs /absolute/path/to/codex-web");
  }
  const revision = spawnSync("git", ["-C", codexWebRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (revision.status !== 0) throw new Error("codex-web revision is unavailable");
  await applyStatusBridge({ codexWebRoot, revision: revision.stdout.trim() });
  process.stdout.write("codex-web optional status bridge applied\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(() => {
    process.stderr.write("codex-web optional status bridge could not be applied\n");
    process.exitCode = 1;
  });
}
