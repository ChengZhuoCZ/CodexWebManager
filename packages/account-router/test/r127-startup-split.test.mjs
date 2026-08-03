import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { replaceR127StartupSplit } from "../../../integrations/codex-web/replace-r127-startup-split.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("R127 replaces only pinned startup assets and keeps the account window deferred", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r127-startup-split-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const assets = path.join(candidate, "scratch/asar/webview/assets");
  const server = path.join(candidate, "src/server");
  const browserInput = path.join(root, "browser");
  const serverInput = path.join(root, "server");
  await Promise.all([
    fs.mkdir(assets, { recursive: true }),
    fs.mkdir(server, { recursive: true }),
    fs.mkdir(browserInput),
    fs.mkdir(serverInput),
  ]);

  const oldIndex = Buffer.from('<script src="./assets/preload-old.js"></script>');
  const oldPreload = Buffer.from("Refresh current account weekly quota");
  await fs.writeFile(path.join(candidate, "scratch/asar/webview/index.html"), oldIndex);
  for (const suffix of ["", ".gz", ".br"]) {
    await fs.writeFile(path.join(assets, `preload-old.js${suffix}`), oldPreload);
  }
  const importAnchor = 'const browser_upload_store_1 = require("./browser-upload-store");';
  const staticAnchor = `    await app.register(static_1.default, {
        root: node_path_1.default.resolve(__dirname, "../../scratch/asar/webview"),
        prefix: "/",
        preCompressed: true,`;
  const oldMain = Buffer.from(`${importAnchor}\n${staticAnchor}\n    });\n`);
  const nextMain = Buffer.from(oldMain.toString("utf8")
    .replace(importAnchor, `${importAnchor}\nconst preferred_content_encoding_1 = require("./preferred-content-encoding");`)
    .replace(staticAnchor, `    app.addHook("onRequest", async (request) => {
        if ((request.method === "GET" || request.method === "HEAD") &&
            request.url.startsWith("/assets/") &&
            typeof request.headers["accept-encoding"] === "string") {
            request.headers["accept-encoding"] = (0, preferred_content_encoding_1.preferBrotliAcceptEncoding)(request.headers["accept-encoding"]);
        }
    });
${staticAnchor}`));
  const predecessorServer = {
    "main.js": oldMain,
    "browser-ipc-router.js": Buffer.from("ipc"),
    "browser-upload-store.js": Buffer.from("upload"),
    "browser-session-auth.js": Buffer.from("session"),
    "router-status-bridge.js": Buffer.from("status"),
    "router-account-management.js": Buffer.from("management"),
  };
  for (const [name, bytes] of Object.entries(predecessorServer)) {
    await fs.writeFile(path.join(server, name), bytes);
  }
  const browser = {
    "preload.js": Buffer.from('import("./account-settings-window-B0-uL438.mjs");const endpoint="/v1/log_event";installAccountSettingsEntry();'),
    "account-settings-window-B0-uL438.mjs": Buffer.from('import "./client-cwlt_MhB.mjs";'),
    "client-cwlt_MhB.mjs": Buffer.from("export const client=true;"),
  };
  for (const [name, bytes] of Object.entries(browser)) {
    await fs.writeFile(path.join(browserInput, name), bytes);
  }
  const nextServer = { "preferred-content-encoding.js": Buffer.from("brotli-helper") };
  for (const [name, bytes] of Object.entries(nextServer)) {
    await fs.writeFile(path.join(serverInput, name), bytes);
  }
  const contract = {
    predecessor_index_sha256: digest(oldIndex),
    predecessor_preload_name: "preload-old.js",
    predecessor_preload_sha256: digest(oldPreload),
    predecessor_server: Object.fromEntries(
      Object.entries(predecessorServer).map(([name, bytes]) => [name, digest(bytes)]),
    ),
    browser_assets: Object.fromEntries(
      Object.entries(browser).map(([name, bytes]) => [name, digest(bytes)]),
    ),
    server_assets: Object.fromEntries(
      Object.entries(nextServer).map(([name, bytes]) => [name, digest(bytes)]),
    ),
    successor_server_main_sha256: digest(nextMain),
  };

  const result = await replaceR127StartupSplit({
    candidate,
    browserAssets: browserInput,
    serverAssets: serverInput,
    contract,
  });
  const preloadName = `preload-${digest(browser["preload.js"]).slice(0, 8)}.js`;
  assert.equal(result.preload_name, preloadName);
  assert.equal(result.preload_bytes, browser["preload.js"].length);
  assert.match(
    await fs.readFile(path.join(candidate, "scratch/asar/webview/index.html"), "utf8"),
    new RegExp(preloadName.replace(".", "\\."), "u"),
  );
  assert.deepEqual(await fs.readFile(path.join(server, "main.js")), nextMain);
  assert.equal(await fs.readFile(path.join(server, "preferred-content-encoding.js"), "utf8"), "brotli-helper");
  await assert.rejects(fs.lstat(path.join(assets, "preload-old.js")), /ENOENT/u);
  for (const name of [preloadName, ...Object.keys(browser).slice(1)]) {
    for (const suffix of ["", ".gz", ".br"]) {
      assert.equal((await fs.lstat(path.join(assets, `${name}${suffix}`))).isFile(), true);
    }
  }
});
