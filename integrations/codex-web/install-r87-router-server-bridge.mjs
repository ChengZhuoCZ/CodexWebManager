#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_RELATIVE = "src/server/main.js";
const SESSION_AUTH_RELATIVE = "src/server/browser-session-auth.js";
const ROUTER_BRIDGE_RELATIVE = "src/server/router-status-bridge.js";
const SHA256 = /^[a-f0-9]{64}$/u;

export const PINNED_R87_SERVER_BRIDGE_CONTRACT = Object.freeze({
  qualified_main_sha256: "103d8dbc08f16bb3ced68d8cd0f13710dc77da2dfbed491ba95e9d510d92086d",
  session_auth_sha256: "e8d447dfad97ddef264d013d67cebeb867588ff1e24bf40193012b32b528a92c",
  router_bridge_sha256: "185cf83adf11510e2b5c69d3c0652f5c146aa87a56ed97c6028ea2dc62bf3757",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateContract(value) {
  const keys = [
    "qualified_main_sha256",
    "session_auth_sha256",
    "router_bridge_sha256",
  ];
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    keys.some((key) => !SHA256.test(value[key]))
  ) {
    throw new Error("R87 server bridge contract is invalid");
  }
  return Object.freeze({ ...value });
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

async function readRegular(target, maximum) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximum || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("R87 server bridge input boundary is invalid");
  }
  return fs.readFile(target);
}

function decodeUtf8(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new Error("R87 server bridge input encoding is invalid");
  }
  return value;
}

async function writeReleaseFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.next`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function patchQualifiedMain(input) {
  const requireAnchor = 'const module_1 = require("./module");\n';
  const startupAnchor = '    const app = (0, fastify_1.default)({ logger: false });\n';
  const requiredAbsences = [
    'require("./browser-session-auth")',
    'require("./router-status-bridge")',
    "registerBrowserSessionAuth)(app, process.env)",
    "registerRouterStatusBridge)(app, process.env)",
  ];
  if (
    input.split(requireAnchor).length - 1 !== 1 ||
    input.split(startupAnchor).length - 1 !== 1 ||
    requiredAbsences.some((marker) => input.includes(marker)) ||
    !input.includes("class WebSocketMessagePort") ||
    !input.includes('message.type === "ipc-renderer-post-message"')
  ) {
    throw new Error("qualified R23 App Host bridge changed");
  }
  const withImports = input.replace(
    requireAnchor,
    `${requireAnchor}const browser_session_auth_1 = require("./browser-session-auth");\n` +
      'const router_status_bridge_1 = require("./router-status-bridge");\n',
  );
  const output = withImports.replace(
    startupAnchor,
    `${startupAnchor}` +
      "    await (0, browser_session_auth_1.registerBrowserSessionAuth)(app, process.env);\n" +
      "    await (0, router_status_bridge_1.registerRouterStatusBridge)(app, process.env);\n",
  );
  if (
    !output.includes("class WebSocketMessagePort") ||
    !output.includes('message.type === "ipc-renderer-post-message"') ||
    output.split("registerBrowserSessionAuth)(app, process.env)").length - 1 !== 1 ||
    output.split("registerRouterStatusBridge)(app, process.env)").length - 1 !== 1
  ) {
    throw new Error("R23 App Host preservation check failed");
  }
  return output;
}

export async function installR87RouterServerBridge({
  candidate,
  sessionAuth,
  routerBridge,
  contract = PINNED_R87_SERVER_BRIDGE_CONTRACT,
} = {}) {
  let phase = "validate_options";
  try {
    const candidateRoot = absolutePath(candidate, "candidate release");
    const sessionAuthPath = absolutePath(sessionAuth, "browser session auth module");
    const routerBridgePath = absolutePath(routerBridge, "router status bridge module");
    const checked = validateContract(contract);
    const root = await fs.lstat(candidateRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("candidate release boundary is invalid");
    }

    phase = "validate_qualified_main";
    const mainPath = path.join(candidateRoot, MAIN_RELATIVE);
    const main = await readRegular(mainPath, 2 * 1024 * 1024);
    if (sha256(main) !== checked.qualified_main_sha256) {
      throw new Error("qualified main changed");
    }
    const patchedMain = Buffer.from(patchQualifiedMain(decodeUtf8(main)));

    phase = "validate_session_auth";
    const sessionAuthBytes = await readRegular(sessionAuthPath, 2 * 1024 * 1024);
    if (
      sha256(sessionAuthBytes) !== checked.session_auth_sha256 ||
      !decodeUtf8(sessionAuthBytes).includes("registerBrowserSessionAuth")
    ) {
      throw new Error("browser session auth module changed");
    }

    phase = "validate_router_bridge";
    const routerBridgeBytes = await readRegular(routerBridgePath, 2 * 1024 * 1024);
    if (
      sha256(routerBridgeBytes) !== checked.router_bridge_sha256 ||
      !decodeUtf8(routerBridgeBytes).includes("registerRouterStatusBridge")
    ) {
      throw new Error("router status bridge module changed");
    }

    phase = "write_output";
    await writeReleaseFile(candidateRoot, SESSION_AUTH_RELATIVE, sessionAuthBytes);
    await writeReleaseFile(candidateRoot, ROUTER_BRIDGE_RELATIVE, routerBridgeBytes);
    await writeReleaseFile(candidateRoot, MAIN_RELATIVE, patchedMain);

    return Object.freeze({
      event: "r87_router_server_bridge_installed",
      qualified_app_host_preserved: true,
      main_sha256: sha256(patchedMain),
      session_auth_sha256: sha256(sessionAuthBytes),
      router_bridge_sha256: sha256(routerBridgeBytes),
    });
  } catch {
    throw new Error(`R87 server bridge install failed at ${phase}`);
  }
}

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--session-auth", "sessionAuth"],
    ["--router-bridge", "routerBridge"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R87 server bridge option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 3) {
    throw new Error("R87 server bridge command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installR87RouterServerBridge(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
