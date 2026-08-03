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
  R104_NATIVE_USAGE_SYNC_CONTRACT,
} from "../../../integrations/codex-web/replace-r104-router-native-usage-sync.mjs";
import {
  R105_NATIVE_USAGE_DOM_CONTRACT,
} from "../../../integrations/codex-web/replace-r105-router-native-usage-dom.mjs";
import {
  R107_DEVICE_CODE_COPY_CONTRACT,
  replaceR107DeviceCodeCopy,
} from "../../../integrations/codex-web/replace-r107-device-code-copy.mjs";
import {
  R109_SAFARI_PROFILE_MENU_CONTRACT,
} from "../../../integrations/codex-web/replace-r109-safari-profile-menu.mjs";
import {
  R110_COMPACT_AUTO_FAILOVER_CONTRACT,
} from "../../../integrations/codex-web/replace-r110-compact-auto-failover.mjs";
import {
  R111_SAFARI_ACCOUNT_LAUNCHER_CONTRACT,
} from "../../../integrations/codex-web/replace-r111-safari-account-launcher.mjs";
import {
  R112_VISIBLE_BOOTSTRAP_LAUNCHER_CONTRACT,
} from "../../../integrations/codex-web/replace-r112-visible-bootstrap-launcher.mjs";
import {
  R113_NATIVE_SIDEBAR_LAUNCHER_CONTRACT,
} from "../../../integrations/codex-web/replace-r113-native-sidebar-launcher.mjs";
import {
  R114_NATIVE_PROFILE_MENU_CONTRACT,
} from "../../../integrations/codex-web/replace-r114-native-profile-menu.mjs";
import {
  R115_OWNED_ACCOUNT_SURFACE_CONTRACT,
} from "../../../integrations/codex-web/replace-r115-owned-account-surface.mjs";
import {
  R116_REACT_ACCOUNT_SETTINGS_CONTRACT,
} from "../../../integrations/codex-web/replace-r116-react-account-settings.mjs";
import {
  replaceR121NativeMenuRow,
} from "../../../integrations/codex-web/replace-r121-native-menu-row.mjs";
import {
  replaceR122NativeMenuContract,
} from "../../../integrations/codex-web/replace-r122-native-menu-contract.mjs";
import {
  replaceR123CurrentQuotaIdentity,
} from "../../../integrations/codex-web/replace-r123-current-quota-identity.mjs";
import {
  atomicWrite,
  r118ControllerSource,
} from "../../../integrations/codex-web/replace-r118-native-identity-sync.mjs";
import {
  accountSurfaceVisibility,
  createAccountSurfaceState,
  reduceAccountSurfaceState,
} from "../../../integrations/codex-web/router-account-surface-lifecycle.js";
import {
  buildManualSwitchRequest as buildStandaloneSwitchRequest,
  buildAccountEnrollmentRequest,
  buildAccountRemovalRequest,
  copyDeviceAuthorizationCode,
  currentRouteIdentity as currentStandaloneRouteIdentity,
  deriveRouterAccountPanelModel as deriveStandalonePanelModel,
  isPrunedNativeMenuLabel,
  nativeUsagePresentation as standaloneNativeUsagePresentation,
} from "../../../integrations/codex-web/router-account-panel-standalone.js";

const INDEX = "scratch/asar/webview/index.html";
const ASSETS = "scratch/asar/webview/assets";
const APP = `${ASSETS}/app-initial-BTphDPeq.js`;
const STANDALONE_PANEL = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/router-account-panel-standalone.js",
);
const REACT_ACCOUNT_SETTINGS = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/react-account-settings/account-settings-window.tsx",
);
const REACT_ACCOUNT_CONTROLLER = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/router-account-controller.js",
);
const REACT_ACCOUNT_PRELOAD = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/react-account-settings/preload-r116.js",
);
const REACT_ACCOUNT_PRELOAD_R121 = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/react-account-settings/preload-r121.js",
);
const REACT_ACCOUNT_PRELOAD_R122 = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/react-account-settings/preload-r122.js",
);
const ROUTER_STATUS_BRIDGE = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/src/server/router-status-bridge.ts",
);

test("removes only the native pet and logout menu entries", () => {
  assert.equal(isPrunedNativeMenuLabel("Show pet"), true);
  assert.equal(isPrunedNativeMenuLabel(" Log out "), true);
  assert.equal(isPrunedNativeMenuLabel("Settings"), false);
  assert.equal(isPrunedNativeMenuLabel("Usage remaining"), false);
  assert.equal(isPrunedNativeMenuLabel("Delete Secondary"), false);
});

test("builds bounded browser account add and delete requests", () => {
  assert.deepEqual(buildAccountEnrollmentRequest("Research 2"), { alias: "Research 2" });
  assert.throws(() => buildAccountEnrollmentRequest("person@example.test"));
  const model = {
    activeStreams: 0,
    accounts: [
      { alias: "Primary", isCurrent: true },
      { alias: "Research 2", isCurrent: false },
    ],
  };
  assert.deepEqual(buildAccountRemovalRequest("Research 2", model), {
    confirm_alias: "Research 2",
  });
  assert.throws(() => buildAccountRemovalRequest("Primary", model));
  assert.throws(() => buildAccountRemovalRequest("Research 2", { ...model, activeStreams: 1 }));
  assert.throws(() => buildAccountRemovalRequest("Research 2", {
    activeStreams: 0,
    accounts: [{ alias: "Research 2", isCurrent: false }],
  }));
});

test("copies only a bounded device code with an HTTP-safe fallback", async () => {
  const calls = [];
  assert.equal(await copyDeviceAuthorizationCode("ABCD-EFGH", {
    clipboardWrite: async (value) => calls.push(["clipboard", value]),
    legacyCopy: (value) => { calls.push(["legacy", value]); return true; },
  }), "clipboard");
  assert.deepEqual(calls, [["clipboard", "ABCD-EFGH"]]);

  assert.equal(await copyDeviceAuthorizationCode("IJKL-MNOP", {
    clipboardWrite: async () => { throw new Error("insecure context"); },
    legacyCopy: (value) => { calls.push(["legacy", value]); return true; },
  }), "legacy");
  assert.deepEqual(calls.at(-1), ["legacy", "IJKL-MNOP"]);

  await assert.rejects(copyDeviceAuthorizationCode("person@example.test", {
    legacyCopy: () => true,
  }), /code is invalid/u);
  await assert.rejects(copyDeviceAuthorizationCode("QRST-UVWX", {
    legacyCopy: () => false,
  }), /copy failed/u);

  const source = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(source, /navigator\?\.clipboard/u);
  assert.match(source, /document\.execCommand\("copy"\)/u);
  assert.match(source, /Copy device authorization code/u);
  assert.doesNotMatch(source, /console\.(?:log|info|debug).*userCode/u);
});

test("keeps the owned account dialog independent from native Settings menu teardown", () => {
  let state = createAccountSurfaceState();
  state = reduceAccountSurfaceState(state, { type: "native_trigger_present" });
  state = reduceAccountSurfaceState(state, { type: "native_menu_opened" });
  state = reduceAccountSurfaceState(state, { type: "account_dialog_opened" });
  state = reduceAccountSurfaceState(state, { type: "native_menu_closed" });
  assert.deepEqual(accountSurfaceVisibility(state), {
    fallbackLauncher: false,
    nativeMenuEntry: false,
    accountDialog: true,
  });

  state = reduceAccountSurfaceState(state, { type: "native_trigger_absent" });
  assert.deepEqual(accountSurfaceVisibility(state), {
    fallbackLauncher: true,
    nativeMenuEntry: false,
    accountDialog: true,
  });

  state = reduceAccountSurfaceState(state, { type: "account_dialog_closed" });
  assert.equal(accountSurfaceVisibility(state).accountDialog, false);
});

test("R116 owns the account window in React and portals only one entry into the native menu", async () => {
  const [reactSource, controllerSource] = await Promise.all([
    fs.readFile(REACT_ACCOUNT_SETTINGS, "utf8"),
    fs.readFile(REACT_ACCOUNT_CONTROLLER, "utf8"),
  ]);
  assert.match(reactSource, /createPortal/u);
  assert.match(reactSource, /createRoot/u);
  assert.match(reactSource, /AccountSettingsDialog/u);
  assert.match(reactSource, /data-router-account-menu-entry/u);
  assert.match(reactSource, /codex-dialog-overlay/u);
  assert.match(reactSource, /bg-token-dropdown-background/u);
  assert.equal([...reactSource.matchAll(/data-router-account-menu-entry=/gu)].length, 1);
  assert.doesNotMatch(reactSource, /attachShadow/u);
  assert.match(controllerSource, /__CODEX_ROUTER_ACCOUNT_SETTINGS__/u);
  assert.doesNotMatch(controllerSource, /attachShadow/u);
  assert.doesNotMatch(controllerSource, /createOwnedAccountSurface/u);
  assert.doesNotMatch(controllerSource, /positionNativeEntry/u);
});

test("R122 follows the upstream native menu item structure and typography contract", async () => {
  const [reactSource, builtPreload] = await Promise.all([
    fs.readFile(REACT_ACCOUNT_SETTINGS, "utf8"),
    fs.readFile(REACT_ACCOUNT_PRELOAD_R122),
  ]);
  assert.match(reactSource, /data-router-account-menu-layout="native-contract"/u);
  assert.match(reactSource, /className="flex flex-col"/u);
  assert.match(reactSource, /className="flex w-full items-center gap-1\.5"/u);
  assert.match(reactSource, /className="flex-1 min-w-0 truncate">Account route/u);
  assert.match(reactSource, /ml-2 shrink-0 text-xs text-token-description-foreground/u);
  assert.match(reactSource, /icon-xs shrink-0 opacity-75 group-focus:opacity-100 group-hover:opacity-100/u);
  assert.match(reactSource, /function RouteIcon/u);
  assert.match(reactSource, /function ChevronRightIcon/u);
  assert.match(reactSource, /currentRouteAlias\(snapshot\)/u);
  assert.doesNotMatch(reactSource, /fontSize: 14/u);
  assert.doesNotMatch(reactSource, /gap: 10/u);
  assert.doesNotMatch(reactSource, /minHeight: 40/u);
  assert.doesNotMatch(reactSource, /padding: "8px 10px"/u);
  assert.doesNotMatch(reactSource, /title=\{snapshot\.label\}/u);
  assert.doesNotMatch(reactSource, />⇄</u);
  assert.doesNotMatch(reactSource, />›</u);
  assert.equal(sha256(builtPreload), "ba57f3d68765fd06d0830c8d1bae5d01c35b02835f71624607733dd869d82dfb");
  assert.match(builtPreload.toString("utf8"), /data-router-account-menu-layout/u);
});

test("R121 replaces only the React preload and keeps the native controller boundary", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r121-native-row-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const assets = path.join(candidate, ASSETS);
  const oldName = "preload-old.js";
  const newName = "preload-new.js";
  const controllerName = "router-account-controller.js";
  const index = Buffer.from(`<script type="module" src="./assets/${controllerName}"></script>\n<script type="module" src="./assets/${oldName}"></script>\n`);
  const oldPreload = Buffer.from("old React preload\n");
  const newPreload = Buffer.from("new native-row React preload\n");
  const controller = Buffer.from("native account controller\n");
  const statusBridge = Buffer.from("status bridge\n");
  const accountManagement = Buffer.from("account management\n");
  const preloadSource = path.join(root, "preload-r121.js");
  const contract = {
    predecessor_index_sha256: sha256(index),
    predecessor_preload_name: oldName,
    predecessor_preload_sha256: sha256(oldPreload),
    controller_name: controllerName,
    controller_sha256: sha256(controller),
    status_bridge_sha256: sha256(statusBridge),
    account_management_sha256: sha256(accountManagement),
    successor_preload_name: newName,
    successor_preload_sha256: sha256(newPreload),
  };
  await Promise.all([
    write(candidate, INDEX, index),
    write(candidate, `${INDEX}.gz`, gzipSync(index)),
    write(candidate, `${INDEX}.br`, brotliCompressSync(index)),
    write(candidate, `${ASSETS}/${oldName}`, oldPreload),
    write(candidate, `${ASSETS}/${oldName}.gz`, gzipSync(oldPreload)),
    write(candidate, `${ASSETS}/${oldName}.br`, brotliCompressSync(oldPreload)),
    write(candidate, `${ASSETS}/${controllerName}`, controller),
    write(candidate, "src/server/router-status-bridge.js", statusBridge),
    write(candidate, "src/server/router-account-management.js", accountManagement),
    fs.writeFile(preloadSource, newPreload, { mode: 0o644 }),
  ]);
  const result = await replaceR121NativeMenuRow({ candidate, reactPreload: preloadSource, contract });
  const nextIndex = await fs.readFile(path.join(candidate, INDEX));
  const nextPreload = await fs.readFile(path.join(assets, newName));
  assert.equal(result.event, "r121_native_menu_row_replaced");
  assert.equal(result.native_menu_layout, "native-row");
  assert.match(nextIndex.toString("utf8"), new RegExp(newName, "u"));
  assert.doesNotMatch(nextIndex.toString("utf8"), new RegExp(oldName, "u"));
  assert.deepEqual(nextPreload, newPreload);
  assert.deepEqual(await fs.readFile(path.join(assets, controllerName)), controller);
  assert.deepEqual(gunzipSync(await fs.readFile(`${path.join(assets, newName)}.gz`)), newPreload);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${path.join(assets, newName)}.br`)), newPreload);
  await assert.rejects(fs.access(path.join(assets, oldName)));
  await assert.rejects(fs.access(`${path.join(assets, oldName)}.gz`));
  await assert.rejects(fs.access(`${path.join(assets, oldName)}.br`));
});

test("R122 replaces only the React preload while preserving native account boundaries", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r122-native-contract-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const assets = path.join(candidate, ASSETS);
  const oldName = "preload-old.js";
  const newName = "preload-new.js";
  const controllerName = "router-account-controller.js";
  const index = Buffer.from(`<script type="module" src="./assets/${controllerName}"></script>\n<script type="module" src="./assets/${oldName}"></script>\n`);
  const oldPreload = Buffer.from("old approximate menu preload\n");
  const newPreload = Buffer.from("new upstream-native menu contract preload\n");
  const controller = Buffer.from("native account controller\n");
  const statusBridge = Buffer.from("status bridge\n");
  const accountManagement = Buffer.from("account management\n");
  const preloadSource = path.join(root, "preload-r122.js");
  const contract = {
    predecessor_index_sha256: sha256(index),
    predecessor_preload_name: oldName,
    predecessor_preload_sha256: sha256(oldPreload),
    controller_name: controllerName,
    controller_sha256: sha256(controller),
    status_bridge_sha256: sha256(statusBridge),
    account_management_sha256: sha256(accountManagement),
    successor_preload_name: newName,
    successor_preload_sha256: sha256(newPreload),
  };
  await Promise.all([
    write(candidate, INDEX, index),
    write(candidate, `${INDEX}.gz`, gzipSync(index)),
    write(candidate, `${INDEX}.br`, brotliCompressSync(index)),
    write(candidate, `${ASSETS}/${oldName}`, oldPreload),
    write(candidate, `${ASSETS}/${oldName}.gz`, gzipSync(oldPreload)),
    write(candidate, `${ASSETS}/${oldName}.br`, brotliCompressSync(oldPreload)),
    write(candidate, `${ASSETS}/${controllerName}`, controller),
    write(candidate, "src/server/router-status-bridge.js", statusBridge),
    write(candidate, "src/server/router-account-management.js", accountManagement),
    fs.writeFile(preloadSource, newPreload, { mode: 0o644 }),
  ]);
  const result = await replaceR122NativeMenuContract({ candidate, reactPreload: preloadSource, contract });
  const nextIndex = await fs.readFile(path.join(candidate, INDEX));
  const nextPreload = await fs.readFile(path.join(assets, newName));
  assert.equal(result.event, "r122_native_menu_contract_replaced");
  assert.equal(result.native_menu_layout, "native-contract");
  assert.match(nextIndex.toString("utf8"), new RegExp(newName, "u"));
  assert.doesNotMatch(nextIndex.toString("utf8"), new RegExp(oldName, "u"));
  assert.deepEqual(nextPreload, newPreload);
  assert.deepEqual(await fs.readFile(path.join(assets, controllerName)), controller);
  assert.deepEqual(gunzipSync(await fs.readFile(`${path.join(assets, newName)}.gz`)), newPreload);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${path.join(assets, newName)}.br`)), newPreload);
  await assert.rejects(fs.access(path.join(assets, oldName)));
  await assert.rejects(fs.access(`${path.join(assets, oldName)}.gz`));
  await assert.rejects(fs.access(`${path.join(assets, oldName)}.br`));
});

test("R123 binds the visible weekly quota to the current native App Server identity", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r123-current-quota-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const oldName = "preload-old.js";
  const controllerName = "router-account-controller.js";
  const index = Buffer.from(`<script type="module" src="./assets/${controllerName}"></script>\n<script type="module" src="./assets/${oldName}"></script>\n`);
  const oldPreload = Buffer.from("const label = 'Refresh Primary weekly quota';\n");
  const controller = Buffer.from("native account controller\n");
  const oldBridge = Buffer.from("old status bridge\n");
  const nextBridge = Buffer.from("credential-verified current status bridge\n");
  const accountManagement = Buffer.from("account management\n");
  const bridgeSource = path.join(root, "router-status-bridge.js");
  const contract = {
    predecessor_index_sha256: sha256(index),
    predecessor_preload_name: oldName,
    predecessor_preload_sha256: sha256(oldPreload),
    controller_name: controllerName,
    controller_sha256: sha256(controller),
    predecessor_status_bridge_sha256: sha256(oldBridge),
    successor_status_bridge_sha256: sha256(nextBridge),
    account_management_sha256: sha256(accountManagement),
  };
  await Promise.all([
    write(candidate, INDEX, index),
    write(candidate, `${INDEX}.gz`, gzipSync(index)),
    write(candidate, `${INDEX}.br`, brotliCompressSync(index)),
    write(candidate, `${ASSETS}/${oldName}`, oldPreload),
    write(candidate, `${ASSETS}/${oldName}.gz`, gzipSync(oldPreload)),
    write(candidate, `${ASSETS}/${oldName}.br`, brotliCompressSync(oldPreload)),
    write(candidate, `${ASSETS}/${controllerName}`, controller),
    write(candidate, "src/server/router-status-bridge.js", oldBridge),
    write(candidate, "src/server/router-account-management.js", accountManagement),
    fs.writeFile(bridgeSource, nextBridge, { mode: 0o644 }),
  ]);

  const result = await replaceR123CurrentQuotaIdentity({ candidate, statusBridge: bridgeSource, contract });
  const nextIndex = await fs.readFile(path.join(candidate, INDEX), "utf8");
  const nextPreload = await fs.readFile(path.join(candidate, ASSETS, result.react_preload_name), "utf8");
  assert.equal(result.event, "r123_current_quota_identity_installed");
  assert.equal(result.quota_identity, "native_app_server_credential");
  assert.equal(result.model_request_sent, false);
  assert.equal(result.account_switch_sent, false);
  assert.match(nextIndex, new RegExp(result.react_preload_name, "u"));
  assert.doesNotMatch(nextIndex, new RegExp(oldName, "u"));
  assert.match(nextPreload, /Refresh current account weekly quota/u);
  assert.doesNotMatch(nextPreload, /Refresh Primary weekly quota/u);
  assert.deepEqual(await fs.readFile(path.join(candidate, "src/server/router-status-bridge.js")), nextBridge);
  await assert.rejects(fs.access(path.join(candidate, ASSETS, oldName)));
  assert.deepEqual(
    gunzipSync(await fs.readFile(`${path.join(candidate, ASSETS, result.react_preload_name)}.gz`)).toString("utf8"),
    nextPreload,
  );
  assert.deepEqual(
    brotliDecompressSync(await fs.readFile(`${path.join(candidate, ASSETS, result.react_preload_name)}.br`)).toString("utf8"),
    nextPreload,
  );
});

test("R116 replaces the Shadow DOM surface and restarts only routed Web", async () => {
  const [controller, preload, deployment] = await Promise.all([
    fs.readFile(REACT_ACCOUNT_CONTROLLER),
    fs.readFile(REACT_ACCOUNT_PRELOAD),
    fs.readFile(R116_DEPLOY, "utf8"),
  ]);
  assert.equal(R116_REACT_ACCOUNT_SETTINGS_CONTRACT.controller_sha256, sha256(controller));
  assert.equal(R116_REACT_ACCOUNT_SETTINGS_CONTRACT.react_preload_sha256, sha256(preload));
  assert.equal(
    R116_REACT_ACCOUNT_SETTINGS_CONTRACT.predecessor_panel_name,
    "router-account-panel-270c1de0.js",
  );
  assert.match(deployment, /router-r115-owned-account-surface/u);
  assert.match(deployment, /router-account-controller-e506d62f\.js/u);
  assert.match(deployment, /preload-e102b9bc\.js/u);
  assert.match(deployment, /react_account_settings_window=true/u);
  assert.match(deployment, /shadow_dom=false/u);
  assert.match(deployment, /native_menu_portal_entries=1/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R121 deploys the native menu row by restarting only routed 8216 Web", async () => {
  const deployment = await fs.readFile(R121_DEPLOY, "utf8");
  assert.match(deployment, /router-r120-catalog-owner-boundary/u);
  assert.match(deployment, /router-r121-native-menu-row/u);
  assert.match(deployment, /preload-e9339fb8\.js/u);
  assert.match(deployment, /native_menu_layout=native-row/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.match(deployment, /systemctl restart "\$WEB_SERVICE"/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R122 deploys the upstream native menu contract by restarting only routed 8216 Web", async () => {
  const deployment = await fs.readFile(R122_DEPLOY, "utf8");
  assert.match(deployment, /router-r121-native-menu-row/u);
  assert.match(deployment, /router-r122-native-menu-contract/u);
  assert.match(deployment, /preload-ba57f3d6\.js/u);
  assert.match(deployment, /native_menu_layout=native-contract/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.match(deployment, /systemctl restart "\$WEB_SERVICE"/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R118 requires a completed native identity transaction before reloading a new backend session", async () => {
  const original = await fs.readFile(REACT_ACCOUNT_CONTROLLER, "utf8");
  const source = r118ControllerSource(original);
  assert.match(source, /native_identity_rebound !== true/u);
  assert.match(source, /web_restart_required !== true/u);
  assert.match(source, /continuity !== "new_backend_session"/u);
  assert.match(source, /Starting a new backend session/u);
  assert.match(source, /window\.location\.reload\(\)/u);
  assert.equal(source.match(/window\.location\.reload\(\)/gu)?.length, 1);
  assert.doesNotMatch(original, /native_identity_rebound/u);
  assert.throws(() => r118ControllerSource(source), /anchor is unavailable/u);
});

test("R118 atomic release writes remain readable under a restrictive deployment umask", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-r118-mode-"));
  const target = path.join(root, "router-status-bridge.js");
  const previousUmask = process.umask(0o077);
  try {
    await atomicWrite(target, Buffer.from("module.exports = {};\n"), 0o644);
  } finally {
    process.umask(previousUmask);
  }
  try {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("owns the account surface outside the upstream React tree", async () => {
  const source = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(source, /attachShadow\(\{ mode: "open" \}\)/u);
  assert.match(source, /dataset\.routerOwnedSurface/u);
  assert.match(source, /createOwnedAccountSurface/u);
  assert.match(source, /createNativeProfileMenuAdapter/u);
  assert.doesNotMatch(source, /MutationObserver/u);
  assert.doesNotMatch(source, /syncProfileRouteIdentity/u);
  assert.doesNotMatch(source, /syncNativeUsageSurface/u);
  assert.doesNotMatch(source, /pruneNativeProfileMenuItems/u);
  assert.doesNotMatch(source, /PROFILE_ROUTE_ATTRIBUTE/u);
});
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
const R104_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r104-native-usage-sync.sh",
);
const R105_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r105-native-usage-dom.sh",
);
const R107_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r107-device-code-copy.sh",
);
const R109_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r109-safari-profile-menu.sh",
);
const R110_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r110-compact-auto-failover.sh",
);
const R111_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r111-safari-account-launcher.sh",
);
const R112_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r112-visible-bootstrap-launcher.sh",
);
const R113_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r113-native-sidebar-launcher.sh",
);
const R114_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r114-native-profile-menu.sh",
);
const R115_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r115-owned-account-surface.sh",
);
const R116_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r116-react-account-settings.sh",
);
const R121_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r121-native-menu-row.sh",
);
const R122_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r122-native-menu-contract.sh",
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

test("standalone panel exposes only a sanitized current route in its owned account surface", async () => {
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
  assert.match(source, /role", "menuitemradio"/u);
  assert.match(source, /Account route/u);
  assert.match(source, /PROFILE_MENU_ACTIVATION_EVENTS/u);
  assert.match(source, /createNativeProfileMenuAdapter/u);
  assert.match(source, /attachShadow/u);
  assert.doesNotMatch(source, /new MutationObserver/u);
  assert.doesNotMatch(source, /syncNativeUsageSurface/u);
});

test("profile menu discovery has a language-neutral Safari fallback", async () => {
  const source = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(source, /button\[aria-haspopup="menu"\]/u);
  assert.match(source, /\[role="menu"\]/u);
  assert.match(source, /aria-controls/u);
  assert.match(source, /getBoundingClientRect/u);
});

test("native Usage remaining presentation follows the sanitized current router route", () => {
  const secondary = standaloneNativeUsagePresentation({
    accounts: [
      {
        alias: "Primary",
        isCurrent: false,
        weeklyLabel: "45% remaining",
        weeklyResetDetail: "Resets 2026-08-08 04:34 UTC",
        weeklyDetail: "Refreshed 2026-08-02 14:02 UTC",
        credential_ref: "must-not-pass",
      },
      {
        alias: "Secondary",
        isCurrent: true,
        weeklyLabel: "100% remaining",
        weeklyResetDetail: "Resets: unavailable",
        weeklyDetail: "Refreshed 2026-08-02 09:00 UTC",
        credential_ref: "must-not-pass",
      },
    ],
  });
  assert.deepEqual(secondary, {
    alias: "Secondary",
    badgeLabel: "Secondary",
    weeklyLabel: "Weekly · Secondary",
    weeklyValue: "100%",
    resetValue: "Reset unavailable",
    refreshedValue: "08-02 09:00 UTC",
  });
  assert.doesNotMatch(JSON.stringify(secondary), /credential_ref|must-not-pass/u);

  const primary = standaloneNativeUsagePresentation({
    accounts: [
      {
        alias: "Primary",
        isCurrent: true,
        weeklyLabel: "45% remaining",
        weeklyResetDetail: "Resets 2026-08-08 04:34 UTC",
        weeklyDetail: "Refreshed 2026-08-02 14:02 UTC",
      },
    ],
  });
  assert.equal(primary?.weeklyLabel, "Weekly · Primary");
  assert.equal(primary?.weeklyValue, "45%");
  assert.equal(primary?.resetValue, "Reset 08-08 04:34 UTC");
  assert.equal(primary?.refreshedValue, "08-02 14:02 UTC");
});

test("profile menu quota UI inherits native width and exposes a bounded read-only refresh", async () => {
  const [panel, bridge, reactSource] = await Promise.all([
    fs.readFile(STANDALONE_PANEL, "utf8"),
    fs.readFile(ROUTER_STATUS_BRIDGE, "utf8"),
    fs.readFile(REACT_ACCOUNT_SETTINGS, "utf8"),
  ]);
  assert.match(panel, /width: 100%; min-width: 0; max-width: 100%/u);
  assert.doesNotMatch(panel, /min-width: 300px|max-width: 360px/u);
  assert.match(panel, /min-height: 38px/u);
  assert.match(panel, /font-size: 10px; line-height: 1\.25/u);
  assert.match(panel, /weeklyLabel\.replace\(" remaining", ""\)/u);
  assert.match(panel, /Refreshed \$\{utcLabel\(account\.snapshot_observed_at\)\}/u);
  assert.match(panel, /Resets \$\{utcLabel\(account\.weekly_resets_at\)\}/u);
  assert.match(reactSource, /Refresh current account weekly quota/u);
  assert.match(panel, /\/__backend\/codex-router\/quota-refresh/u);
  assert.match(panel, /\.\.\.\(await browserCsrfHeaders\(\)\)/u);
  assert.match(bridge, /account\/rateLimits\/read/u);
  assert.match(bridge, /CODEX_UNIX_SOCKET/u);
  assert.match(bridge, /MAX_APP_SERVER_BYTES = 64 \* 1024/u);
  assert.match(bridge, /weekly\.usedPercent < 0/u);
  assert.match(bridge, /weekly\.usedPercent > 100/u);
  assert.match(bridge, /weekly\.resetsAt > 4_102_444_800/u);
  assert.match(bridge, /weekly_resets_at: quotaSnapshot\.weeklyResetsAt/u);
  assert.match(bridge, /currentQuotaIdentity/u);
  assert.match(bridge, /operation: "observe"/u);
  assert.match(bridge, /identityAfter !== identityBefore/u);
  assert.match(bridge, /identityAlias !== status\.current_route\.account_alias/u);
  assert.doesNotMatch(bridge, /config\.accountAlias/u);
  assert.match(bridge, /account\.alias !== currentAlias/u);
  assert.match(bridge, /weekly_remaining_ratio: null/u);
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

test("R104 synchronizes native Usage remaining with the current router route only", async () => {
  assert.equal(
    R104_NATIVE_USAGE_SYNC_CONTRACT.predecessor_panel_sha256,
    R103_RESET_TIME_CONTRACT.replacement_panel_sha256,
  );
  assert.equal(
    R104_NATIVE_USAGE_SYNC_CONTRACT.replacement_panel_sha256,
    "f9d5a01a6b5c535c3d2f3bcb047464eed7f6d3a9da81977aa2356276de0be3fc",
  );
  const source = await fs.readFile(R104_DEPLOY, "utf8");
  assert.match(source, /router-r103-reset-time/u);
  assert.match(source, /router-r104-native-usage-sync/u);
  assert.match(source, /router-account-panel-f9d5a01a\.js/u);
  assert.match(source, /native_usage_tracks_current_router_route=true/u);
  assert.match(source, /fixed_app_host_identity_unchanged=true/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+(?:codex-web-upstream|codex-web-upstream-app-server|codex-web-router-app-server|codex-account-router)/u,
  );
});

test("R105 targets the leaf Weekly label and preserves native Learn more semantics", async () => {
  assert.equal(
    R105_NATIVE_USAGE_DOM_CONTRACT.predecessor_panel_sha256,
    R104_NATIVE_USAGE_SYNC_CONTRACT.replacement_panel_sha256,
  );
  assert.equal(
    R105_NATIVE_USAGE_DOM_CONTRACT.replacement_panel_sha256,
    "673d9a21fce3b64cea49605958d0d92fd7c4d1974f5f1e3415126a2b6d1f6214",
  );
  const source = await fs.readFile(R105_DEPLOY, "utf8");
  assert.match(source, /router-r104-native-usage-sync/u);
  assert.match(source, /router-r105-native-usage-dom/u);
  assert.match(source, /router-account-panel-673d9a21\.js/u);
  assert.match(source, /native_usage_values_are_not_help_links=true/u);
  assert.match(source, /only_8216_web_restarted=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
});

test("R107 pins the HTTP-safe device-code copy panel and protects every non-Web service", async () => {
  const deployment = await fs.readFile(R107_DEPLOY, "utf8");
  assert.equal(
    R107_DEVICE_CODE_COPY_CONTRACT.replacement_panel_sha256,
    "8324c7accea08eda67fb023abef04ba100093a88f62755e8f0231f1e89f569b8",
  );
  assert.equal(R107_DEVICE_CODE_COPY_CONTRACT.predecessor_panel_name, "router-account-panel-6c92b532.js");
  assert.match(deployment, /router-r106-account-management/u);
  assert.match(deployment, /router-account-panel-8324c7ac\.js/u);
  assert.match(deployment, /copy_device_code_fallback=true/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R109 pins language-neutral Safari menu discovery and restarts only routed Web", async () => {
  const deployment = await fs.readFile(R109_DEPLOY, "utf8");
  assert.equal(
    R109_SAFARI_PROFILE_MENU_CONTRACT.replacement_panel_sha256,
    "9dc6748baa2a059dd1e4655ef25e2b1ef5fa106e6e1db753e04f0752ecd295f5",
  );
  assert.equal(
    R109_SAFARI_PROFILE_MENU_CONTRACT.predecessor_panel_name,
    "router-account-panel-8324c7ac.js",
  );
  assert.match(deployment, /router-r108-persistent-uploads/u);
  assert.match(deployment, /router-account-panel-9dc6748b\.js/u);
  assert.match(deployment, /safari_language_neutral_profile_menu=true/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("left-bottom account menu exposes bounded automatic failover in a compact native layout", async () => {
  const panel = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(panel, /Auto failover · pre-output only/u);
  assert.match(panel, /router-account-meta/u);
  assert.match(panel, /router-account-reset/u);
  assert.match(panel, /setAttribute\("aria-label", `Delete \$\{account\.alias\}`\)/u);
  assert.match(panel, /router-remove", "×"/u);
  assert.match(panel, /min-height: 38px/u);
  assert.match(panel, /footnote\.title = "Cross-account continuity is not verified\."/u);
});

test("Safari exposes an owned fallback launcher without mutating the native profile menu", async () => {
  const panel = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(panel, /codex-router-owned-account-surface/u);
  assert.match(panel, /dataset\.routerFallbackLauncher/u);
  assert.match(panel, /Account routing settings/u);
  assert.match(panel, /Account route · Loading…/u);
  assert.match(panel, /position: fixed/u);
  assert.match(panel, /aria-haspopup", "dialog"/u);
});

test("account launcher renders before protected router status and survives an initial failure", async () => {
  const panel = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(panel, /Account route · Loading…/u);
  assert.match(panel, /status_changed", status: "unavailable"/u);
  assert.match(panel, /renderOwnedSurface\(\);\s*try \{/u);
  assert.match(panel, /Router status is temporarily unavailable\./u);
});

test("account launcher remains a temporary fallback outside the React-owned native sidebar", async () => {
  const panel = await fs.readFile(STANDALONE_PANEL, "utf8");
  const lifecycle = await fs.readFile(path.resolve(
    import.meta.dirname,
    "../../../integrations/codex-web/router-account-surface-lifecycle.js",
  ), "utf8");
  assert.match(panel, /dataset\.routerOwnedSurface/u);
  assert.match(panel, /attachShadow\(\{ mode: "open" \}\)/u);
  assert.match(lifecycle, /fallbackLauncher: !state\.triggerAvailable/u);
  assert.match(lifecycle, /nativeMenuEntry: state\.triggerAvailable && state\.nativeMenuVisible/u);
  assert.doesNotMatch(panel, /native-sidebar/u);
  assert.doesNotMatch(panel, /footer\.parentElement\.insertBefore/u);
});

test("native profile-menu integration is event-driven and never watches or mutates the React footer", async () => {
  const panel = await fs.readFile(STANDALONE_PANEL, "utf8");
  assert.match(panel, /PROFILE_MENU_ACTIVATION_EVENTS/u);
  assert.match(panel, /PROFILE_MENU_RENDER_MAX_ATTEMPTS/u);
  assert.match(panel, /createNativeProfileMenuAdapter/u);
  assert.match(panel, /activationHandler/u);
  assert.match(panel, /addEventListener\(eventName, activationHandler, true\)/u);
  assert.match(panel, /dataset\.routerOwnedSurface/u);
  assert.doesNotMatch(panel, /new MutationObserver/u);
  assert.doesNotMatch(panel, /footer\.parentElement\.insertBefore/u);
  assert.doesNotMatch(panel, /SIDEBAR_LAUNCHER_ROW_ID/u);
  assert.doesNotMatch(panel, /syncProfileRouteIdentity/u);
  assert.doesNotMatch(panel, /syncNativeUsageSurface/u);
});

test("R110 pins the compact panel and expands only bounded pre-output failover", async () => {
  const [deployment, dropin] = await Promise.all([
    fs.readFile(R110_DEPLOY, "utf8"),
    fs.readFile(
      path.resolve(
        import.meta.dirname,
        "../../../systemd/8216-fixture/codex-account-router.service.d/multi-account-failover.conf",
      ),
      "utf8",
    ),
  ]);
  assert.equal(
    R110_COMPACT_AUTO_FAILOVER_CONTRACT.replacement_panel_sha256,
    "23e5003262db751be029f0a1b32c8945601d1536d8beda8d7457a83367c1d4fe",
  );
  assert.equal(
    R110_COMPACT_AUTO_FAILOVER_CONTRACT.predecessor_panel_name,
    "router-account-panel-9dc6748b.js",
  );
  assert.equal(dropin, "[Service]\nEnvironment=CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS=16\n");
  assert.match(deployment, /router-r109-safari-profile-menu/u);
  assert.match(deployment, /router-account-panel-23e50032\.js/u);
  assert.match(deployment, /failover_max_attempts=16/u);
  assert.match(deployment, /semantic_output_replay_forbidden=true/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R111 pins an always-visible Safari launcher and restarts only routed Web", async () => {
  const deployment = await fs.readFile(R111_DEPLOY, "utf8");
  assert.equal(
    R111_SAFARI_ACCOUNT_LAUNCHER_CONTRACT.replacement_panel_sha256,
    "2043970fdfe436b46f900e7041e8d8c4cbdce019db551b2b0f1517e09013b88a",
  );
  assert.equal(
    R111_SAFARI_ACCOUNT_LAUNCHER_CONTRACT.predecessor_panel_name,
    "router-account-panel-23e50032.js",
  );
  assert.match(deployment, /router-r110-compact-auto-failover/u);
  assert.match(deployment, /router-account-panel-2043970f\.js/u);
  assert.match(deployment, /safari_always_visible_account_launcher=true/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R112 pins the pre-status launcher and restarts only routed Web", async () => {
  const deployment = await fs.readFile(R112_DEPLOY, "utf8");
  assert.equal(
    R112_VISIBLE_BOOTSTRAP_LAUNCHER_CONTRACT.replacement_panel_sha256,
    "8a5b36594e6fd0c1dce9601d02ddefaa2ba0dc52a14babc2e3d9bd90fee1487d",
  );
  assert.equal(
    R112_VISIBLE_BOOTSTRAP_LAUNCHER_CONTRACT.predecessor_panel_name,
    "router-account-panel-2043970f.js",
  );
  assert.match(deployment, /router-r111-safari-account-launcher/u);
  assert.match(deployment, /router-account-panel-8a5b3659\.js/u);
  assert.match(deployment, /pre_status_launcher_visible=true/u);
  assert.match(deployment, /initial_status_failure_visible=true/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R113 records the rejected native-sidebar release and its bounded deployment scope", async () => {
  const deployment = await fs.readFile(R113_DEPLOY, "utf8");
  assert.equal(
    R113_NATIVE_SIDEBAR_LAUNCHER_CONTRACT.replacement_panel_sha256,
    "8102f63226b9b0bdb36a6fd0ec34d9313122aa4b10058ec6c970b5dc9c45c1b7",
  );
  assert.equal(
    R113_NATIVE_SIDEBAR_LAUNCHER_CONTRACT.predecessor_panel_name,
    "router-account-panel-8a5b3659.js",
  );
  assert.match(deployment, /router-r112-visible-bootstrap-launcher/u);
  assert.match(deployment, /router-account-panel-8102f632\.js/u);
  assert.match(deployment, /native_left_bottom_launcher=true/u);
  assert.match(deployment, /pre_status_launcher_visible=true/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R114 integrates through the native profile menu without a body observer or footer mutation", async () => {
  const deployment = await fs.readFile(R114_DEPLOY, "utf8");
  assert.equal(
    R114_NATIVE_PROFILE_MENU_CONTRACT.replacement_panel_sha256,
    "0f9f3a68fd6e26b1070b98ae04df5d044c4b954d1e550b4dbad3c0f32eb19f17",
  );
  assert.equal(
    R114_NATIVE_PROFILE_MENU_CONTRACT.predecessor_panel_name,
    "router-account-panel-8a5b3659.js",
  );
  assert.match(deployment, /router-r112-visible-bootstrap-launcher/u);
  assert.match(deployment, /router-account-panel-0f9f3a68\.js/u);
  assert.match(deployment, /native_profile_menu_integration=true/u);
  assert.match(deployment, /react_footer_mutation=false/u);
  assert.match(deployment, /body_mutation_observer=false/u);
  assert.match(deployment, /bounded_profile_menu_render_attempts=5/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});

test("R115 owns lifecycle and controls outside React and restarts only routed Web", async () => {
  const [panel, lifecycle, deployment] = await Promise.all([
    fs.readFile(STANDALONE_PANEL),
    fs.readFile(path.resolve(
      import.meta.dirname,
      "../../../integrations/codex-web/router-account-surface-lifecycle.js",
    )),
    fs.readFile(R115_DEPLOY, "utf8"),
  ]);
  assert.equal(R115_OWNED_ACCOUNT_SURFACE_CONTRACT.replacement_panel_sha256, sha256(panel));
  assert.equal(R115_OWNED_ACCOUNT_SURFACE_CONTRACT.lifecycle_sha256, sha256(lifecycle));
  assert.equal(
    R115_OWNED_ACCOUNT_SURFACE_CONTRACT.predecessor_panel_name,
    "router-account-panel-8a5b3659.js",
  );
  assert.match(deployment, /router-r112-visible-bootstrap-launcher/u);
  assert.match(deployment, /router-account-panel-270c1de0\.js/u);
  assert.match(deployment, /router-account-surface-lifecycle\.js/u);
  assert.match(deployment, /owned_shadow_surface=true/u);
  assert.match(deployment, /native_react_tree_mutation=false/u);
  assert.match(deployment, /settings_teardown_closes_account_dialog=false/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.match(deployment, /account_router_process_unchanged=true/u);
  assert.match(deployment, /account_manager_process_unchanged=true/u);
  assert.match(deployment, /only_8216_web_restarted=true/u);
  assert.match(deployment, /model_request_sent=false/u);
  assert.match(deployment, /account_switch_sent=false/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:APP_SERVICE|ROUTER_SERVICE|MANAGER_SERVICE|MANAGER_SOCKET|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});
