import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const deployScript = path.join(repositoryRoot, "evidence/M6.9/deploy-router-r69.sh");
const isolatedDeployScript = path.join(
  repositoryRoot,
  "evidence/M6.9/deploy-router-r85-isolated.sh",
);
const isolatedUnitRoot = path.join(repositoryRoot, "systemd/8216-fixture");
const overlayFiles = [
  "src/server/main.js", "src/server/module.js", "src/server/electron/index.js",
  "src/server/browser-ipc-router.js", "src/server/browser-session-auth.js",
  "src/server/browser-upload-store.js", "src/server/router-status-bridge.js",
  "scratch/asar/webview/index.html", "scratch/asar/webview/index.html.gz",
  "scratch/asar/webview/index.html.br",
  "scratch/asar/webview/assets/preload-d153ef5a.js",
  "scratch/asar/webview/assets/preload-d153ef5a.js.gz",
  "scratch/asar/webview/assets/preload-d153ef5a.js.br",
];
const isolatedOverlayFiles = [
  ...overlayFiles.filter(
    (relativePath) => relativePath !== "src/server/electron/index.js",
  ),
  "scratch/asar/webview/assets/app-initial-BTphDPeq.js",
  "scratch/asar/webview/assets/app-initial-BTphDPeq.js.gz",
  "scratch/asar/webview/assets/app-initial-BTphDPeq.js.br",
];

async function fixture(context, { healthy }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r69-deploy-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "opt/0xcaff-codex-web-router/releases/previous");
  const overlay = path.join(root, "overlay");
  await fs.mkdir(previous, { recursive: true });
  await fs.writeFile(path.join(previous, "sentinel"), "previous\n");
  for (const relativePath of overlayFiles) {
    const target = path.join(overlay, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${relativePath}\n`);
  }
  const archive = path.join(root, "overlay.tar.gz");
  const tar = spawnSync("tar", ["-czf", archive, ...overlayFiles], { cwd: overlay });
  assert.equal(tar.status, 0);
  const archiveHash = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  const prefix = path.join(root, "opt/0xcaff-codex-web-router");
  await fs.symlink("releases/previous", path.join(prefix, "current"));
  for (const relativePath of [
    "etc/systemd/system/codex-web-router.service",
    "etc/systemd/system/codex-web-router-app-server.service",
    "etc/tmpfiles.d/codex-stack.conf",
  ]) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `legacy:${relativePath}\n`);
  }
  const commandLog = path.join(root, "commands.log");
  const systemctl = path.join(root, "systemctl");
  const tmpfiles = path.join(root, "systemd-tmpfiles");
  await fs.writeFile(systemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$M69_COMMAND_LOG"\n');
  await fs.writeFile(tmpfiles, '#!/bin/sh\nprintf "tmpfiles %s\\n" "$*" >> "$M69_COMMAND_LOG"\n');
  await fs.chmod(systemctl, 0o755);
  await fs.chmod(tmpfiles, 0o755);
  if (healthy) await fs.writeFile(path.join(root, "probe-ok"), "ok\n");
  return { root, archive, archiveHash, commandLog, systemctl, tmpfiles };
}

function deploy(value) {
  return spawnSync("bash", [deployScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      M69_FIXTURE_ROOT: value.root,
      M69_ARCHIVE: value.archive,
      M69_ARCHIVE_SHA256: value.archiveHash,
      M69_SYSTEMCTL: value.systemctl,
      M69_TMPFILES: value.tmpfiles,
      M69_COMMAND_LOG: value.commandLog,
      M69_READY_ATTEMPTS: "2",
      M69_READY_SLEEP_SECONDS: "0",
    },
  });
}

async function isolatedFixture(context, { healthy }) {
  const value = await fixture(context, { healthy });
  for (const relativePath of isolatedOverlayFiles) {
    const target = path.join(value.root, "overlay", relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${relativePath}\n`);
  }
  const previousElectron = path.join(
    value.root,
    "opt/0xcaff-codex-web-router/releases/previous/src/server/electron/index.js",
  );
  await fs.mkdir(path.dirname(previousElectron), { recursive: true });
  await fs.writeFile(previousElectron, "stable predecessor electron shim\n");
  const isolatedTar = spawnSync("tar", ["-czf", value.archive, ...isolatedOverlayFiles], {
    cwd: path.join(value.root, "overlay"),
  });
  assert.equal(isolatedTar.status, 0);
  const isolatedArchiveHash = createHash("sha256")
    .update(await fs.readFile(value.archive))
    .digest("hex");
  const unitRoot = path.join(value.root, "etc/systemd/system");
  const routerRelease = path.join(
    value.root,
    "opt/codex-account-router/releases/codex-account-router-0.2.6-linux-x64",
  );
  await fs.mkdir(routerRelease, { recursive: true });
  await fs.symlink("releases/codex-account-router-0.2.6-linux-x64", path.join(
    value.root,
    "opt/codex-account-router/current",
  ));

  const accountUnit = path.join(unitRoot, "codex-account-router.service");
  await fs.writeFile(accountUnit, "fixture account unit\n");
  const isolationFiles = {
    web: path.join(unitRoot, "codex-web-router.service.d/8216-isolation.conf"),
    app: path.join(unitRoot, "codex-web-router-app-server.service.d/8216-isolation.conf"),
    account: path.join(unitRoot, "codex-account-router.service.d/8216-isolation.conf"),
  };
  for (const [name, target] of Object.entries(isolationFiles)) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture ${name} isolation\n`);
  }
  await fs.writeFile(
    value.systemctl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$M69_COMMAND_LOG"',
      'case "$1" in',
      '  show) [ "$3" = NeedDaemonReload ] && printf "no\\n" ;;',
      '  is-active) printf "active\\n" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  return {
    ...value,
    archiveHash: isolatedArchiveHash,
    accountUnit,
    isolationFiles,
    hashes: {
      oldWeb: createHash("sha256").update(await fs.readFile(path.join(unitRoot, "codex-web-router.service"))).digest("hex"),
      oldApp: createHash("sha256").update(await fs.readFile(path.join(unitRoot, "codex-web-router-app-server.service"))).digest("hex"),
      account: createHash("sha256").update(await fs.readFile(accountUnit)).digest("hex"),
      webIsolation: createHash("sha256").update(await fs.readFile(isolationFiles.web)).digest("hex"),
      appIsolation: createHash("sha256").update(await fs.readFile(isolationFiles.app)).digest("hex"),
      accountIsolation: createHash("sha256").update(await fs.readFile(isolationFiles.account)).digest("hex"),
      previousElectron: createHash("sha256").update(await fs.readFile(previousElectron)).digest("hex"),
    },
  };
}

function deployIsolated(value) {
  return spawnSync("bash", [isolatedDeployScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      M69_COMMAND_LOG: value.commandLog,
      R85_FIXTURE_ROOT: value.root,
      R85_ARCHIVE: value.archive,
      R85_ARCHIVE_SHA256: value.archiveHash,
      R85_SYSTEMCTL: value.systemctl,
      R85_OLD_WEB_UNIT_SHA256: value.hashes.oldWeb,
      R85_OLD_APP_UNIT_SHA256: value.hashes.oldApp,
      R85_ACCOUNT_UNIT_SHA256: value.hashes.account,
      R85_WEB_ISOLATION_SHA256: value.hashes.webIsolation,
      R85_APP_ISOLATION_SHA256: value.hashes.appIsolation,
      R85_ACCOUNT_ISOLATION_SHA256: value.hashes.accountIsolation,
      R85_PREVIOUS_ELECTRON_SHA256: value.hashes.previousElectron,
      R85_READY_ATTEMPTS: "2",
      R85_READY_SLEEP_SECONDS: "0",
    },
  });
}

test("host deployment script pins the approved baseline and forbids unrelated service mutations", async () => {
  const source = await fs.readFile(deployScript, "utf8");
  assert.match(source, /STANDALONE_WEB_PID=1336830/);
  assert.match(source, /STANDALONE_APP_PID=1336828/);
  assert.match(source, /PRODUCTION_ARCHIVE_SHA256=6a8060aa/);
  assert.doesNotMatch(source, /(?:restart|stop|start) codex-web-upstream/);
  assert.doesNotMatch(source, /(?:restart|stop|start) codex-account-router/);
  assert.doesNotMatch(source, /\/opt\/0xcaff-codex-web(?:\/|\s|$)/);
});

test("isolated deployment updates only 8216 base units and preserves migration drop-ins", async () => {
  const source = await fs.readFile(isolatedDeployScript, "utf8");
  assert.match(source, /STANDALONE_WEB_PID=3522733/);
  assert.match(source, /STANDALONE_APP_PID=3522725/);
  assert.match(source, /PRODUCTION_ARCHIVE_SHA256=2fd59e23/);
  assert.match(source, /PREVIOUS_ELECTRON_SHA256=51e9a0bc/);
  assert.match(source, /8216-isolation\.conf/);
  assert.match(source, /NeedDaemonReload/);
  assert.match(source, /daemon-reload/);
  assert.match(source, /Accept: text\/html/);
  assert.doesNotMatch(source, /install[^\n]+8216-isolation\.conf/);
  assert.doesNotMatch(source, /(?:restart|stop|start) codex-web-upstream/);
  assert.doesNotMatch(source, /\/opt\/0xcaff-codex-web(?:\/|\s|$)/);
});

test("isolated candidate units retain Tailnet, upload, router-status, and workspace boundaries", async () => {
  const [web, app] = await Promise.all([
    fs.readFile(path.join(isolatedUnitRoot, "codex-web-router.service"), "utf8"),
    fs.readFile(path.join(isolatedUnitRoot, "codex-web-router-app-server.service"), "utf8"),
  ]);
  for (const content of [web, app]) {
    assert.match(content, /^User=codex8216$/m);
    assert.match(content, /^Group=codex8216$/m);
    assert.match(content, /^Slice=codex-8216\.slice$/m);
    assert.match(
      content,
      /^WorkingDirectory=\/srv\/codex-workspaces\/CodexWebManager-8216-fixture$/m,
    );
    assert.match(content, /^InaccessiblePaths=\/srv\/codex-workspaces\/CodexWebManager$/m);
  }
  for (const setting of [
    "CODEX_ROUTER_ADMIN_ORIGIN=http://127.0.0.1:18318",
    "CODEX_ROUTER_ADMIN_TOKEN_FILE=%d/router-admin-token",
    "CODEX_WEB_PUBLIC_ORIGIN=http://100.95.50.98:8216",
    "CODEX_WEB_TRUSTED_TAILNET_ACCESS=1",
    "CODEX_WEB_CODEX_HOME=/var/lib/codex-web-router-app-server",
    "CODEX_WEB_WORKSPACE_ROOTS=/srv/codex-workspaces/CodexWebManager-8216-fixture",
    "CODEX_WEB_UPLOAD_ROOT=/run/codex-web-router-browser-uploads",
  ]) {
    assert.ok(web.includes(setting), setting);
  }
  assert.match(web, /^StandardOutput=null$/m);
  assert.match(
    web,
    /^RuntimeDirectory=codex-web-router codex-web-router-browser-uploads$/m,
  );
  assert.match(web, /^RuntimeDirectoryPreserve=restart$/m);
  assert.match(
    app,
    /^RuntimeDirectory=codex-web-router-app-server codex-web-router-browser-uploads$/m,
  );
  assert.match(app, /^RuntimeDirectoryPreserve=restart$/m);
  assert.match(app, /^ReadOnlyPaths=\/run\/codex-web-router-browser-uploads$/m);
  assert.doesNotMatch(
    `${web}\n${app}`,
    /0\.0\.0\.0|\[::\]|(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/i,
  );
});

test("activates only the routed Web successor in an isolated host fixture", async (context) => {
  const value = await fixture(context, { healthy: true });
  const result = deploy(value);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await fs.readlink(path.join(value.root, "opt/0xcaff-codex-web-router/current")), /router-r69$/);
  assert.equal(await fs.readFile(path.join(value.root, "opt/0xcaff-codex-web-router/releases/previous/sentinel"), "utf8"), "previous\n");
  const log = await fs.readFile(value.commandLog, "utf8");
  assert.match(log, /restart codex-web-router-app-server\.service/);
  assert.match(log, /restart codex-web-router\.service/);
  assert.doesNotMatch(log, /restart .*8215|restart codex-web-upstream|restart codex-account-router/);
});

test("restores units and current when the isolated 8216 probe fails", async (context) => {
  const value = await fixture(context, { healthy: false });
  const legacy = await fs.readFile(path.join(value.root, "etc/systemd/system/codex-web-router.service"));
  const result = deploy(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /deployment_status=rolled_back/);
  assert.equal(await fs.readlink(path.join(value.root, "opt/0xcaff-codex-web-router/current")), "releases/previous");
  assert.deepEqual(await fs.readFile(path.join(value.root, "etc/systemd/system/codex-web-router.service")), legacy);
  assert.match(await fs.readFile(value.commandLog, "utf8"), /restart codex-web-router\.service/);
  await assert.rejects(fs.access(path.join(value.root, "opt/0xcaff-codex-web-router/releases/c3e92f0f-20260801-m69-router-r69")));
});

test("isolated deployment activates the routed Web candidate and restarts only the 8216 stack", async (context) => {
  const value = await isolatedFixture(context, { healthy: true });
  const isolationBefore = await Promise.all(
    Object.values(value.isolationFiles).map((file) => fs.readFile(file)),
  );
  const result = deployIsolated(value);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deployment_status=success/);
  assert.match(
    await fs.readlink(path.join(value.root, "opt/0xcaff-codex-web-router/current")),
    /router-r85$/,
  );
  assert.equal(
    await fs.readFile(
      path.join(value.root, "opt/0xcaff-codex-web-router/current/src/server/electron/index.js"),
      "utf8",
    ),
    "stable predecessor electron shim\n",
  );
  const log = await fs.readFile(value.commandLog, "utf8");
  assert.match(log, /daemon-reload/);
  assert.match(log, /restart codex-account-router\.service/);
  assert.match(log, /restart codex-web-router-app-server\.service/);
  assert.match(log, /restart codex-web-router\.service/);
  assert.doesNotMatch(log, /(?:restart|stop|start) codex-web-upstream/);
  assert.equal(
    await fs.readlink(path.join(value.root, "opt/codex-account-router/current")),
    "releases/codex-account-router-0.2.6-linux-x64",
  );
  assert.deepEqual(
    await Promise.all(Object.values(value.isolationFiles).map((file) => fs.readFile(file))),
    isolationBefore,
  );
});

test("isolated deployment restores both base units and its predecessor after a failed probe", async (context) => {
  const value = await isolatedFixture(context, { healthy: false });
  const unitRoot = path.join(value.root, "etc/systemd/system");
  const webBefore = await fs.readFile(path.join(unitRoot, "codex-web-router.service"));
  const appBefore = await fs.readFile(path.join(unitRoot, "codex-web-router-app-server.service"));
  const result = deployIsolated(value);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /deployment_status=rolled_back/);
  assert.equal(
    await fs.realpath(path.join(value.root, "opt/0xcaff-codex-web-router/current")),
    path.join(value.root, "opt/0xcaff-codex-web-router/releases/previous"),
  );
  assert.deepEqual(await fs.readFile(path.join(unitRoot, "codex-web-router.service")), webBefore);
  assert.deepEqual(await fs.readFile(path.join(unitRoot, "codex-web-router-app-server.service")), appBefore);
  await assert.rejects(fs.access(path.join(
    value.root,
    "opt/0xcaff-codex-web-router/releases/c3e92f0f-20260801-m69-router-r85",
  )));
});
