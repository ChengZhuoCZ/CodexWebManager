import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installR106AccountManagement,
} from "../../../integrations/codex-web/install-r106-account-management.mjs";
import {
  R106_ACCOUNT_MANAGEMENT_PANEL_CONTRACT,
} from "../../../integrations/codex-web/replace-r106-router-account-management.mjs";

const DEPLOYMENT = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r106-account-management.sh",
);
const PANEL = path.resolve(
  import.meta.dirname,
  "../../../integrations/codex-web/router-account-panel-standalone.js",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r106-account-management-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const mainPath = path.join(candidate, "src/server/main.js");
  const managementModule = path.join(root, "router-account-management.js");
  const main = Buffer.from([
    'const browser_session_auth_1 = require("./browser-session-auth");',
    'const router_status_bridge_1 = require("./router-status-bridge");',
    "class WebSocketMessagePort {}",
    "async function start() {",
    '    if (message.type === "ipc-renderer-post-message") {}',
    "    await (0, browser_session_auth_1.registerBrowserSessionAuth)(app, process.env);",
    "    await (0, router_status_bridge_1.registerRouterStatusBridge)(app, process.env);",
    "}",
    "",
  ].join("\n"));
  const moduleBytes = Buffer.from([
    '"use strict";',
    "Object.defineProperty(exports, \"__esModule\", { value: true });",
    "exports.registerRouterAccountManagement = registerRouterAccountManagement;",
    "async function registerRouterAccountManagement(app, environment) {}",
    "",
  ].join("\n"));
  await fs.mkdir(path.dirname(mainPath), { recursive: true });
  await fs.writeFile(mainPath, main, { mode: 0o644 });
  await fs.writeFile(managementModule, moduleBytes, { mode: 0o644 });
  return {
    candidate,
    main,
    mainPath,
    managementModule,
    moduleBytes,
    contract: {
      source_main_sha256: sha256(main),
      management_module_sha256: sha256(moduleBytes),
    },
  };
}

test("R106 installs one fixed account-management module without replacing the App Host bridges", async (context) => {
  const value = await fixture(context);
  const result = await installR106AccountManagement(value);
  const main = await fs.readFile(value.mainPath, "utf8");
  const installed = await fs.readFile(
    path.join(value.candidate, "src/server/router-account-management.js"),
  );

  assert.equal(result.event, "r106_account_management_installed");
  assert.equal(result.qualified_app_host_preserved, true);
  assert.equal(result.management_module_sha256, sha256(value.moduleBytes));
  assert.deepEqual(installed, value.moduleBytes);
  assert.equal(main.match(/require\("\.\/router-account-management"\)/gu)?.length, 1);
  assert.equal(main.match(/registerRouterAccountManagement\)\(app, process\.env\)/gu)?.length, 1);
  assert.equal(main.match(/registerBrowserSessionAuth\)\(app, process\.env\)/gu)?.length, 1);
  assert.equal(main.match(/registerRouterStatusBridge\)\(app, process\.env\)/gu)?.length, 1);
  assert.match(main, /class WebSocketMessagePort/u);
  assert.match(main, /ipc-renderer-post-message/u);
});

test("R106 fails closed before writing when the qualified main or fixed module changes", async (context) => {
  const value = await fixture(context);
  const before = await fs.readFile(value.mainPath);
  await fs.appendFile(value.managementModule, "unexpected\n");
  await assert.rejects(
    installR106AccountManagement(value),
    /failed at validate_management_module/u,
  );
  assert.deepEqual(await fs.readFile(value.mainPath), before);
  await assert.rejects(
    fs.access(path.join(value.candidate, "src/server/router-account-management.js")),
  );
});

test("R106 panel and deployment are pinned to the approved 8216-only privilege boundary", async () => {
  const deployment = await fs.readFile(DEPLOYMENT, "utf8");
  assert.equal(
    R106_ACCOUNT_MANAGEMENT_PANEL_CONTRACT.replacement_panel_sha256,
    "6c92b5320a91dcd76508552bb93ab75b1a57cb7dfd98503a5740166ec6cc7b4a",
  );
  assert.equal(
    R106_ACCOUNT_MANAGEMENT_PANEL_CONTRACT.predecessor_panel_name,
    "router-account-panel-673d9a21.js",
  );
  assert.match(deployment, /codex-router-account-manager\.socket/u);
  assert.match(deployment, /probe_fixed_socket_protocol/u);
  assert.match(deployment, /private_store_changed/u);
  assert.match(deployment, /PANEL_SOURCE_SHA256=6c92b532/u);
  assert.match(deployment, /standalone_8215_unchanged=true/u);
  assert.match(deployment, /routed_8216_app_server_unchanged=true/u);
  assert.doesNotMatch(
    deployment,
    /systemctl\s+(?:restart|stop|start)\s+"?\$?(?:STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE|APP_SERVICE)/u,
  );
  assert.doesNotMatch(deployment, /__backend\/codex-router\/switch/u);
  assert.doesNotMatch(deployment, /method:\s*["']DELETE["']/u);
  assert.doesNotMatch(
    deployment,
    /(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/iu,
  );
});
