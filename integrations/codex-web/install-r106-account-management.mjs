#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_RELATIVE = "src/server/main.js";
const MANAGEMENT_RELATIVE = "src/server/router-account-management.js";
const SHA256 = /^[a-f0-9]{64}$/u;

export const PINNED_R106_ACCOUNT_MANAGEMENT_CONTRACT = Object.freeze({
  source_main_sha256: "ea69e94c622db32c8d7cc6156d9ffabd5be77ba608b3709eae4928b28c829e67",
  management_module_sha256: "a676d6fb4a80cc3faa839bd39f72831fe2d862225e6afa1fa6676a3225cc3dec",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

function validateContract(value) {
  const keys = ["source_main_sha256", "management_module_sha256"];
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    keys.some((key) => !SHA256.test(value[key]))
  ) throw new Error("R106 account management contract is invalid");
  return Object.freeze({ ...value });
}

async function readRegular(target, maximum) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximum || (metadata.mode & 0o022) !== 0
  ) throw new Error("R106 account management input boundary is invalid");
  return fs.readFile(target);
}

function decodeUtf8(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new Error("R106 account management input encoding is invalid");
  }
  return value;
}

async function writeReleaseFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function patchMain(input) {
  const requireAnchor = 'const router_status_bridge_1 = require("./router-status-bridge");\n';
  const startupAnchor =
    "    await (0, router_status_bridge_1.registerRouterStatusBridge)(app, process.env);\n";
  const forbidden = [
    'require("./router-account-management")',
    "registerRouterAccountManagement)(app, process.env)",
  ];
  if (
    input.split(requireAnchor).length - 1 !== 1 ||
    input.split(startupAnchor).length - 1 !== 1 ||
    forbidden.some((marker) => input.includes(marker)) ||
    !input.includes('require("./browser-session-auth")') ||
    !input.includes("registerBrowserSessionAuth)(app, process.env)") ||
    !input.includes("class WebSocketMessagePort") ||
    !input.includes('message.type === "ipc-renderer-post-message"')
  ) throw new Error("qualified R105 App Host bridge changed");

  const withImport = input.replace(
    requireAnchor,
    `${requireAnchor}const router_account_management_1 = require("./router-account-management");\n`,
  );
  const output = withImport.replace(
    startupAnchor,
    `${startupAnchor}` +
      "    await (0, router_account_management_1.registerRouterAccountManagement)(app, process.env);\n",
  );
  if (
    output.split('require("./router-account-management")').length - 1 !== 1 ||
    output.split("registerRouterAccountManagement)(app, process.env)").length - 1 !== 1 ||
    !output.includes("registerBrowserSessionAuth)(app, process.env)") ||
    !output.includes("registerRouterStatusBridge)(app, process.env)")
  ) throw new Error("R105 App Host preservation check failed");
  return output;
}

export async function installR106AccountManagement({
  candidate,
  managementModule,
  contract = PINNED_R106_ACCOUNT_MANAGEMENT_CONTRACT,
} = {}) {
  let phase = "validate_options";
  try {
    const candidateRoot = absolutePath(candidate, "candidate release");
    const modulePath = absolutePath(managementModule, "account management module");
    const checked = validateContract(contract);
    const root = await fs.lstat(candidateRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("candidate release boundary is invalid");
    }

    phase = "validate_main";
    const mainPath = path.join(candidateRoot, MAIN_RELATIVE);
    const main = await readRegular(mainPath, 2 * 1024 * 1024);
    if (sha256(main) !== checked.source_main_sha256) throw new Error("R105 main changed");
    const patchedMain = Buffer.from(patchMain(decodeUtf8(main)));

    phase = "validate_management_module";
    const moduleBytes = await readRegular(modulePath, 2 * 1024 * 1024);
    const moduleText = decodeUtf8(moduleBytes);
    if (
      sha256(moduleBytes) !== checked.management_module_sha256 ||
      !moduleText.includes("registerRouterAccountManagement") ||
      moduleText.includes("child_process.exec") || moduleText.includes("shell: true")
    ) throw new Error("account management module changed");

    phase = "write_output";
    await writeReleaseFile(candidateRoot, MANAGEMENT_RELATIVE, moduleBytes);
    await writeReleaseFile(candidateRoot, MAIN_RELATIVE, patchedMain);

    return Object.freeze({
      event: "r106_account_management_installed",
      qualified_app_host_preserved: true,
      main_sha256: sha256(patchedMain),
      management_module_sha256: sha256(moduleBytes),
    });
  } catch {
    throw new Error(`R106 account management install failed at ${phase}`);
  }
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--management-module", "managementModule"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R106 account management option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R106 account management command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installR106AccountManagement(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
