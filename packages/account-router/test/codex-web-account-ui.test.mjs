import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyStatusBridge,
  EXPECTED_CODEX_WEB_REVISION,
} from "../../../integrations/codex-web/apply-status-bridge.mjs";

const codexWebRoot = process.env.M4_3_CODEX_WEB_ROOT ?? process.env.M4_2_CODEX_WEB_ROOT;
const integrationTest = codexWebRoot && path.isAbsolute(codexWebRoot) ? test : test.skip;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const packageDirectory = path.resolve(testDirectory, "..");
const workspaceRoot = path.resolve(packageDirectory, "../..");
const panelSource = path.join(
  workspaceRoot,
  "integrations/codex-web/src/browser/router-account-panel.ts",
);
const uiHarness = path.join(packageDirectory, "scripts/run-codex-web-account-ui.mjs");

function statusFixture({ activeStreams = 0, accounts, currentRoute = null } = {}) {
  return {
    status: "ready",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: activeStreams,
    current_route: currentRoute,
    accounts: accounts ?? [
      {
        alias: "Fixture A",
        state: "healthy",
        enabled: true,
        five_hour_remaining_ratio: 0.755,
        weekly_remaining_ratio: null,
        snapshot_observed_at: "2026-07-16T00:00:00.000Z",
        cooldown_until: null,
        last_switch_reason: "startup",
      },
      {
        alias: "Fixture B",
        state: "cooling_down",
        enabled: true,
        five_hour_remaining_ratio: 0.25,
        weekly_remaining_ratio: 0.5,
        snapshot_observed_at: "2026-07-16T00:00:00.000Z",
        cooldown_until: "2026-07-16T01:00:00.000Z",
        last_switch_reason: "rate_limited",
      },
    ],
  };
}

async function compilePanel(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "m4-3-panel-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  const build = spawnSync(
    process.execPath,
    [
      path.join(codexWebRoot, "node_modules", "typescript", "bin", "tsc"),
      panelSource,
      "--target", "ES2022",
      "--module", "ESNext",
      "--moduleResolution", "Bundler",
      "--lib", "ES2023,DOM",
      "--strict",
      "--skipLibCheck",
      "--rootDir", path.dirname(panelSource),
      "--outDir", directory,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  return import(pathToFileURL(path.join(directory, "router-account-panel.js")).href);
}

integrationTest("derives weekly-only quota display while ignoring the legacy five-hour field", async (context) => {
  const { deriveRouterAccountPanelModel } = await compilePanel(context);
  const status = statusFixture();
  status.accounts[0].credential_ref = "must-not-pass";
  status.accounts[0].token = "must-not-pass";
  status.accounts[0].five_hour_remaining_ratio = "legacy-value-is-ignored";
  delete status.accounts[1].five_hour_remaining_ratio;
  const model = deriveRouterAccountPanelModel(status);

  assert.equal(model.activeStreams, 0);
  assert.equal(model.allExhausted, false);
  assert.equal(model.accounts[0].alias, "Fixture A");
  assert.equal(Object.hasOwn(model.accounts[0], "fiveHourLabel"), false);
  assert.equal(model.accounts[0].weeklyLabel, "Unavailable");
  assert.equal(model.accounts[0].cooldownLabel, "None");
  assert.equal(model.accounts[0].lastSwitchLabel, "Startup");
  assert.equal(model.accounts[1].cooldownLabel, "Until 2026-07-16T01:00:00.000Z");
  assert.equal(model.accounts[1].lastSwitchLabel, "Rate limited");
  assert.doesNotMatch(JSON.stringify(model), /must-not-pass|credential_ref|token/i);
});

integrationTest("disables every manual switch while a semantic stream is active", async (context) => {
  const { buildManualSwitchRequest, deriveRouterAccountPanelModel } = await compilePanel(context);
  const model = deriveRouterAccountPanelModel(statusFixture({
    activeStreams: 1,
    currentRoute: { account_alias: "Fixture A", continuity: "new_backend_session" },
  }));

  assert.equal(model.banner, "Manual switching is unavailable while a response is streaming.");
  assert.equal(model.accounts.every((account) => account.switchDisabled), true);
  assert.equal(model.accounts[1].switchDisabledReason, "Active response in progress");
  assert.throws(
    () => buildManualSwitchRequest(model.accounts[1]),
    /manual switch is unavailable/,
  );
});

integrationTest("represents all enabled accounts exhausted explicitly", async (context) => {
  const { deriveRouterAccountPanelModel } = await compilePanel(context);
  const exhausted = ["Fixture A", "Fixture B"].map((alias) => ({
    alias,
    state: "quota_exhausted",
    enabled: true,
    five_hour_remaining_ratio: 0,
    weekly_remaining_ratio: 0,
    snapshot_observed_at: "2026-07-16T00:00:00.000Z",
    cooldown_until: null,
    last_switch_reason: "quota_exhausted",
  }));
  const model = deriveRouterAccountPanelModel(statusFixture({ accounts: exhausted }));

  assert.equal(model.allExhausted, true);
  assert.equal(model.banner, "All enabled accounts are quota exhausted.");
  assert.equal(model.accounts.every((account) => account.switchDisabled), true);
  assert.equal(model.accounts[0].switchDisabledReason, "Quota exhausted");
});

integrationTest("builds the exact manual switch request only at a safe fixture boundary", async (context) => {
  const { buildManualSwitchRequest, deriveRouterAccountPanelModel } = await compilePanel(context);
  const model = deriveRouterAccountPanelModel(statusFixture());
  assert.deepEqual(buildManualSwitchRequest(model.accounts[0]), {
    account_alias: "Fixture A",
    reason: "manual",
  });
  assert.doesNotMatch(JSON.stringify(buildManualSwitchRequest(model.accounts[0])), /session|token|credential/i);
});

integrationTest("pinned browser overlay bundles without writing to the upstream checkout", async (context) => {
  const revision = spawnSync("git", ["-C", codexWebRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(revision.status, 0);
  assert.equal(revision.stdout.trim(), EXPECTED_CODEX_WEB_REVISION);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "m4-3-browser-build-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const relativePath of [
    "package.json",
    "vite.browser.config.ts",
    "src/server/main.ts",
    "scratch/asar/package.json",
    "scratch/asar/.vite/build/preload.js",
  ]) {
    const destination = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(codexWebRoot, relativePath), destination);
  }
  await fs.cp(path.join(codexWebRoot, "src", "browser"), path.join(directory, "src", "browser"), {
    recursive: true,
  });
  await fs.mkdir(path.join(directory, "scratch", "asar", "webview"), { recursive: true });
  await fs.symlink(path.join(codexWebRoot, "node_modules"), path.join(directory, "node_modules"));
  await applyStatusBridge({ codexWebRoot: directory, revision: EXPECTED_CODEX_WEB_REVISION });

  const build = spawnSync(
    process.execPath,
    [path.join(codexWebRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--config", path.join(directory, "vite.browser.config.ts")],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const output = await fs.readFile(path.join(directory, "scratch", "asar", "webview", "assets", "preload.js"), "utf8");
  assert.match(output, /Router accounts/);
  assert.doesNotMatch(output, /5-hour quota|fiveHourLabel/);
  assert.match(output, /Cross-account continuity is not verified/);
  const trackedDiff = spawnSync("git", ["-C", codexWebRoot, "diff", "--quiet", "--exit-code"]);
  assert.equal(trackedDiff.status, 0);
});

test("browser fixture harness validates evidence paths before serving", () => {
  const result = spawnSync(process.execPath, [uiHarness], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /M4_3_CODEX_WEB_ROOT/);
  assert.doesNotMatch(result.stderr, /token|authorization|cookie/i);
});
