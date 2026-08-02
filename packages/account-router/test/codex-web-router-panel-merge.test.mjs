import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import {
  mergeRouterPanelOntoQualifiedRelease,
} from "../../../integrations/codex-web/merge-router-panel-release.mjs";
import {
  installStandaloneRouterPanel,
} from "../../../integrations/codex-web/install-standalone-router-panel.mjs";
import {
  installR87RouterServerBridge,
} from "../../../integrations/codex-web/install-r87-router-server-bridge.mjs";
import {
  replaceStandaloneRouterPanel,
} from "../../../integrations/codex-web/replace-standalone-router-panel.mjs";
import {
  R99_PROFILE_MENU_CONTRACT,
} from "../../../integrations/codex-web/replace-r99-router-profile-menu.mjs";
import {
  R100_PROFILE_MENU_CONTRACT,
} from "../../../integrations/codex-web/replace-r100-router-profile-menu.mjs";
import {
  R101_QUOTA_MENU_CONTRACT,
} from "../../../integrations/codex-web/replace-r101-router-quota-menu.mjs";
import {
  R102_NATIVE_SIZE_CONTRACT,
} from "../../../integrations/codex-web/replace-r102-router-native-size.mjs";
import {
  R103_RESET_TIME_CONTRACT,
} from "../../../integrations/codex-web/replace-r103-router-reset-time.mjs";
import {
  buildManualSwitchRequest as buildStandaloneSwitchRequest,
  currentRouteIdentity as currentStandaloneRouteIdentity,
  deriveRouterAccountPanelModel as deriveStandalonePanelModel,
} from "../../../integrations/codex-web/router-account-panel-standalone.js";

const INDEX = "scratch/asar/webview/index.html";
const ASSETS = "scratch/asar/webview/assets";
const APP = `${ASSETS}/app-initial-BTphDPeq.js`;
const STANDALONE_PANEL = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/router-account-panel-standalone.js",
);
const ROUTER_STATUS_BRIDGE = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/src/server/router-status-bridge.ts",
);
const R91_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r91-standalone-panel.sh",
);
const R92_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r92-server-bridge.sh",
);
const R94_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r94-manual-switch-recovery.sh",
);
const R95_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r95-manual-switch-display.sh",
);
const R97_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r97-xhr-switch-repair.sh",
);
const R99_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r99-profile-menu.sh",
);
const R100_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r100-profile-menu-dom.sh",
);
const R101_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r101-quota-menu.sh",
);
const R102_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r102-native-size.sh",
);
const R103_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r103-reset-time.sh",
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

test("R91 deployment preserves both bridge files and restarts only routed Web", async () => {
  const source = await fs.readFile(R91_DEPLOY, "utf8");
  assert.match(source, /router-r87-materialized-r23/u);
  assert.match(source, /INSTALLER_SHA256=737b9833/u);
  assert.match(source, /PANEL_MODULE_SHA256=c4f3be1f/u);
  assert.match(source, /QUALIFIED_APP_SHA256=e2d356e0/u);
  assert.match(source, /QUALIFIED_PRELOAD_SHA256=65708a1c/u);
  assert.match(source, /STANDALONE_INDEX_SHA256=f9116342/u);
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
        weekly_resets_at: "2026-08-08T00:00:00.000Z",
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
  assert.equal(model.accounts[0].weeklyLabel, "75% remaining");
  assert.equal(model.accounts[0].weeklyDetail, "Refreshed: unavailable");
  assert.equal(model.accounts[0].weeklyResetDetail, "Resets 2026-08-08 00:00 UTC");
  assert.equal(model.accounts[1].weeklyLabel, "Not observed yet");
  assert.equal(model.accounts[1].weeklyDetail, "Refreshed: never");
  assert.equal(model.accounts[1].weeklyResetDetail, "Resets: unavailable");
  assert.equal(model.accounts.every((account) => account.switchDisabled), true);
  assert.equal(model.accounts[1].switchDisabledReason, "Active response in progress");
  assert.doesNotMatch(JSON.stringify(model), /five_hour|credential_ref|must-not-pass/u);
  assert.throws(
    () => buildStandaloneSwitchRequest(model.accounts[1]),
    /manual switch is unavailable/u,
  );
});

test("standalone JSON XHR never reads responseText for a json response type", async () => {
  const source = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(source, /request\.responseType = "json"/u);
  assert.doesNotMatch(source, /request\.responseText/u);
});

test("standalone panel exposes only a sanitized current route in the profile menu", async () => {
  const identity = currentStandaloneRouteIdentity({
    accounts: [
      { alias: "Primary", isCurrent: false, credential_ref: "must-not-pass" },
      { alias: "Secondary", isCurrent: true, credential_ref: "must-not-pass" },
    ],
  });
  assert.deepEqual(identity, { alias: "Secondary", label: "Route: Secondary" });
  assert.doesNotMatch(JSON.stringify(identity), /credential_ref|must-not-pass/u);

  const source = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(source, /button\[aria-label="Open profile menu"\]/u);
  assert.match(source, /\[role="menuitem"\]/u);
  assert.match(source, /aria-expanded/u);
  assert.match(source, /Usage remaining/u);
  assert.match(source, /role", "menuitemradio"/u);
  assert.match(source, /Account route/u);
  assert.match(source, /MutationObserver/u);
  assert.match(source, /profileMenuObserver\?\.disconnect/u);
  assert.doesNotMatch(source, /position:\s*"fixed"/u);
});

test("profile menu quota UI inherits native width and exposes a bounded read-only refresh", async () => {
  const panel = await fs.readFile(STANDALONE_PANEL, "utf8");
  const bridge = await fs.readFile(ROUTER_STATUS_BRIDGE, "utf8");
  assert.match(panel, /width: 100%; min-width: 0; max-width: 100%/u);
  assert.doesNotMatch(panel, /min-width: 300px|max-width: 360px/u);
  assert.match(panel, /min-height: 42px/u);
  assert.match(panel, /font-size: 10px; line-height: 1\.25/u);
  assert.match(panel, /weeklyLabel\.replace\(" remaining", ""\)/u);
  assert.match(panel, /Refreshed \$\{utcLabel\(account\.snapshot_observed_at\)\}/u);
  assert.match(panel, /Resets \$\{utcLabel\(account\.weekly_resets_at\)\}/u);
  assert.match(panel, /Refresh Primary weekly quota/u);
  assert.match(panel, /\/__backend\/codex-router\/quota-refresh/u);
  assert.match(panel, /\.\.\.\(await browserCsrfHeaders\(\)\)/u);
  assert.match(bridge, /account\/rateLimits\/read/u);
  assert.match(bridge, /CODEX_UNIX_SOCKET/u);
  assert.match(bridge, /MAX_APP_SERVER_BYTES = 64 \* 1024/u);
  assert.match(bridge, /weekly\.usedPercent < 0/u);
  assert.match(bridge, /weekly\.usedPercent > 100/u);
  assert.match(bridge, /weekly\.resetsAt > 4_102_444_800/u);
  assert.match(bridge, /weekly_resets_at: quotaSnapshot\.weeklyResetsAt/u);
  assert.doesNotMatch(bridge, /thread\/start|turn\/start|responses\/create/u);
});

test("standalone panel permits a bounded recovery switch after an auth cooldown elapses", () => {
  const cooldownUntil = "2026-08-02T06:14:35.460Z";
  const status = {
    status: "ready",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: 0,
    current_route: {
      account_alias: "Secondary",
      continuity: "new_backend_session",
    },
    accounts: [
      {
        alias: "Primary",
        state: "auth_expired",
        enabled: true,
        weekly_remaining_ratio: null,
        snapshot_observed_at: null,
        cooldown_until: cooldownUntil,
        last_switch_reason: "auth_expired",
      },
      {
        alias: "Secondary",
        state: "healthy",
        enabled: true,
        weekly_remaining_ratio: null,
        snapshot_observed_at: null,
        cooldown_until: null,
        last_switch_reason: "manual",
      },
    ],
  };

  const stillCooling = deriveStandalonePanelModel(
    status,
    Date.parse("2026-08-02T06:14:35.459Z"),
  );
  assert.equal(stillCooling.accounts[0].switchDisabled, true);
  assert.equal(stillCooling.accounts[0].switchDisabledReason, "Authentication expired");

  const recoveryEligible = deriveStandalonePanelModel(
    status,
    Date.parse("2026-08-02T06:14:35.460Z"),
  );
  assert.equal(recoveryEligible.accounts[0].switchDisabled, false);
  assert.equal(recoveryEligible.accounts[0].switchDisabledReason, null);
  assert.deepEqual(buildStandaloneSwitchRequest(recoveryEligible.accounts[0]), {
    account_alias: "Primary",
    reason: "manual",
  });

  const noRecoveryBoundary = deriveStandalonePanelModel({
    ...status,
    accounts: [{ ...status.accounts[0], cooldown_until: null }, status.accounts[1]],
  }, Date.parse("2026-08-02T06:14:35.460Z"));
  assert.equal(noRecoveryBoundary.accounts[0].switchDisabled, true);
  assert.equal(noRecoveryBoundary.accounts[0].switchDisabledReason, "Authentication expired");
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

async function panelReplacementFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-panel-replacement-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const predecessorName = "router-account-panel-11111111.js";
  const replacementName = "router-account-panel-22222222.js";
  const preloadName = "preload-33333333.js";
  const predecessor = Buffer.from("old Router accounts panel\n");
  const replacement = Buffer.from([
    "Router accounts",
    "/__backend/codex-router/status",
    "/__backend/codex-router/switch",
    "Cross-account continuity is not verified",
    "installRouterAccountPanel",
    "recoveryEligible",
    "",
  ].join("\n"));
  const app = Buffer.from("qualified connect-app-host App Host bridge\n");
  const preload = Buffer.from("qualified preload\n");
  const index = Buffer.from([
    `<script type="module" src="./assets/${preloadName}"></script>`,
    `<script type="module" src="./assets/${predecessorName}"></script>`,
    "",
  ].join("\n"));
  const predecessorRelative = `${ASSETS}/${predecessorName}`;
  await write(candidate, INDEX, index);
  await write(candidate, `${INDEX}.gz`, gzipSync(index));
  await write(candidate, `${INDEX}.br`, brotliCompressSync(index));
  await write(candidate, APP, app);
  await write(candidate, `${ASSETS}/${preloadName}`, preload);
  await write(candidate, predecessorRelative, predecessor);
  await write(candidate, `${predecessorRelative}.gz`, gzipSync(predecessor));
  await write(candidate, `${predecessorRelative}.br`, brotliCompressSync(predecessor));
  const replacementPath = path.join(root, "replacement.js");
  await fs.writeFile(replacementPath, replacement, { mode: 0o644 });
  return {
    candidate,
    index,
    app,
    preload,
    predecessor,
    predecessorName,
    predecessorRelative,
    replacement,
    replacementName,
    replacementPath,
    contract: {
      predecessor_index_sha256: sha256(index),
      predecessor_panel_name: predecessorName,
      predecessor_panel_sha256: sha256(predecessor),
      qualified_app_sha256: sha256(app),
      qualified_preload_name: preloadName,
      qualified_preload_sha256: sha256(preload),
      replacement_panel_name: replacementName,
      replacement_panel_sha256: sha256(replacement),
    },
  };
}

test("replaces only the standalone panel in an already-qualified release", async (context) => {
  const value = await panelReplacementFixture(context);
  const result = await replaceStandaloneRouterPanel({
    candidate: value.candidate,
    panelModule: value.replacementPath,
    contract: value.contract,
  });
  const index = await fs.readFile(path.join(value.candidate, INDEX));
  const replacementRelative = `${ASSETS}/${value.replacementName}`;
  const replacement = await fs.readFile(path.join(value.candidate, replacementRelative));
  assert.equal(result.event, "standalone_router_panel_replaced");
  assert.equal(result.predecessor_panel_removed, true);
  assert.deepEqual(await fs.readFile(path.join(value.candidate, APP)), value.app);
  assert.deepEqual(
    await fs.readFile(path.join(value.candidate, ASSETS, value.contract.qualified_preload_name)),
    value.preload,
  );
  assert.match(index.toString(), new RegExp(value.replacementName, "u"));
  assert.doesNotMatch(index.toString(), new RegExp(value.predecessorName, "u"));
  assert.deepEqual(replacement, value.replacement);
  assert.deepEqual(gunzipSync(await fs.readFile(`${path.join(value.candidate, replacementRelative)}.gz`)), replacement);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${path.join(value.candidate, replacementRelative)}.br`)), replacement);
  await assert.rejects(fs.access(path.join(value.candidate, value.predecessorRelative)));
  await assert.rejects(fs.access(path.join(value.candidate, `${value.predecessorRelative}.gz`)));
  await assert.rejects(fs.access(path.join(value.candidate, `${value.predecessorRelative}.br`)));
});

test("panel replacement fails before writing when the predecessor panel drifts", async (context) => {
  const value = await panelReplacementFixture(context);
  await fs.appendFile(path.join(value.candidate, value.predecessorRelative), "changed\n");
  const before = await fs.readFile(path.join(value.candidate, INDEX));
  await assert.rejects(
    replaceStandaloneRouterPanel({
      candidate: value.candidate,
      panelModule: value.replacementPath,
      contract: value.contract,
    }),
    /standalone panel replacement failed at validate_predecessor/u,
  );
  assert.deepEqual(await fs.readFile(path.join(value.candidate, INDEX)), before);
  await assert.rejects(
    fs.access(path.join(value.candidate, ASSETS, value.replacementName)),
  );
});

async function r87ServerFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r87-server-bridge-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const main = Buffer.from([
    'const module_1 = require("./module");',
    "class WebSocketMessagePort {}",
    "async function startIpcBridgeServer() {",
    '    const app = (0, fastify_1.default)({ logger: false });',
    '    if (message.type === "ipc-renderer-post-message") return;',
    "}",
    "",
  ].join("\n"));
  const sessionAuth = Buffer.from("exports.registerBrowserSessionAuth = async () => {};\n");
  const routerBridge = Buffer.from("exports.registerRouterStatusBridge = async () => {};\n");
  const sessionAuthPath = path.join(root, "browser-session-auth.js");
  const routerBridgePath = path.join(root, "router-status-bridge.js");
  await write(candidate, "src/server/main.js", main);
  await fs.writeFile(sessionAuthPath, sessionAuth, { mode: 0o644 });
  await fs.writeFile(routerBridgePath, routerBridge, { mode: 0o644 });
  return {
    candidate,
    main,
    sessionAuth,
    routerBridge,
    sessionAuthPath,
    routerBridgePath,
    contract: {
      qualified_main_sha256: sha256(main),
      session_auth_sha256: sha256(sessionAuth),
      router_bridge_sha256: sha256(routerBridge),
    },
  };
}

test("adds only browser session and router status bridges to the qualified R23 server", async (context) => {
  const value = await r87ServerFixture(context);
  const result = await installR87RouterServerBridge({
    candidate: value.candidate,
    sessionAuth: value.sessionAuthPath,
    routerBridge: value.routerBridgePath,
    contract: value.contract,
  });
  const main = await fs.readFile(path.join(value.candidate, "src/server/main.js"), "utf8");
  assert.equal(result.event, "r87_router_server_bridge_installed");
  assert.equal(result.qualified_app_host_preserved, true);
  assert.match(main, /class WebSocketMessagePort/u);
  assert.match(main, /message\.type === "ipc-renderer-post-message"/u);
  assert.match(main, /registerBrowserSessionAuth\)\(app, process\.env\)/u);
  assert.match(main, /registerRouterStatusBridge\)\(app, process\.env\)/u);
  assert.deepEqual(
    await fs.readFile(path.join(value.candidate, "src/server/browser-session-auth.js")),
    value.sessionAuth,
  );
  assert.deepEqual(
    await fs.readFile(path.join(value.candidate, "src/server/router-status-bridge.js")),
    value.routerBridge,
  );
});

test("R87 server bridge installer fails closed before writing when App Host changes", async (context) => {
  const value = await r87ServerFixture(context);
  await fs.appendFile(path.join(value.candidate, "src/server/main.js"), "unexpected\n");
  const changed = await fs.readFile(path.join(value.candidate, "src/server/main.js"));
  await assert.rejects(
    installR87RouterServerBridge({
      candidate: value.candidate,
      sessionAuth: value.sessionAuthPath,
      routerBridge: value.routerBridgePath,
      contract: value.contract,
    }),
    /R87 server bridge install failed at validate_qualified_main/u,
  );
  await assert.rejects(
    fs.access(path.join(value.candidate, "src/server/browser-session-auth.js")),
  );
  await assert.rejects(
    fs.access(path.join(value.candidate, "src/server/router-status-bridge.js")),
  );
  assert.deepEqual(await fs.readFile(path.join(value.candidate, "src/server/main.js")), changed);
});

test("R92 deploys the R86 server adapters without replacing or restarting protected services", async () => {
  const source = await fs.readFile(R92_DEPLOY, "utf8");
  assert.match(source, /router-r91-standalone-panel/u);
  assert.match(source, /router-r86/u);
  assert.match(source, /QUALIFIED_MAIN_SHA256=103d8dbc/u);
  assert.match(source, /INSTALLED_MAIN_SHA256=ea69e94c/u);
  assert.match(source, /SESSION_AUTH_SHA256=e8d447df/u);
  assert.match(source, /ROUTER_BRIDGE_SHA256=185cf83a/u);
  assert.match(source, /class WebSocketMessagePort/u);
  assert.match(source, /ipc-renderer-post-message/u);
  assert.match(source, /expect_8215_unchanged/u);
  assert.match(source, /expect_account_router_unchanged/u);
  assert.match(source, /restart_8216_web_app/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-account-router)/u,
  );
});

test("R94 replaces only the cooldown-aware panel and restarts only routed Web", async () => {
  const source = await fs.readFile(R94_DEPLOY, "utf8");
  assert.match(source, /router-r92-server-bridge/u);
  assert.match(source, /router-r94-manual-switch-recovery/u);
  assert.match(source, /PREDECESSOR_INDEX_SHA256=f9116342/u);
  assert.match(source, /SUCCESSOR_INDEX_SHA256=fc7b9819/u);
  assert.match(source, /PREDECESSOR_PANEL_SHA256=c4f3be1f/u);
  assert.match(source, /SUCCESSOR_PANEL_SHA256=ff0f95b4/u);
  assert.match(source, /SUCCESSOR_INDEX_GZIP_SHA256=593d6423/u);
  assert.match(source, /SUCCESSOR_PANEL_GZIP_SHA256=72f2a2b1/u);
  assert.match(source, /expect_8215_unchanged/u);
  assert.match(source, /expect_protected_8216_processes_unchanged/u);
  assert.match(source, /\]\] \|\| return 1/u);
  assert.match(source, /systemctl restart "\$WEB_SERVICE"/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-account-router|codex-web-router-app-server)/u,
  );
});

test("R95 upgrades only the isolated router and panel, then restores the secondary route", async () => {
  const source = await fs.readFile(R95_DEPLOY, "utf8");
  assert.match(source, /codex-account-router-0\.2\.32-linux-x64/u);
  assert.match(source, /router-r95-manual-switch-display/u);
  assert.match(source, /manual_switch_roundtrip/u);
  assert.match(source, /switch_alias Primary primary/u);
  assert.match(source, /switch_alias Secondary secondary/u);
  assert.match(source, /continuity=new_backend_session/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /expect_protected_services_unchanged/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server)/u,
  );
});

test("R97 replaces only the broken JSON XHR panel and restarts routed Web", async () => {
  const source = await fs.readFile(R97_DEPLOY, "utf8");
  assert.match(source, /router-r97-xhr-switch-repair/u);
  assert.match(source, /EXPECTED_CURRENT=.*router-r95-manual-switch-display/u);
  assert.match(source, /PANEL_SOURCE_SHA256=9db9de1e/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.match(source, /verify_protected/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});

test("R99 moves the sanitized router surface into the profile menu and restarts only routed Web", async () => {
  assert.equal(
    R99_PROFILE_MENU_CONTRACT.predecessor_panel_sha256,
    "9db9de1e0f47a36888ef74fb0a30f5bad52ab31768bd96824131bfca80e21ab2",
  );
  assert.equal(
    R99_PROFILE_MENU_CONTRACT.replacement_panel_sha256,
    "d562ebb2617c2dd5abee9dc9933275eb6f2ece54f8612b41959de725574fdfbe",
  );
  const source = await fs.readFile(R99_DEPLOY, "utf8");
  assert.match(source, /router-r98-browser-metadata/u);
  assert.match(source, /router-r99-profile-menu/u);
  assert.match(source, /SUCCESSOR_INDEX_SHA256=4d2a99f1/u);
  assert.match(source, /SUCCESSOR_PANEL_ASSET=router-account-panel-d562ebb2\.js/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.match(source, /verify_protected/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});

test("R100 locates the semantic profile menu without relying on an inferred container role", async () => {
  assert.equal(
    R100_PROFILE_MENU_CONTRACT.predecessor_panel_sha256,
    R99_PROFILE_MENU_CONTRACT.replacement_panel_sha256,
  );
  assert.equal(
    R100_PROFILE_MENU_CONTRACT.replacement_panel_sha256,
    "559921aef674c12d7f84279c6153d58b8abe0635a64ae6d9ab786499159a3bcd",
  );
  const source = await fs.readFile(R100_DEPLOY, "utf8");
  assert.match(source, /router-r99-profile-menu/u);
  assert.match(source, /router-r100-profile-menu-dom/u);
  assert.match(source, /SUCCESSOR_INDEX_SHA256=3d868b8b/u);
  assert.match(source, /SUCCESSOR_PANEL_ASSET=router-account-panel-559921ae\.js/u);
  assert.match(source, /gzip -cd/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});

test("R101 refreshes Primary quota read-only and restarts only routed Web", async () => {
  assert.equal(
    R101_QUOTA_MENU_CONTRACT.predecessor_panel_sha256,
    R100_PROFILE_MENU_CONTRACT.replacement_panel_sha256,
  );
  assert.equal(
    R101_QUOTA_MENU_CONTRACT.replacement_panel_sha256,
    "fb575a578aedb851e7892be7b1a98e0fc529352e7fd3199c2947acae5688e468",
  );
  const source = await fs.readFile(R101_DEPLOY, "utf8");
  assert.match(source, /router-r100-profile-menu-dom/u);
  assert.match(source, /router-r101-quota-menu/u);
  assert.match(source, /router-account-panel-fb575a57\.js/u);
  assert.match(source, /router-status-bridge-standalone\.js/u);
  assert.match(source, /CODEX_ROUTER_QUOTA_ACCOUNT_ALIAS=Primary/u);
  assert.match(source, /codex-router\/quota-refresh/u);
  assert.match(source, /primary_weekly_quota_read_only=true/u);
  assert.match(source, /weekly_quota_refresh_time_available=true/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});

test("R102 compacts timestamps into the native menu and preserves the R101 quota bridge", async () => {
  assert.equal(
    R102_NATIVE_SIZE_CONTRACT.predecessor_panel_sha256,
    R101_QUOTA_MENU_CONTRACT.replacement_panel_sha256,
  );
  assert.equal(
    R102_NATIVE_SIZE_CONTRACT.replacement_panel_sha256,
    "131a636e367e5c2e94958bc293e73738a17b2fea2a8d05af07c8dc78bd98c098",
  );
  const source = await fs.readFile(R102_DEPLOY, "utf8");
  assert.match(source, /router-r101-quota-menu/u);
  assert.match(source, /router-r102-native-size/u);
  assert.match(source, /router-account-panel-131a636e\.js/u);
  assert.match(source, /SOURCE_ROUTER_BRIDGE_SHA256=ac5c1f13/u);
  assert.match(source, /quota-refresh/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});

test("R103 exposes Weekly reset and observation times without model traffic", async () => {
  assert.equal(
    R103_RESET_TIME_CONTRACT.predecessor_panel_sha256,
    R102_NATIVE_SIZE_CONTRACT.replacement_panel_sha256,
  );
  assert.equal(
    R103_RESET_TIME_CONTRACT.replacement_panel_sha256,
    "051747e79df1eda7dbf937ec5b930a7a30aafb97bbafb2a8df09442987fc92cc",
  );
  const source = await fs.readFile(R103_DEPLOY, "utf8");
  assert.match(source, /router-r102-native-size/u);
  assert.match(source, /router-r103-reset-time/u);
  assert.match(source, /router-account-panel-051747e7\.js/u);
  assert.match(source, /SOURCE_ROUTER_BRIDGE_SHA256=ac5c1f13/u);
  assert.match(source, /SUCCESSOR_ROUTER_BRIDGE_SHA256=cec53389/u);
  assert.match(source, /weekly_resets_at/u);
  assert.match(source, /weekly_quota_reset_time_available=true/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});
