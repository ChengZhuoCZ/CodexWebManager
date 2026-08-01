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
import {
  installStandaloneRouterPanel,
} from "../../../integrations/codex-web/install-standalone-router-panel.mjs";
import {
  buildManualSwitchRequest as buildStandaloneSwitchRequest,
  deriveRouterAccountPanelModel as deriveStandalonePanelModel,
} from "../../../integrations/codex-web/router-account-panel-standalone.js";

const INDEX = "scratch/asar/webview/index.html";
const ASSETS = "scratch/asar/webview/assets";
const APP = `${ASSETS}/app-initial-BTphDPeq.js`;
const R90_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r90-standalone-panel.sh",
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
    root,
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

test("R90 deployment preserves both bridge files and restarts only routed Web", async () => {
  const source = await fs.readFile(R90_DEPLOY, "utf8");
  assert.match(source, /router-r87-materialized-r23/u);
  assert.match(source, /INSTALLER_SHA256=6ec7a6ef/u);
  assert.match(source, /PANEL_MODULE_SHA256=f80b0416/u);
  assert.match(source, /QUALIFIED_APP_SHA256=e2d356e0/u);
  assert.match(source, /QUALIFIED_PRELOAD_SHA256=65708a1c/u);
  assert.match(source, /STANDALONE_INDEX_SHA256=f161f0c0/u);
  assert.match(source, /restart_8216_web_app/u);
  assert.match(source, /expect_8215_unchanged/u);
  assert.match(source, /expect_account_router_unchanged/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-account-router)/u,
  );
});

test("standalone panel preserves weekly-only and semantic-stream switch guards", () => {
  const status = {
    status: "ready",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: 1,
    current_route: {
      account_alias: "Primary",
      continuity: "new_backend_session",
    },
    accounts: [
      {
        alias: "Primary",
        state: "healthy",
        enabled: true,
        weekly_remaining_ratio: 0.75,
        snapshot_observed_at: null,
        cooldown_until: null,
        last_switch_reason: "startup",
        five_hour_remaining_ratio: 0.2,
        credential_ref: "must-not-pass",
      },
      {
        alias: "Secondary",
        state: "auth_expired",
        enabled: true,
        weekly_remaining_ratio: null,
        snapshot_observed_at: null,
        cooldown_until: null,
        last_switch_reason: "auth_expired",
      },
    ],
  };
  const model = deriveStandalonePanelModel(status);
  assert.equal(model.accounts[0].weeklyLabel, "75%");
  assert.equal(model.accounts[1].weeklyLabel, "Unavailable");
  assert.equal(model.accounts.every((account) => account.switchDisabled), true);
  assert.equal(model.accounts[1].switchDisabledReason, "Active response in progress");
  assert.doesNotMatch(JSON.stringify(model), /five_hour|credential_ref|must-not-pass/u);
  assert.throws(
    () => buildStandaloneSwitchRequest(model.accounts[1]),
    /manual switch is unavailable/u,
  );
});

test("installs the standalone panel without replacing either qualified bridge file", async (context) => {
  const value = await fixture(context);
  const panel = Buffer.from([
    "Router accounts",
    "/__backend/codex-router/status",
    "/__backend/codex-router/switch",
    "Cross-account continuity is not verified",
    "installRouterAccountPanel",
    "",
  ].join("\n"));
  const panelModule = path.join(value.root, "router-account-panel.js");
  await fs.writeFile(panelModule, panel, { mode: 0o644 });
  const contract = {
    qualified_preload_name: value.contract.qualified_preload_name,
    panel_name: "router-account-panel-55555555.js",
    qualified_index_sha256: value.contract.qualified_index_sha256,
    qualified_app_sha256: value.contract.qualified_app_sha256,
    qualified_preload_sha256: value.contract.qualified_preload_sha256,
    qualified_app_version: value.contract.qualified_app_version,
    panel_sha256: sha256(panel),
  };
  const result = await installStandaloneRouterPanel({
    candidate: value.candidate,
    panelModule,
    contract,
  });
  const index = await fs.readFile(path.join(value.candidate, INDEX));
  const installed = await fs.readFile(path.join(value.candidate, ASSETS, result.panel_name));
  assert.equal(result.qualified_app_unchanged, true);
  assert.equal(result.qualified_preload_unchanged, true);
  assert.deepEqual(await fs.readFile(path.join(value.candidate, APP)), value.app);
  assert.match(index.toString(), new RegExp(value.contract.qualified_preload_name));
  assert.match(index.toString(), new RegExp(contract.panel_name));
  assert.deepEqual(installed, panel);
  assert.deepEqual(gunzipSync(await fs.readFile(`${path.join(value.candidate, ASSETS, result.panel_name)}.gz`)), panel);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${path.join(value.candidate, ASSETS, result.panel_name)}.br`)), panel);
});

test("standalone panel installer fails before writing when its module hash changes", async (context) => {
  const value = await fixture(context);
  const panelModule = path.join(value.root, "router-account-panel.js");
  await fs.writeFile(panelModule, "changed module\n", { mode: 0o644 });
  const before = await fs.readFile(path.join(value.candidate, INDEX));
  await assert.rejects(
    installStandaloneRouterPanel({
      candidate: value.candidate,
      panelModule,
      contract: {
        qualified_preload_name: value.contract.qualified_preload_name,
        panel_name: "router-account-panel-55555555.js",
        qualified_index_sha256: value.contract.qualified_index_sha256,
        qualified_app_sha256: value.contract.qualified_app_sha256,
        qualified_preload_sha256: value.contract.qualified_preload_sha256,
        qualified_app_version: value.contract.qualified_app_version,
        panel_sha256: sha256("expected module\n"),
      },
    }),
    /standalone panel install failed at validate_panel_module/u,
  );
  assert.deepEqual(await fs.readFile(path.join(value.candidate, INDEX)), before);
});
