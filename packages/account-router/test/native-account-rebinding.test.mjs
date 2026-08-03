import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeAccountRebinder } from "../src/native-account-rebinding.mjs";

const primary = `${JSON.stringify({ tokens: { access_token: "fixture-primary", account_id: "workspace-primary" } })}\n`;
const secondary = `${JSON.stringify({ tokens: { access_token: "fixture-secondary", account_id: "workspace-secondary" } })}\n`;

async function fixture(context, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-account-rebind-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentials = path.join(root, "credentials");
  await fs.mkdir(credentials, { mode: 0o700 });
  const accountsFile = path.join(root, "accounts.json");
  const appServerCredentialFile = path.join(root, "app-server-auth.json");
  await fs.writeFile(accountsFile, `${JSON.stringify({
    version: 1,
    accounts: [
      {
        id: "primary",
        alias: "Primary",
        enabled: true,
        priority: 0,
        max_concurrency: 1,
        provider: "openai-codex",
        secret_provider: "codex-auth",
        credential_ref: "codex-account-router.auth.primary",
      },
      {
        id: "secondary",
        alias: "Secondary",
        enabled: true,
        priority: 0,
        max_concurrency: 1,
        provider: "openai-codex",
        secret_provider: "codex-auth",
        credential_ref: "codex-account-router.auth.secondary",
      },
    ],
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(credentials, "codex-account-router.auth.primary"), primary, { mode: 0o600 });
  await fs.writeFile(path.join(credentials, "codex-account-router.auth.secondary"), secondary, { mode: 0o600 });
  await fs.writeFile(appServerCredentialFile, primary, { mode: 0o600 });
  const calls = [];
  let route = "Primary";
  const statuses = overrides.statuses ? [...overrides.statuses] : null;
  let readiness = overrides.readiness ? [...overrides.readiness] : null;
  const rebinder = createNativeAccountRebinder({
    accountsFile,
    credentialStoreDirectory: credentials,
    appServerCredentialFile,
    routerStatus: async () => {
      calls.push("status");
      if (statuses?.length) return statuses.shift();
      return { active_requests: 0, active_streams: 0, current_route: { account_alias: route } };
    },
    routerSwitch: async (alias) => {
      calls.push(`switch:${alias}`);
      route = alias;
      return { accepted: true, account_alias: alias };
    },
    stopAppServer: async () => { calls.push("stop"); },
    startAppServer: async () => { calls.push("start"); },
    appServerReady: async () => {
      calls.push("ready");
      return readiness?.length ? readiness.shift() : true;
    },
  });
  return { appServerCredentialFile, calls, rebinder };
}

test("rebinds the native credential and router route as one bounded new-session transaction", async (context) => {
  const { appServerCredentialFile, calls, rebinder } = await fixture(context);
  const result = await rebinder.switchToAlias("Secondary");
  assert.deepEqual(result, {
    event: "router_account_switched",
    configured_accounts: 2,
    account_alias: "Secondary",
    native_identity_rebound: true,
    web_restart_required: true,
  });
  assert.equal(await fs.readFile(appServerCredentialFile, "utf8"), secondary);
  assert.deepEqual(calls, [
    "status", "stop", "status", "switch:Secondary", "start", "ready",
  ]);
});

test("rejects switching before stopping the native App Server when any request is active", async (context) => {
  const { appServerCredentialFile, calls, rebinder } = await fixture(context, {
    statuses: [{ active_requests: 1, active_streams: 0, current_route: { account_alias: "Primary" } }],
  });
  await assert.rejects(rebinder.switchToAlias("Secondary"), /native account rebind failed/);
  assert.equal(await fs.readFile(appServerCredentialFile, "utf8"), primary);
  assert.deepEqual(calls, ["status"]);
});

test("closes the stop-to-switch race and restores the original native App Server", async (context) => {
  const { appServerCredentialFile, calls, rebinder } = await fixture(context, {
    statuses: [
      { active_requests: 0, active_streams: 0, current_route: { account_alias: "Primary" } },
      { active_requests: 1, active_streams: 0, current_route: { account_alias: "Primary" } },
    ],
  });
  await assert.rejects(rebinder.switchToAlias("Secondary"), /native account rebind failed/);
  assert.equal(await fs.readFile(appServerCredentialFile, "utf8"), primary);
  assert.deepEqual(calls, ["status", "stop", "status", "start", "ready"]);
});

test("rolls both route and native credential back if the target App Server is not ready", async (context) => {
  const { appServerCredentialFile, calls, rebinder } = await fixture(context, {
    readiness: [false, true],
  });
  await assert.rejects(rebinder.switchToAlias("Secondary"), /native account rebind failed/);
  assert.equal(await fs.readFile(appServerCredentialFile, "utf8"), primary);
  assert.deepEqual(calls, [
    "status", "stop", "status", "switch:Secondary", "start", "ready",
    "switch:Primary", "start", "ready",
  ]);
});

test("reconciles an automatic route change only after the router is idle", async (context) => {
  const { appServerCredentialFile, calls, rebinder } = await fixture(context, {
    statuses: [
      { active_requests: 0, active_streams: 0, current_route: { account_alias: "Secondary" } },
      { active_requests: 0, active_streams: 0, current_route: { account_alias: "Secondary" } },
    ],
  });
  const result = await rebinder.reconcileCurrentRoute();
  assert.equal(result.rebound, true);
  assert.equal(result.account_alias, "Secondary");
  assert.equal(await fs.readFile(appServerCredentialFile, "utf8"), secondary);
  assert.deepEqual(calls, ["status", "stop", "status", "start", "ready"]);
});
