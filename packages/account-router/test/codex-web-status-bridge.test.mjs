import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  applyStatusBridge,
  EXPECTED_CODEX_WEB_REVISION,
  prepareBrowserIndexForRuntime,
  replaceFilesRecoverably,
} from "../../../integrations/codex-web/apply-status-bridge.mjs";

const ADMIN_TOKEN = "fixture-admin-token-0123456789";
const codexWebRoot = process.env.M4_2_CODEX_WEB_ROOT;
const integrationTest = codexWebRoot && path.isAbsolute(codexWebRoot) ? test : test.skip;

test("runtime index preparation accepts one staged preload without re-versioning", () => {
  const staged = [
    "<style>:root { --startup-background: rgb(248 248 248); }</style>",
    '<script type="module" src="./assets/preload-d153ef5a.js"></script>',
  ].join("\n");
  const prepared = prepareBrowserIndexForRuntime(staged);
  assert.match(prepared, /<script src="\/__backend\/startup-probe\.js"><\/script>/u);
  assert.ok(
    prepared.indexOf("/__backend/startup-probe.js") <
      prepared.indexOf("./assets/preload-d153ef5a.js"),
  );
  assert.equal(
    prepared.match(/\/__backend\/startup-probe\.js/gu)?.length,
    1,
  );
});

test("runtime index preparation versions the pinned build input once", () => {
  const buildInput = [
    "<style>:root { --startup-background: transparent; }</style>",
    '<script type="module" src="./assets/preload.js"></script>',
  ].join("\n");
  const prepared = prepareBrowserIndexForRuntime(buildInput);
  assert.match(prepared, /<script src="\/__backend\/startup-probe\.js"><\/script>/u);
  assert.ok(
    prepared.indexOf("/__backend/startup-probe.js") <
      prepared.indexOf("./assets/preload.js?v=m6-8-startup-chat-r8"),
  );
  assert.match(prepared, /preload\.js\?v=m6-8-startup-chat-r8/);
  assert.match(prepared, /--startup-background: Canvas;/);
  assert.doesNotMatch(prepared, /--startup-background: transparent;/);
});

test("runtime index preparation rejects an already-injected startup probe", () => {
  const duplicate = [
    "<style>:root { --startup-background: rgb(248 248 248); }</style>",
    '<script src="/__backend/startup-probe.js"></script>',
    '<script type="module" src="./assets/preload-d153ef5a.js"></script>',
  ].join("\n");
  assert.throws(
    () => prepareBrowserIndexForRuntime(duplicate),
    /browser startup probe anchor is unavailable/,
  );
});

test("runtime index preparation remains fail-closed for ambiguous staged preload", () => {
  const ambiguous = [
    "<style>:root { --startup-background: rgb(248 248 248); }</style>",
    '<script type="module" src="./assets/preload-d153ef5a.js"></script>',
    '<script type="module" src="./assets/preload-deadbeef.js"></script>',
  ].join("\n");
  assert.throws(
    () => prepareBrowserIndexForRuntime(ambiguous),
    /browser preload anchor is unavailable/,
  );
});

test("patch file transaction restores every installed file after a later failure", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "m6-3-patch-transaction-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const targets = ["main.ts", "shim.ts", "files.ts"].map((name) =>
    path.join(directory, name)
  );
  await Promise.all(
    targets.map((target, index) =>
      fs.writeFile(target, `original-${index}`, { mode: 0o640 })
    ),
  );
  const entries = targets.map((target, index) => ({
    target,
    original: `original-${index}`,
    replacement: `replacement-${index}`,
  }));

  await assert.rejects(
    replaceFilesRecoverably(entries, {
      beforeInstall({ index }) {
        if (index === 1) {
          throw new Error("fixture install failure");
        }
      },
    }),
    /fixture install failure/,
  );
  assert.deepEqual(
    await Promise.all(targets.map((target) => fs.readFile(target, "utf8"))),
    ["original-0", "original-1", "original-2"],
  );
  assert.equal(
    (await fs.readdir(directory)).some((name) => name.includes(".codex-patch-")),
    false,
  );

  await replaceFilesRecoverably(entries);
  assert.deepEqual(
    await Promise.all(targets.map((target) => fs.readFile(target, "utf8"))),
    ["replacement-0", "replacement-1", "replacement-2"],
  );
  assert.deepEqual(
    await Promise.all(
      targets.map(async (target) => (await fs.stat(target)).mode & 0o777),
    ),
    [0o640, 0o640, 0o640],
  );
});

function safeStatus() {
  return {
    status: "ready",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: 0,
    current_route: null,
    accounts: [
      {
        alias: "Fixture A",
        state: "healthy",
        enabled: true,
        five_hour_remaining_ratio: 0.5,
        weekly_remaining_ratio: 0.25,
        snapshot_observed_at: "2026-07-16T00:00:00.000Z",
        cooldown_until: null,
        last_switch_reason: "startup",
        credential_ref: "must-not-pass",
      },
    ],
    authorization: "must-not-pass",
  };
}

async function preparePatchedServer(context) {
  assert.ok(codexWebRoot && path.isAbsolute(codexWebRoot), "M4_2_CODEX_WEB_ROOT is required");
  const revision = spawnSync("git", ["-C", codexWebRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  assert.equal(revision.status, 0);
  assert.equal(revision.stdout.trim(), EXPECTED_CODEX_WEB_REVISION);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m4-2-codex-web-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporaryRoot, "src", "server"), { recursive: true });
  for (const relativePath of [
    "package.json",
    "src/browser/files.ts",
    "src/browser/shim.ts",
    "src/server/main.ts",
    "src/server/module.ts",
    "src/server/tsconfig.json",
  ]) {
    const destination = path.join(temporaryRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(codexWebRoot, relativePath), destination);
  }
  await fs.symlink(path.join(codexWebRoot, "node_modules"), path.join(temporaryRoot, "node_modules"));
  await applyStatusBridge({
    codexWebRoot: temporaryRoot,
    revision: EXPECTED_CODEX_WEB_REVISION,
  });
  const harness = `
import Fastify from "fastify";
import { registerRouterStatusBridge } from "./router-status-bridge";
async function main() {
  const app = Fastify({ logger: false });
  app.get("/single-account-health", async () => ({ status: "unchanged" }));
  await registerRouterStatusBridge(app, process.env);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  process.stdout.write(JSON.stringify({ origin }) + "\\n");
  const stop = async () => { await app.close(); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
main().catch(() => { process.stderr.write("fixture bridge failed\\n"); process.exit(1); });
`;
  await fs.writeFile(path.join(temporaryRoot, "src", "server", "bridge-harness.ts"), harness);
  const build = spawnSync(
    process.execPath,
    [path.join(codexWebRoot, "node_modules", "typescript", "bin", "tsc")],
    { cwd: path.join(temporaryRoot, "src", "server"), encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const patchedMain = await fs.readFile(path.join(temporaryRoot, "src", "server", "main.ts"), "utf8");
  assert.match(patchedMain, /registerRouterStatusBridge/);
  assert.match(patchedMain, /registerRouterAccountManagement/);
  assert.match(patchedMain, /BrowserUploadStore\.create/);
  assert.match(patchedMain, /browserSessionAuth\.onSessionRevoked/);
  assert.match(patchedMain, /preload\.js\?v=m6-8-startup-chat-r8/);
  assert.match(
    patchedMain,
    /versionedPreloads[\s\S]*unversionedCount[\s\S]*versionedPreloads\.length === 1/,
  );
  assert.match(
    patchedMain,
    /transparentBackground[\s\S]*stagedBackground[\s\S]*canvasBackground/,
  );
  assert.match(
    patchedMain,
    /root: path\.resolve\(__dirname, "\.\.\/\.\.\/scratch\/asar\/webview"\),[\s\S]*preCompressed: true,[\s\S]*maxAge: "1y",[\s\S]*immutable: true/,
  );
  assert.equal(
    (patchedMain.match(/return sendBrowserIndex\(reply\);/gu) ?? []).length,
    2,
  );
  assert.doesNotMatch(patchedMain, /\.toBuffer\(\)|codex-web-uploads-/);
  const patchedShim = await fs.readFile(path.join(temporaryRoot, "src", "browser", "shim.ts"), "utf8");
  assert.match(patchedShim, /installRouterAccountPanel/);
  assert.match(
    patchedShim,
    /import \{ installBrowserFetchPolicy \} from "\.\/browser-session";[\s\S]*installBrowserFetchPolicy\(\);/,
  );
  assert.match(
    patchedShim,
    /addEventListener\("open"[\s\S]*announceRendererReady\(\);[\s\S]*announceViewReady\(\);[\s\S]*flushOutboundQueue\(\);/,
  );
  assert.doesNotMatch(patchedShim, /rendererReady/);
  assert.match(
    patchedShim,
    /function announceRendererReady\(\)[\s\S]*ipc-renderer-ready[\s\S]*function announceViewReady\(\)[\s\S]*message-from-view[\s\S]*args: \[\{ type: "ready" \}\][\s\S]*function rejectPendingForSocket/,
  );
  assert.match(
    patchedShim,
    /let viewReady = false;[\s\S]*let viewReadyAnnouncedSocket: WebSocket \| null = null;/,
  );
  assert.match(
    patchedShim,
    /addEventListener\("close"[\s\S]*viewReadyAnnouncedSocket === nextSocket[\s\S]*viewReadyAnnouncedSocket = null;[\s\S]*rejectPendingForSocket/,
  );
  assert.doesNotMatch(
    patchedShim,
    /addEventListener\("close"[\s\S]*viewReady = false;[\s\S]*scheduleReconnect/,
  );
  assert.match(
    patchedShim,
    /message\.type === "ready"[\s\S]*viewReady = true;[\s\S]*announceViewReady\(\);[\s\S]*return undefined;[\s\S]*return invokeMain\(channel, args\);/,
  );
  assert.match(
    patchedShim,
    /LOCAL_DISABLED_INVOKE_CHANNELS\.has\(channel\)[\s\S]*channel unavailable in browser mode/,
  );
  const disabledInvokeChannels =
    /LOCAL_DISABLED_INVOKE_CHANNELS = new Set\(\[([\s\S]*?)\]\);/u.exec(
      patchedShim,
    )?.[1];
  assert.equal(typeof disabledInvokeChannels, "string");
  assert.match(disabledInvokeChannels, /codex_desktop:connect-app-host/u);
  assert.doesNotMatch(
    disabledInvokeChannels,
    /codex_desktop:worker:git:from-view/u,
  );
  assert.match(
    patchedShim,
    /SERVER_GIT_INVOKE_CHANNEL[\s\S]*channel === SERVER_GIT_INVOKE_CHANNEL[\s\S]*return invokeMain\(channel, args\)/,
  );
  assert.match(
    patchedShim,
    /case "local-mcp-response":[\s\S]*type: "mcp-response"[\s\S]*result: disposition\.result/,
  );
  assert.match(
    patchedShim,
    /LOCAL_NOOP_INVOKE_CHANNELS\.has\(channel\)[\s\S]*Promise\.resolve\(undefined\)/,
  );
  assert.match(patchedShim, /responseType: "success"/);
  assert.match(patchedShim, /bodyJsonString: JSON\.stringify\(body\)/);
  assert.match(patchedShim, /worktreesSegment:/);
  assert.match(patchedShim, /canonicalPathByRoot:/);
  await fs.access(path.join(temporaryRoot, "src", "browser", "router-account-panel.ts"));
  await fs.access(path.join(temporaryRoot, "src", "browser", "browser-session.ts"));
  await fs.access(path.join(temporaryRoot, "src", "browser", "browser-message-policy.ts"));
  await fs.access(path.join(temporaryRoot, "src", "server", "browser-ipc-router.ts"));
  await fs.access(path.join(temporaryRoot, "src", "server", "router-account-management.ts"));
  await fs.access(path.join(temporaryRoot, "src", "server", "browser-session-auth.ts"));
  await fs.access(path.join(temporaryRoot, "src", "server", "browser-upload-store.ts"));
  return {
    temporaryRoot,
    harness: path.join(temporaryRoot, "src", "server", "bridge-harness.js"),
  };
}

integrationTest("browser upload store streams into a private shared root and cleans session files", async (context) => {
  const prepared = await preparePatchedServer(context);
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m6-3-shared-uploads-"));
  context.after(() => fs.rm(sharedRoot, { recursive: true, force: true }));
  await fs.chmod(sharedRoot, 0o700);
  const {
    BROWSER_UPLOAD_LIMITS,
    BrowserUploadStore,
    isBrowserUploadLimitError,
  } = await import(
    pathToFileURL(
      path.join(
        prepared.temporaryRoot,
        "src",
        "server",
        "browser-upload-store.js",
      ),
    ).href
  );
  const staleInstance = path.join(sharedRoot, "codex-web-Ab12Cd");
  await fs.mkdir(staleInstance, { mode: 0o700 });
  await fs.writeFile(path.join(staleInstance, "stale"), "fixture", {
    mode: 0o600,
  });
  const store = await BrowserUploadStore.create({
    CODEX_WEB_UPLOAD_ROOT: sharedRoot,
  });
  context.after(() => store.close());
  await assert.rejects(fs.stat(staleInstance), { code: "ENOENT" });
  const canonicalSharedRoot = await fs.realpath(sharedRoot);

  const first = await store.write(
    "session-a",
    Readable.from([Buffer.from("fixture")]),
    "text/plain",
    BROWSER_UPLOAD_LIMITS.requestBytes,
  );
  assert.match(
    first.path,
    new RegExp(
      `^${canonicalSharedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    ),
  );
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  assert.equal(store.find(first.path, "session-a")?.size, 7);
  assert.equal(store.find(first.path, "session-b"), null);

  await assert.rejects(
    store.write(
      "session-a",
      Readable.from([Buffer.from("four")]),
      "text/plain",
      3,
    ),
    (error) => isBrowserUploadLimitError(error),
  );
  const afterPartialFailure = await fs.readdir(path.dirname(first.path));
  assert.equal(afterPartialFailure.some((entry) => entry.endsWith(".part")), false);

  await store.removeSession("session-a");
  await assert.rejects(fs.stat(first.path), { code: "ENOENT" });
  assert.equal(store.find(first.path, "session-a"), null);

  let releaseUpload;
  let markStarted;
  const uploadStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const inFlight = store.write(
    "session-revoked",
    Readable.from(
      (async function* () {
        yield Buffer.from("before-revoke");
        markStarted();
        await uploadGate;
        yield Buffer.from("after-revoke");
      })(),
    ),
    "text/plain",
    BROWSER_UPLOAD_LIMITS.requestBytes,
  );
  await uploadStarted;
  await store.removeSession("session-revoked");
  releaseUpload();
  await assert.rejects(inFlight, /upload|aborted|session/i);
  assert.deepEqual(await fs.readdir(store.root), []);
});

integrationTest("browser upload store preserves opted-in persistent files across session revocation and restart", async (context) => {
  const prepared = await preparePatchedServer(context);
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m6-9-persistent-uploads-"));
  context.after(() => fs.rm(sharedRoot, { recursive: true, force: true }));
  await fs.chmod(sharedRoot, 0o700);
  const { BROWSER_UPLOAD_LIMITS, BrowserUploadStore } = await import(
    pathToFileURL(
      path.join(
        prepared.temporaryRoot,
        "src",
        "server",
        "browser-upload-store.js",
      ),
    ).href
  );
  const environment = {
    CODEX_WEB_UPLOAD_ROOT: sharedRoot,
    CODEX_WEB_UPLOAD_PERSIST: "1",
  };
  const firstStore = await BrowserUploadStore.create(environment);
  assert.equal(firstStore.root, await fs.realpath(sharedRoot));
  const upload = await firstStore.write(
    "session-a",
    Readable.from([Buffer.from("persistent fixture")]),
    "text/plain",
    BROWSER_UPLOAD_LIMITS.requestBytes,
  );
  assert.equal(path.dirname(upload.path), await fs.realpath(sharedRoot));
  await firstStore.removeSession("session-a");
  assert.equal(await fs.readFile(upload.path, "utf8"), "persistent fixture");
  assert.equal(firstStore.find(upload.path, "session-a"), null);
  await firstStore.close();
  assert.equal(await fs.readFile(upload.path, "utf8"), "persistent fixture");

  const secondStore = await BrowserUploadStore.create(environment);
  await secondStore.close();
  assert.equal(await fs.readFile(upload.path, "utf8"), "persistent fixture");
});

integrationTest("browser upload store fails closed on unsafe stale instance directories", async (context) => {
  const prepared = await preparePatchedServer(context);
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m6-3-unsafe-stale-"));
  context.after(() => fs.rm(sharedRoot, { recursive: true, force: true }));
  await fs.chmod(sharedRoot, 0o700);
  const unsafeStale = path.join(sharedRoot, "codex-web-Zz99Yy");
  await fs.mkdir(unsafeStale, { mode: 0o755 });
  const { BrowserUploadStore } = await import(
    pathToFileURL(
      path.join(
        prepared.temporaryRoot,
        "src",
        "server",
        "browser-upload-store.js",
      ),
    ).href
  );
  await assert.rejects(
    BrowserUploadStore.create({ CODEX_WEB_UPLOAD_ROOT: sharedRoot }),
    /unsafe stale entry/,
  );
});

integrationTest("browser upload store enforces per-session and global file ceilings", async (context) => {
  const prepared = await preparePatchedServer(context);
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m6-3-upload-limits-"));
  context.after(() => fs.rm(sharedRoot, { recursive: true, force: true }));
  await fs.chmod(sharedRoot, 0o700);
  const {
    BROWSER_UPLOAD_LIMITS,
    BrowserUploadStore,
    isBrowserUploadLimitError,
  } = await import(
    pathToFileURL(
      path.join(
        prepared.temporaryRoot,
        "src",
        "server",
        "browser-upload-store.js",
      ),
    ).href
  );
  const store = await BrowserUploadStore.create({
    CODEX_WEB_UPLOAD_ROOT: sharedRoot,
  });
  context.after(() => store.close());
  const writeTiny = (sessionId) =>
    store.write(
      sessionId,
      Readable.from([Buffer.from(".")]),
      "text/plain",
      BROWSER_UPLOAD_LIMITS.requestBytes,
    );

  for (let index = 0; index < BROWSER_UPLOAD_LIMITS.sessionFiles; index += 1) {
    await writeTiny("bounded-session");
  }
  await assert.rejects(
    writeTiny("bounded-session"),
    (error) => isBrowserUploadLimitError(error),
  );
  await store.removeSession("bounded-session");

  for (let index = 0; index < BROWSER_UPLOAD_LIMITS.globalFiles; index += 1) {
    await writeTiny(`global-${index % 8}`);
  }
  await assert.rejects(
    writeTiny("global-overflow"),
    (error) => isBrowserUploadLimitError(error),
  );
});

function startHarness(context, harness, cwd, environment = {}) {
  const child = spawn(process.execPath, [harness], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exit;
    }
  });
  const origin = new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const boundary = stdout.indexOf("\n");
      if (boundary === -1) return;
      try {
        resolve(JSON.parse(stdout.slice(0, boundary)).origin);
      } catch {
        reject(new Error("fixture bridge readiness was invalid"));
      }
    });
    exit.then(({ code }) => reject(new Error(`fixture bridge exited ${code}: ${stderr}`)));
  });
  return { child, exit, origin };
}

integrationTest("pinned codex-web overlay builds and remains disabled without router configuration", async (context) => {
  const prepared = await preparePatchedServer(context);
  const fixture = startHarness(context, prepared.harness, prepared.temporaryRoot);
  const origin = await fixture.origin;
  const standard = await fetch(`${origin}/single-account-health`);
  assert.equal(standard.status, 200);
  assert.deepEqual(await standard.json(), { status: "unchanged" });
  const status = await fetch(`${origin}/__backend/codex-router/status`);
  assert.equal(status.status, 404);
  assert.deepEqual(await status.json(), { enabled: false });
  const events = await fetch(`${origin}/__backend/codex-router/events`);
  assert.equal(events.status, 404);
  assert.deepEqual(await events.json(), { enabled: false });
  const manualSwitch = await fetch(`${origin}/__backend/codex-router/switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_alias: "Fixture A", reason: "manual" }),
  });
  assert.equal(manualSwitch.status, 404);
  assert.deepEqual(await manualSwitch.json(), { enabled: false });
});

integrationTest("same-origin bridge exposes only sanitized status and switch events", async (context) => {
  const prepared = await preparePatchedServer(context);
  const tokenDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "m4-2-admin-token-"));
  context.after(() => fs.rm(tokenDirectory, { recursive: true, force: true }));
  await fs.chmod(tokenDirectory, 0o700);
  const tokenFile = path.join(tokenDirectory, "admin-token");
  await fs.writeFile(tokenFile, ADMIN_TOKEN, { mode: 0o600 });
  await fs.chmod(tokenFile, 0o600);
  const observed = [];
  const admin = http.createServer(async (request, response) => {
    const observation = {
      path: request.url,
      authorizationMatches: request.headers.authorization === `Bearer ${ADMIN_TOKEN}`,
      cursor: request.headers["last-event-id"] ?? null,
    };
    observed.push(observation);
    if (request.url === "/v1/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(safeStatus()));
      return;
    }
    if (request.url === "/v1/events") {
      const data = {
        from_alias: null,
        to_alias: "Fixture A",
        reason: "manual",
        continuity: "new_backend_session",
        architecture_mode: "LIMITED_MODE",
        timestamp: "2026-07-16T00:00:01.000Z",
        token: "must-not-pass",
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`id: 9\nevent: router.switch\ndata: ${JSON.stringify(data)}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    admin.once("error", reject);
    admin.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => admin.close(resolve)));
  const address = admin.address();
  assert.ok(address && typeof address !== "string");

  const fixture = startHarness(context, prepared.harness, prepared.temporaryRoot, {
    CODEX_ROUTER_ADMIN_ORIGIN: `http://127.0.0.1:${address.port}`,
    CODEX_ROUTER_ADMIN_TOKEN_FILE: tokenFile,
  });
  const origin = await fixture.origin;
  const status = await fetch(`${origin}/__backend/codex-router/status`);
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.router.accounts[0].alias, "Fixture A");
  assert.doesNotMatch(JSON.stringify(statusBody), /must-not-pass|credential_ref|authorization|token/i);

  const events = await fetch(`${origin}/__backend/codex-router/events`, {
    headers: { "last-event-id": "8" },
  });
  assert.equal(events.status, 200);
  const eventText = await events.text();
  assert.match(eventText, /event: router\.switch/);
  assert.match(eventText, /"to_alias":"Fixture A"/);
  assert.doesNotMatch(eventText, /must-not-pass|token/i);
  const manualSwitch = await fetch(`${origin}/__backend/codex-router/switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_alias: "Fixture Busy", reason: "manual" }),
  });
  assert.equal(manualSwitch.status, 502);
  assert.deepEqual(await manualSwitch.json(), {
    enabled: true,
    error: "router_switch_unavailable",
  });
  const malformedSwitch = await fetch(`${origin}/__backend/codex-router/switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account_alias: "Fixture B",
      reason: "manual",
      credential_ref: "must-not-pass",
    }),
  });
  assert.equal(malformedSwitch.status, 400);
  assert.deepEqual(await malformedSwitch.json(), {
    enabled: true,
    error: "invalid_switch_request",
  });
  assert.deepEqual(observed, [
    { path: "/v1/status", authorizationMatches: true, cursor: null },
    { path: "/v1/events", authorizationMatches: true, cursor: "8" },
  ]);
});

integrationTest("manual switch accepts only a sanitized native-identity transaction result", async (context) => {
  const prepared = await preparePatchedServer(context);
  const { forwardManualSwitch } = await import(
    pathToFileURL(path.join(prepared.temporaryRoot, "src/server/router-status-bridge.js")).href
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "m6-9-managed-switch-"));
  const socketPath = path.join(directory, "manager.sock");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const observed = [];
  const manager = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\n")) return;
      const request = JSON.parse(buffer);
      observed.push(request);
      if (request.alias === "Fixture Busy") {
        socket.end('{"ok":false,"error":"account_operation_failed"}\n');
        return;
      }
      setTimeout(() => {
        socket.end(`${JSON.stringify({
          ok: true,
          event: "router_account_switched",
          configured_accounts: 2,
          credentials_exposed: false,
          account_alias: request.alias,
          continuity: "new_backend_session",
          architecture_mode: "LIMITED_MODE",
          native_identity_rebound: true,
          web_restart_required: true,
        })}\n`);
      }, 25);
    });
  });
  await new Promise((resolve, reject) => {
    manager.once("error", reject);
    manager.listen(socketPath, resolve);
  });
  context.after(() => new Promise((resolve) => manager.close(resolve)));
  const config = {
    enabled: true,
    adminOrigin: "http://127.0.0.1:1",
    tokenFile: "/unused",
    credentialsDirectory: undefined,
    managerSocket: socketPath,
    restartWebAfterSwitch: false,
  };
  assert.deepEqual(
    await forwardManualSwitch(config, { account_alias: "Fixture Busy", reason: "manual" }),
    { statusCode: 409, payload: { enabled: true, error: "switch_rejected" } },
  );
  assert.deepEqual(
    await forwardManualSwitch(config, { account_alias: "Fixture B", reason: "manual" }),
    {
      statusCode: 200,
      payload: {
        enabled: true,
        accepted: true,
        account_alias: "Fixture B",
        continuity: "new_backend_session",
        architecture_mode: "LIMITED_MODE",
        native_identity_rebound: true,
        web_restart_required: true,
      },
    },
  );
  assert.deepEqual(observed, [
    { operation: "switch", alias: "Fixture Busy" },
    { operation: "switch", alias: "Fixture B" },
  ]);
});

test("overlay application rejects unpinned and structurally changed codex-web sources", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m4-2-overlay-reject-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "server"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "server", "main.ts"), "changed");
  await assert.rejects(
    applyStatusBridge({ codexWebRoot: root, revision: "different" }),
    /revision is not supported/,
  );
  await assert.rejects(
    applyStatusBridge({ codexWebRoot: root, revision: EXPECTED_CODEX_WEB_REVISION }),
    /does not match the pinned revision/,
  );
});
