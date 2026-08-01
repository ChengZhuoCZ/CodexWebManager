import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  mergeRouterPanelOntoQualifiedRelease,
} from "../../../integrations/codex-web/merge-router-panel-release.mjs";

const INDEX = "scratch/asar/webview/index.html";
const ASSETS = "scratch/asar/webview/assets";
const APP = `${ASSETS}/app-initial-BTphDPeq.js`;
const R88_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r88-hybrid-panel.sh",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function write(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value, { mode: 0o644 });
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-router-panel-merge-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "qualified");
  const panelRelease = path.join(root, "panel");
  const appVersion = "1111111111111111";
  const qualifiedPreloadName = "preload-22222222.js";
  const panelPreloadName = "preload-33333333.js";
  const app = Buffer.from("qualified connect-app-host App Host bridge\n");
  const qualifiedPreload = Buffer.from("qualified preload\n");
  const panelPreload = Buffer.from([
    "Router accounts",
    "/__backend/codex-router/status",
    "Cross-account continuity is not verified",
    "connect-app-host",
    "__ELECTRON_SHIM__",
    "",
  ].join("\n"));
  const qualifiedIndex = Buffer.from([
    `<script type="importmap">{"imports":{"./assets/app-initial-BTphDPeq.js":"./assets/app-initial-BTphDPeq.js?v=${appVersion}"}}</script>`,
    `<link rel="modulepreload" href="./assets/app-initial-BTphDPeq.js?v=${appVersion}">`,
    `<script type="module" src="./assets/${qualifiedPreloadName}"></script>`,
    "",
  ].join("\n"));
  const panelIndex = Buffer.from([
    `<script type="importmap">{"imports":{"./assets/app-initial-BTphDPeq.js":"./assets/app-initial-BTphDPeq.js?v=4444444444444444"}}</script>`,
    `<link rel="modulepreload" href="./assets/app-initial-BTphDPeq.js?v=4444444444444444">`,
    `<script type="module" src="./assets/${panelPreloadName}"></script>`,
    "",
  ].join("\n"));
  await write(candidate, INDEX, qualifiedIndex);
  await write(candidate, APP, app);
  await write(candidate, `${ASSETS}/${qualifiedPreloadName}`, qualifiedPreload);
  await write(panelRelease, INDEX, panelIndex);
  await write(panelRelease, `${ASSETS}/${panelPreloadName}`, panelPreload);
  return {
    candidate,
    panelRelease,
    app,
    qualifiedIndex,
    panelIndex,
    panelPreload,
    contract: {
      qualified_index_sha256: sha256(qualifiedIndex),
      qualified_app_sha256: sha256(app),
      qualified_preload_sha256: sha256(qualifiedPreload),
      qualified_app_version: appVersion,
      qualified_preload_name: qualifiedPreloadName,
      panel_index_sha256: sha256(panelIndex),
      panel_preload_sha256: sha256(panelPreload),
      panel_preload_name: panelPreloadName,
    },
  };
}

test("merges only the router panel preload onto the qualified App Host release", async (context) => {
  const value = await fixture(context);
  const result = await mergeRouterPanelOntoQualifiedRelease(value);
  const index = await fs.readFile(path.join(value.candidate, INDEX));
  const preload = await fs.readFile(path.join(value.candidate, ASSETS, result.panel_preload_name));

  assert.equal(result.event, "router_panel_merged_onto_qualified_release");
  assert.equal(result.qualified_app_unchanged, true);
  assert.deepEqual(await fs.readFile(path.join(value.candidate, APP)), value.app);
  assert.equal(
    index.toString().match(new RegExp(`app-initial-BTphDPeq\\.js\\?v=${value.contract.qualified_app_version}`, "gu"))?.length,
    2,
  );
  assert.match(index.toString(), new RegExp(`assets/${value.contract.panel_preload_name}`));
  assert.doesNotMatch(index.toString(), new RegExp(value.contract.qualified_preload_name));
  assert.deepEqual(preload, value.panelPreload);
  assert.deepEqual(gunzipSync(await fs.readFile(`${path.join(value.candidate, ASSETS, result.panel_preload_name)}.gz`)), preload);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${path.join(value.candidate, ASSETS, result.panel_preload_name)}.br`)), preload);
  assert.deepEqual(gunzipSync(await fs.readFile(`${path.join(value.candidate, INDEX)}.gz`)), index);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${path.join(value.candidate, INDEX)}.br`)), index);
  assert.deepEqual(await fs.readFile(path.join(value.panelRelease, INDEX)), value.panelIndex);
});

test("fails closed before writing when the qualified App Host bundle changes", async (context) => {
  const value = await fixture(context);
  const before = await fs.readFile(path.join(value.candidate, INDEX));
  await fs.appendFile(path.join(value.candidate, APP), "unexpected change\n");
  await assert.rejects(
    mergeRouterPanelOntoQualifiedRelease(value),
    /router panel merge failed at validate_qualified_app/u,
  );
  assert.deepEqual(await fs.readFile(path.join(value.candidate, INDEX)), before);
  await assert.rejects(fs.access(path.join(value.candidate, ASSETS, value.contract.panel_preload_name)));
});

test("rejects a panel preload without the bounded router UI contract", async (context) => {
  const value = await fixture(context);
  const invalid = Buffer.from("Router accounts only\n");
  await fs.writeFile(
    path.join(value.panelRelease, ASSETS, value.contract.panel_preload_name),
    invalid,
  );
  value.contract.panel_preload_sha256 = sha256(invalid);
  await assert.rejects(
    mergeRouterPanelOntoQualifiedRelease(value),
    /router panel merge failed at validate_panel_contract/u,
  );
});

test("R88 deployment pins the hybrid boundary and restarts only routed Web", async () => {
  const source = await fs.readFile(R88_DEPLOY, "utf8");
  assert.match(source, /router-r87-materialized-r23/u);
  assert.match(source, /router-r86/u);
  assert.match(source, /MERGER_SHA256=81e032da/u);
  assert.match(source, /QUALIFIED_APP_SHA256=e2d356e0/u);
  assert.match(source, /HYBRID_INDEX_SHA256=da7a4aec/u);
  assert.match(source, /restart_8216_web_app/u);
  assert.match(source, /expect_8215_unchanged/u);
  assert.match(source, /expect_account_router_unchanged/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-account-router)/u,
  );
});
