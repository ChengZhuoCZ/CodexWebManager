import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const deployScript = path.join(repositoryRoot, "evidence/M6.9/deploy-router-r69.sh");
const overlayFiles = [
  "src/server/main.js", "src/server/module.js", "src/server/electron/index.js",
  "src/server/browser-ipc-router.js", "src/server/browser-session-auth.js",
  "src/server/browser-upload-store.js", "src/server/router-status-bridge.js",
  "scratch/asar/webview/index.html", "scratch/asar/webview/index.html.gz",
  "scratch/asar/webview/index.html.br",
  "scratch/asar/webview/assets/preload-343f16dc.js",
  "scratch/asar/webview/assets/preload-343f16dc.js.gz",
  "scratch/asar/webview/assets/preload-343f16dc.js.br",
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

test("host deployment script pins the approved baseline and forbids unrelated service mutations", async () => {
  const source = await fs.readFile(deployScript, "utf8");
  assert.match(source, /STANDALONE_WEB_PID=1336830/);
  assert.match(source, /STANDALONE_APP_PID=1336828/);
  assert.match(source, /PRODUCTION_ARCHIVE_SHA256=861d5229/);
  assert.doesNotMatch(source, /(?:restart|stop|start) codex-web-upstream/);
  assert.doesNotMatch(source, /(?:restart|stop|start) codex-account-router/);
  assert.doesNotMatch(source, /\/opt\/0xcaff-codex-web(?:\/|\s|$)/);
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
