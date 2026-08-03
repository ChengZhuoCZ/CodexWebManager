#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const INDEX_RELATIVE = "scratch/asar/webview/index.html";
const ASSETS_RELATIVE = "scratch/asar/webview/assets";
const SERVER_RELATIVE = "src/server";

export const R127_STARTUP_SPLIT_CONTRACT = Object.freeze({
  predecessor_index_sha256: "c4f2c6ff665bf00f8a93e27909fd4dbdab9f6d8536ad150be05953cae3b4ba2b",
  predecessor_preload_name: "preload-a5d77090.js",
  predecessor_preload_sha256: "a5d77090e59391561d3920b92db798e93ae985492fac8a6fd5401397d236afd9",
  predecessor_server: Object.freeze({
    "main.js": "b9f1d11db2145b5a03b77ca8a662d88d2811fb9bba1d23f4be3634eab3ff9292",
    "browser-upload-store.js": "dc4b24079c008dd8517f2715d804fd298d1ab181beea2ae7ebf5a196fa5177fc",
    "browser-session-auth.js": "7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6",
    "router-status-bridge.js": "30a7a21262e168269fd9be386a091310723b12b59e2e1c546a152ad836fdfce8",
    "router-account-management.js": "d918cec444e06789a5cbfc3170d9d4fb1fd939e02828631d65684ff9b4ef4de9",
  }),
  browser_assets: Object.freeze({
    "preload.js": "96037be170c5c6f8f87024de9085c7f7dc80171d4711c015960ff14b1b438647",
    "account-settings-window-C1CW0Ui2.mjs": "e9fd12b9506c2440706801a9a149897ecab3223a68897336800108a361bf8cc0",
    "workspace-root-dialog-CTNvLaH0.mjs": "4809e2fd8316f5824c7d18c9d84ba23b1164ad6452e6eab66a0534d9a2cdd649",
    "jsx-runtime-BhZVp74s.mjs": "c6bebbac8a268cb22a871ed791b43e79cf23c3f88afb473855e8338c1bd04be0",
    "rolldown-runtime-7_rZTKki.mjs": "ee6f7f26af65d579908c6904c08fa7fd954f22673d48974bf74dd8036a83cc71",
  }),
  server_assets: Object.freeze({
    "preferred-content-encoding.js": "084e34b5197d70a7d7859235b4f50baa48d0ff142bbd82a3a0fdbbdd13de6cb9",
  }),
  successor_server_main_sha256: "d5f3337ac7cad3fb640c136638231eda5d65d6484f7c03c65c044843cbb9ac88",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readPinned(target, expected, maximumBytes = 64 * 1024 * 1024) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > maximumBytes || (metadata.mode & 0o022) !== 0
  ) throw new Error("R127 replacement input boundary is invalid");
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== expected) throw new Error("R127 replacement input changed");
  return bytes;
}

function compress(bytes) {
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

function replaceExactlyOnce(value, anchor, replacement) {
  const first = value.indexOf(anchor);
  if (first < 0 || value.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("R127 server source anchor changed");
  }
  return `${value.slice(0, first)}${replacement}${value.slice(first + anchor.length)}`;
}

function patchServerMain(bytes, expectedSha256) {
  const importAnchor = 'const browser_upload_store_1 = require("./browser-upload-store");';
  const staticAnchor = `    await app.register(static_1.default, {
        root: node_path_1.default.resolve(__dirname, "../../scratch/asar/webview"),
        prefix: "/",
        preCompressed: true,`;
  let source = bytes.toString("utf8");
  source = replaceExactlyOnce(
    source,
    importAnchor,
    `${importAnchor}\nconst preferred_content_encoding_1 = require("./preferred-content-encoding");`,
  );
  source = replaceExactlyOnce(
    source,
    staticAnchor,
    `    app.addHook("onRequest", async (request) => {
        if ((request.method === "GET" || request.method === "HEAD") &&
            request.url.startsWith("/assets/") &&
            typeof request.headers["accept-encoding"] === "string") {
            request.headers["accept-encoding"] = (0, preferred_content_encoding_1.preferBrotliAcceptEncoding)(request.headers["accept-encoding"]);
        }
    });
${staticAnchor}`,
  );
  const patched = Buffer.from(source);
  if (sha256(patched) !== expectedSha256) throw new Error("R127 patched server main changed");
  return patched;
}

async function writeTriplet(target, bytes) {
  const compressed = compress(bytes);
  await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  await fs.writeFile(`${target}.gz`, compressed.gzip, { flag: "wx", mode: 0o644 });
  await fs.writeFile(`${target}.br`, compressed.brotli, { flag: "wx", mode: 0o644 });
  await Promise.all([
    fs.chmod(target, 0o644),
    fs.chmod(`${target}.gz`, 0o644),
    fs.chmod(`${target}.br`, 0o644),
  ]);
  return compressed;
}

async function replaceRegularFile(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function replaceR127StartupSplit({
  candidate,
  browserAssets,
  serverAssets,
  contract = R127_STARTUP_SPLIT_CONTRACT,
} = {}) {
  if (
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    typeof browserAssets !== "string" || !path.isAbsolute(browserAssets) ||
    typeof serverAssets !== "string" || !path.isAbsolute(serverAssets)
  ) throw new Error("R127 replacement option is invalid");
  const root = await fs.lstat(candidate);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("R127 candidate root is invalid");

  const assetsRoot = path.join(candidate, ASSETS_RELATIVE);
  const serverRoot = path.join(candidate, SERVER_RELATIVE);
  const indexTarget = path.join(candidate, INDEX_RELATIVE);
  const oldPreloadTarget = path.join(assetsRoot, contract.predecessor_preload_name);
  const [indexBytes, oldPreloadBytes, oldServerMain] = await Promise.all([
    readPinned(indexTarget, contract.predecessor_index_sha256, 256 * 1024),
    readPinned(oldPreloadTarget, contract.predecessor_preload_sha256, 1024 * 1024),
    readPinned(
      path.join(serverRoot, "main.js"),
      contract.predecessor_server["main.js"],
      2 * 1024 * 1024,
    ),
    ...Object.entries(contract.predecessor_server).map(([name, hash]) =>
      readPinned(path.join(serverRoot, name), hash, 2 * 1024 * 1024)),
  ]);
  if (!oldPreloadBytes.includes(Buffer.from("Refresh current account weekly quota"))) {
    throw new Error("R127 predecessor account window is unavailable");
  }

  const browserEntries = await Promise.all(
    Object.entries(contract.browser_assets).map(async ([name, hash]) => [
      name,
      await readPinned(path.join(browserAssets, name), hash, 2 * 1024 * 1024),
    ]),
  );
  const serverEntries = await Promise.all(
    Object.entries(contract.server_assets).map(async ([name, hash]) => [
      name,
      await readPinned(path.join(serverAssets, name), hash, 2 * 1024 * 1024),
    ]),
  );
  const patchedServerMain = patchServerMain(oldServerMain, contract.successor_server_main_sha256);
  const browser = Object.fromEntries(browserEntries);
  const preloadName = `preload-${contract.browser_assets["preload.js"].slice(0, 8)}.js`;
  const browserNames = Object.keys(contract.browser_assets);
  const namedChunk = (pattern) => {
    const matches = browserNames.filter((name) => pattern.test(name));
    if (matches.length !== 1) throw new Error("R127 startup chunk contract is invalid");
    return matches[0];
  };
  const accountChunk = namedChunk(/^account-settings-window-[A-Za-z0-9_-]{8}\.mjs$/u);
  const workspaceChunk = namedChunk(/^workspace-root-dialog-[A-Za-z0-9_-]{8}\.mjs$/u);
  const reactChunk = namedChunk(/^jsx-runtime-[A-Za-z0-9_-]{8}\.mjs$/u);
  const runtimeChunk = namedChunk(/^rolldown-runtime-[A-Za-z0-9_-]{8}\.mjs$/u);
  const preloadText = browser["preload.js"].toString("utf8");
  if (
    !preloadText.includes(`import("./${accountChunk}")`) ||
    !preloadText.includes(`import("./${workspaceChunk}")`) ||
    !preloadText.includes(`from "./${runtimeChunk}"`) ||
    preloadText.includes(`from "./${reactChunk}"`) ||
    !browser[accountChunk].includes(Buffer.from(`./${reactChunk}`)) ||
    !browser[workspaceChunk].includes(Buffer.from(`./${reactChunk}`)) ||
    !browser["preload.js"].includes(Buffer.from("/v1/log_event")) ||
    browser["preload.js"].includes(Buffer.from("//#region src/browser/account-settings-window.tsx")) ||
    browser["preload.js"].includes(Buffer.from("//#region src/browser/workspace-root-dialog.tsx"))
  ) throw new Error("R127 startup split contract is unavailable");

  const oldReference = `./assets/${contract.predecessor_preload_name}`;
  const newReference = `./assets/${preloadName}`;
  const indexText = indexBytes.toString("utf8");
  if (indexText.split(oldReference).length !== 2 || indexText.includes(newReference)) {
    throw new Error("R127 predecessor index anchor changed");
  }
  const nextIndex = Buffer.from(indexText.replace(oldReference, newReference));
  const temporaryIndex = `${indexTarget}.r127-${randomUUID()}.next`;
  const written = [];
  try {
    for (const [name, bytes] of browserEntries) {
      const targetName = name === "preload.js" ? preloadName : name;
      const target = path.join(assetsRoot, targetName);
      await writeTriplet(target, bytes);
      written.push(target, `${target}.gz`, `${target}.br`);
    }
    const indexCompressed = compress(nextIndex);
    await fs.writeFile(temporaryIndex, nextIndex, { flag: "wx", mode: 0o644 });
    await fs.writeFile(`${indexTarget}.gz`, indexCompressed.gzip, { mode: 0o644 });
    await fs.writeFile(`${indexTarget}.br`, indexCompressed.brotli, { mode: 0o644 });
    await Promise.all([
      fs.chmod(temporaryIndex, 0o644),
      fs.chmod(`${indexTarget}.gz`, 0o644),
      fs.chmod(`${indexTarget}.br`, 0o644),
    ]);
    await fs.rename(temporaryIndex, indexTarget);
    for (const [name, bytes] of serverEntries) {
      await replaceRegularFile(path.join(serverRoot, name), bytes);
    }
    await replaceRegularFile(path.join(serverRoot, "main.js"), patchedServerMain);
    for (const suffix of ["", ".gz", ".br"]) await fs.unlink(`${oldPreloadTarget}${suffix}`);
  } catch (error) {
    await fs.rm(temporaryIndex, { force: true }).catch(() => undefined);
    await Promise.all(written.map((target) => fs.rm(target, { force: true }).catch(() => undefined)));
    throw error;
  }

  return Object.freeze({
    event: "r127_startup_split_installed",
    index_sha256: sha256(nextIndex),
    preload_name: preloadName,
    preload_sha256: sha256(browser["preload.js"]),
    preload_bytes: browser["preload.js"].length,
    deferred_account_window_bytes: browser[accountChunk].length,
    deferred_workspace_dialog_bytes: browser[workspaceChunk].length,
    deferred_react_client_bytes: browser[reactChunk].length,
    exact_telemetry_short_circuit: true,
    brotli_preferred: true,
  });
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] === "--candidate") options.candidate = values[index + 1];
    else if (values[index] === "--browser-assets") options.browserAssets = values[index + 1];
    else if (values[index] === "--server-assets") options.serverAssets = values[index + 1];
    else throw new Error("R127 replacement option is invalid");
  }
  if (values.length !== 6 || Object.keys(options).length !== 3) {
    throw new Error("R127 replacement command is incomplete");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR127StartupSplit(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
