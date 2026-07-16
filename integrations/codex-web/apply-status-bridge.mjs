#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CODEX_WEB_REVISION = "888692f7d885118c6a92bbaf60cf2121f5947adf";
const EXPECTED_MAIN_SHA256 = "93cae9db150ef3a17ac859d0de803b608d64d64ee22beaed5ffb5453641d3788";
const EXPECTED_SHIM_SHA256 = "bd191409b7a134f1be9e698f9c16f94fd22532f4a3a6850ecb1a48e6cfa9e837";
const integrationDirectory = fileURLToPath(new URL(".", import.meta.url));
const serverOverlaySource = path.join(integrationDirectory, "src", "server", "router-status-bridge.ts");
const browserOverlaySource = path.join(integrationDirectory, "src", "browser", "router-account-panel.ts");

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
  const shimPath = path.join(codexWebRoot, "src", "browser", "shim.ts");
  const targetServerOverlay = path.join(codexWebRoot, "src", "server", "router-status-bridge.ts");
  const targetBrowserOverlay = path.join(codexWebRoot, "src", "browser", "router-account-panel.ts");
  const originalMain = await fs.readFile(mainPath, "utf8");
  if (digest(originalMain) !== EXPECTED_MAIN_SHA256) {
    throw new Error("codex-web main source does not match the pinned revision");
  }
  const originalShim = await fs.readFile(shimPath, "utf8");
  if (digest(originalShim) !== EXPECTED_SHIM_SHA256) {
    throw new Error("codex-web browser shim does not match the pinned revision");
  }
  const importAnchor = 'import { glob } from "glob";';
  const registrationAnchor = "  const app = Fastify({ logger: false });";
  const browserImportAnchor = 'import {\n  openSelectWorkspaceRootDialog,\n  type WorkspaceDirectoryEntries,\n} from "./workspace-root-dialog";';
  const browserInstallAnchor = "ensureSocket();\n\nexport const contextBridge";
  if (!originalMain.includes(importAnchor) || !originalMain.includes(registrationAnchor)) {
    throw new Error("codex-web integration anchors are unavailable");
  }
  if (!originalShim.includes(browserImportAnchor) || !originalShim.includes(browserInstallAnchor)) {
    throw new Error("codex-web browser integration anchors are unavailable");
  }
  const patchedMain = originalMain
    .replace(importAnchor, `${importAnchor}\nimport { registerRouterStatusBridge } from "./router-status-bridge";`)
    .replace(registrationAnchor, `${registrationAnchor}\n  await registerRouterStatusBridge(app, process.env);`);
  const patchedShim = originalShim
    .replace(browserImportAnchor, `${browserImportAnchor}\nimport { installRouterAccountPanel } from "./router-account-panel";`)
    .replace(browserInstallAnchor, "ensureSocket();\nvoid installRouterAccountPanel();\n\nexport const contextBridge");
  await fs.copyFile(serverOverlaySource, targetServerOverlay, fs.constants.COPYFILE_EXCL);
  try {
    await fs.copyFile(browserOverlaySource, targetBrowserOverlay, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    await fs.rm(targetServerOverlay, { force: true });
    throw error;
  }
  try {
    await Promise.all([
      fs.writeFile(mainPath, patchedMain),
      fs.writeFile(shimPath, patchedShim),
    ]);
  } catch (error) {
    await Promise.allSettled([
      fs.writeFile(mainPath, originalMain),
      fs.writeFile(shimPath, originalShim),
      fs.rm(targetServerOverlay, { force: true }),
      fs.rm(targetBrowserOverlay, { force: true }),
    ]);
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
  process.stdout.write("codex-web optional router integration applied\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(() => {
    process.stderr.write("codex-web optional status bridge could not be applied\n");
    process.exitCode = 1;
  });
}
