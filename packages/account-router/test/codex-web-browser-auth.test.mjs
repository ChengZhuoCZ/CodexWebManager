import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  applyStatusBridge,
  EXPECTED_CODEX_WEB_REVISION,
} from "../../../integrations/codex-web/apply-status-bridge.mjs";

const codexWebRoot =
  process.env.M6_3_CODEX_WEB_ROOT ?? process.env.M4_2_CODEX_WEB_ROOT;
const integrationTest =
  codexWebRoot && path.isAbsolute(codexWebRoot) ? test : test.skip;
const ACCESS_TOKEN = "fixture-browser-access-token-00000000000000000000";

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function prepareSecureOverlay(context) {
  const root = codexWebRoot;
  assert.ok(root && path.isAbsolute(root));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  assert.equal(revision.status, 0);
  assert.equal(revision.stdout.trim(), EXPECTED_CODEX_WEB_REVISION);

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-3-codex-web-auth-"),
  );
  context.after(() =>
    fs.rm(temporaryRoot, { recursive: true, force: true }),
  );
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
    await fs.copyFile(path.join(root, relativePath), destination);
  }
  await fs.symlink(
    path.join(root, "node_modules"),
    path.join(temporaryRoot, "node_modules"),
  );
  await applyStatusBridge({
    codexWebRoot: temporaryRoot,
    revision: EXPECTED_CODEX_WEB_REVISION,
  });

  const harnessSource = `
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { registerBrowserSessionAuth } from "./browser-session-auth";

async function main() {
  const app = Fastify({ logger: false });
  const auth = await registerBrowserSessionAuth(app, process.env);
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  let handlerCalls = 0;

  app.get("/private", async () => ({ ok: true }));
  app.post("/write", async () => ({ accepted: true }));
  app.get("/counts", async () => ({ handlerCalls }));

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const authorization = auth.authorizeWebSocket(request);
    if (
      requestUrl !== "/__backend/ipc" ||
      !authorization.ok
    ) {
      const statusCode = authorization.ok ? 400 : authorization.statusCode;
      const statusText =
        statusCode === 401 ? "Unauthorized" :
        statusCode === 403 ? "Forbidden" :
        "Bad Request";
      socket.end(
        "HTTP/1.1 " + statusCode + " " + statusText +
          "\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n",
      );
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  websocketServer.on("connection", (socket, request) => {
    const authorization = auth.authorizeWebSocket(request);
    if (!authorization.ok) {
      socket.close(1008, "session unavailable");
      return;
    }
    const unbind = auth.bindWebSocket(authorization.sessionId, socket);
    socket.once("close", unbind);
    socket.on("message", async (rawMessage) => {
      let message;
      try {
        message = JSON.parse(String(rawMessage));
      } catch {
        socket.close(1007, "invalid message");
        return;
      }
      if (!auth.authorizeRendererMessage(message)) {
        socket.close(1008, "request not permitted");
        return;
      }
      if (message.type === "workspace-directory-entries-request") {
        try {
          const directoryPath = await auth.resolveWorkspaceDirectory(
            message.directoryPath,
          );
          handlerCalls += 1;
          socket.send(JSON.stringify({ ok: true, directoryPath }));
        } catch {
          socket.close(1008, "request not permitted");
        }
        return;
      }
      handlerCalls += 1;
      socket.send(JSON.stringify({ ok: true }));
    });
  });

  const origin = await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.FIXTURE_PORT),
  });
  process.stdout.write(JSON.stringify({ origin }) + "\\n");
  const stop = async () => {
    for (const socket of websocketServer.clients) {
      socket.close(1001, "fixture stopping");
    }
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => {
  process.stderr.write("secure browser fixture failed\\n");
  process.exit(1);
});
`;
  await fs.writeFile(
    path.join(temporaryRoot, "src", "server", "auth-harness.ts"),
    harnessSource,
  );
  const build = spawnSync(
    process.execPath,
    [path.join(root, "node_modules", "typescript", "bin", "tsc")],
    {
      cwd: path.join(temporaryRoot, "src", "server"),
      encoding: "utf8",
    },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  return {
    harness: path.join(
      temporaryRoot,
      "src",
      "server",
      "auth-harness.js",
    ),
    temporaryRoot,
  };
}

async function startHarness(context, prepared) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const privateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-3-browser-auth-secret-"),
  );
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-3-browser-auth-workspace-"),
  );
  const codexHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-3-browser-auth-codex-home-"),
  );
  context.after(() =>
    Promise.all([
      fs.rm(privateDirectory, { recursive: true, force: true }),
      fs.rm(workspaceRoot, { recursive: true, force: true }),
      fs.rm(codexHome, { recursive: true, force: true }),
    ]),
  );
  await fs.chmod(privateDirectory, 0o700);
  await fs.chmod(workspaceRoot, 0o700);
  const resolvedWorkspaceRoot = await fs.realpath(workspaceRoot);
  const tokenFile = path.join(privateDirectory, "browser-access-token");
  await fs.writeFile(tokenFile, ACCESS_TOKEN, { mode: 0o600 });
  await fs.chmod(tokenFile, 0o600);

  const child = spawn(process.execPath, [prepared.harness], {
    cwd: prepared.temporaryRoot,
    env: {
      ...process.env,
      CODEX_WEB_ACCESS_TOKEN_FILE: tokenFile,
      CODEX_WEB_CODEX_HOME: codexHome,
      CODEX_WEB_PUBLIC_ORIGIN: origin,
      CODEX_WEB_WORKSPACE_ROOTS: workspaceRoot,
      FIXTURE_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const boundary = stdout.indexOf("\n");
      if (boundary === -1) return;
      try {
        resolve(JSON.parse(stdout.slice(0, boundary)).origin);
      } catch {
        reject(new Error("secure browser fixture readiness was invalid"));
      }
    });
    exit.then(({ code }) => {
      reject(new Error(`secure browser fixture exited ${code}: ${stderr}`));
    });
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exit;
    }
  });
  assert.equal(await ready, origin);
  return {
    child,
    codexHome: await fs.realpath(codexHome),
    origin,
    workspaceRoot: resolvedWorkspaceRoot,
  };
}

function sameOriginHeaders(origin, extra = {}) {
  return {
    host: new URL(origin).host,
    origin,
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

async function login(origin, token) {
  return fetch(`${origin}/__backend/session/login`, {
    method: "POST",
    redirect: "manual",
    headers: sameOriginHeaders(origin, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: new URLSearchParams({ access_token: token }).toString(),
  });
}

function websocketClient(root, endpoint, cookie, options = {}) {
  const requireFromCodexWeb = createRequire(
    path.join(root, "package.json"),
  );
  const WebSocket = requireFromCodexWeb("ws");
  const protocols =
    options.protocols === undefined ? ["codex-ipc.v1"] : options.protocols;
  return new WebSocket(endpoint, protocols, {
    origin: options.origin,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function rejectedWebSocket(root, endpoint, cookie, options = {}) {
  const socket = websocketClient(root, endpoint, cookie, options);
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("websocket unexpectedly opened"));
    });
    socket.once("error", () => undefined);
  });
}

async function rawUpgradeStatus(origin, requestTarget, host) {
  const { hostname, port } = new URL(origin);
  const response = new Promise((resolve, reject) => {
    const socket = net.createConnection(Number(port), hostname);
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
      const firstLineEnd = data.indexOf("\r\n");
      if (firstLineEnd === -1) return;
      socket.destroy();
      const match = /^HTTP\/1\.1 ([0-9]{3}) /.exec(
        data.slice(0, firstLineEnd),
      );
      if (!match) {
        reject(new Error("raw upgrade response was invalid"));
        return;
      }
      resolve(Number(match[1]));
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${requestTarget} HTTP/1.1`,
          `Host: ${host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: Zml4dHVyZS13ZWJzb2NrZXQta2V5",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
  return bounded(response, "raw websocket upgrade");
}

async function openedWebSocket(root, endpoint, cookie, origin) {
  const socket = websocketClient(root, endpoint, cookie, { origin });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function bounded(promise, label, timeoutMs = 3_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function closeAfterMessage(socket, message) {
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: String(reason) }),
    );
  });
  socket.send(JSON.stringify(message));
  return bounded(closed, `message ${message.requestId ?? message.type}`);
}

integrationTest(
  "secure codex-web overlay authenticates HTTP/WS and blocks credential-bearing renderer requests",
  async (context) => {
    const prepared = await prepareSecureOverlay(context);
    const fixture = await startHarness(context, prepared);
    const endpoint = `${fixture.origin.replace("http:", "ws:")}/__backend/ipc`;

    const health = await fetch(`${fixture.origin}/__backend/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const unauthenticated = await fetch(`${fixture.origin}/private`);
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), {
      error: "authentication_required",
    });
    assert.equal(
      await fetch(`${fixture.origin}/__backend/browser-config`).then(
        (response) => response.status,
      ),
      401,
    );
    const unauthenticatedHtml = await fetch(`${fixture.origin}/`, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    assert.equal(unauthenticatedHtml.status, 303);
    assert.equal(
      unauthenticatedHtml.headers.get("location"),
      "/__backend/session/login",
    );

    const wrongLogin = await login(fixture.origin, `${ACCESS_TOKEN}-wrong`);
    assert.equal(wrongLogin.status, 401);
    const wrongBody = await wrongLogin.text();
    assert.doesNotMatch(wrongBody, /fixture-browser-access-token/);

    const authenticated = await login(fixture.origin, ACCESS_TOKEN);
    assert.equal(authenticated.status, 303);
    const setCookie = authenticated.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /fixture-browser-access-token/);
    const cookie = setCookie.split(";", 1)[0];

    const session = await fetch(`${fixture.origin}/__backend/session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.match(sessionBody.csrfToken, /^[A-Za-z0-9_-]{43}$/);

    const browserConfig = await fetch(
      `${fixture.origin}/__backend/browser-config`,
      { headers: { cookie } },
    );
    assert.equal(browserConfig.status, 200);
    assert.deepEqual(await browserConfig.json(), {
      codexHome: fixture.codexHome,
      workspaceRoots: [fixture.workspaceRoot],
    });
    assert.equal(browserConfig.headers.get("cache-control"), "no-store");

    const missingCsrf = await fetch(`${fixture.origin}/write`, {
      method: "POST",
      headers: sameOriginHeaders(fixture.origin, { cookie }),
    });
    assert.equal(missingCsrf.status, 403);
    const acceptedWrite = await fetch(`${fixture.origin}/write`, {
      method: "POST",
      headers: sameOriginHeaders(fixture.origin, {
        cookie,
        "x-codex-csrf": sessionBody.csrfToken,
      }),
    });
    assert.equal(acceptedWrite.status, 200);

    assert.equal(
      await rejectedWebSocket(
        codexWebRoot,
        endpoint,
        null,
        { origin: fixture.origin },
      ),
      401,
    );
    assert.equal(
      await rejectedWebSocket(
        codexWebRoot,
        endpoint,
        cookie,
        { origin: "https://attacker.invalid" },
      ),
      403,
    );
    assert.equal(
      await rejectedWebSocket(
        codexWebRoot,
        endpoint,
        cookie,
        { origin: fixture.origin, protocols: [] },
      ),
      400,
    );
    assert.equal(
      await rawUpgradeStatus(fixture.origin, "/__backend/ipc", "["),
      403,
    );
    assert.equal(
      await fetch(`${fixture.origin}/__backend/healthz`).then(
        (response) => response.status,
      ),
      200,
    );

    const deniedMessages = [
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-auth-token",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "mcp-request",
            hostId: "local",
            request: {
              id: "deny-auth-token-inner",
              method: "getAuthStatus",
              params: { includeToken: true, refreshToken: false },
            },
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-api-key",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "fetch",
            requestId: "deny-api-key-inner",
            method: "POST",
            url: "vscode://codex/openai-api-key?bypass=1",
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-host-file-read",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "fetch",
            requestId: "deny-host-file-read-inner",
            method: "POST",
            url: "vscode://codex/read-file",
            body: JSON.stringify({
              path: "/run/credentials/codex-web.service/browser-access-token",
              hostId: "local",
            }),
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-dictation-token",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "fetch",
            requestId: "deny-dictation-token-inner",
            method: "POST",
            url: "/codex/dictation-stream-connect-info?bypass=1",
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-network-path-fetch",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "fetch",
            requestId: "deny-network-path-fetch-inner",
            method: "GET",
            url: "//attacker.invalid/collect",
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-unknown-view-message",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "terminal-run-action",
            hostId: "local",
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-worker-channel",
        channel: "codex_desktop:connect-app-host",
        args: [],
      },
      {
        type: "ipc-renderer-send",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "mcp-request",
            hostId: "local",
            request: {
              id: "deny-send-inner",
              method: "account/read",
              params: {},
            },
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-ambiguous-auth-status",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "mcp-request",
            hostId: "local",
            request: {
              id: "deny-ambiguous-auth-status-inner",
              method: "getAuthStatus",
              params: { refreshToken: false },
            },
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-prewarm-method",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "thread-prewarm-start",
            hostId: "local",
            request: {
              id: "deny-prewarm-method-inner",
              method: "account/read",
              params: {},
            },
          },
        ],
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "deny-channel",
        channel: "arbitrary:host-control",
        args: [],
      },
    ];
    for (const message of deniedMessages) {
      const socket = await openedWebSocket(
        codexWebRoot,
        endpoint,
        cookie,
        fixture.origin,
      );
      const closed = await closeAfterMessage(socket, message);
      assert.equal(closed.code, 1008);
      assert.equal(closed.reason, "request not permitted");
    }

    const countsBefore = await fetch(`${fixture.origin}/counts`, {
      headers: { cookie },
    }).then((response) => response.json());
    assert.equal(countsBefore.handlerCalls, 0);

    const allowedSocket = await openedWebSocket(
      codexWebRoot,
      endpoint,
      cookie,
      fixture.origin,
    );
    const allowedResponse = new Promise((resolve) => {
      allowedSocket.once("message", (message) =>
        resolve(JSON.parse(String(message))),
      );
    });
    allowedSocket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: "allowed-account-read",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "mcp-request",
            hostId: "local",
            request: {
              id: "allowed-account-read-inner",
              method: "account/read",
              params: { refreshToken: false },
            },
          },
        ],
      }),
    );
    assert.deepEqual(await allowedResponse, { ok: true });

    const safeAuthStatusResponse = new Promise((resolve) => {
      allowedSocket.once("message", (message) =>
        resolve(JSON.parse(String(message))),
      );
    });
    allowedSocket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: "allowed-safe-auth-status",
        channel: "codex_desktop:message-from-view",
        args: [
          {
            type: "mcp-request",
            hostId: "local",
            request: {
              id: "allowed-safe-auth-status-inner",
              method: "getAuthStatus",
              params: { includeToken: false, refreshToken: false },
            },
          },
        ],
      }),
    );
    assert.deepEqual(await safeAuthStatusResponse, { ok: true });

    const metricsResponse = new Promise((resolve) => {
      allowedSocket.once("message", (message) =>
        resolve(JSON.parse(String(message))),
      );
    });
    allowedSocket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: "allowed-fast-mode-metrics",
        channel: "codex_desktop:get-fast-mode-rollout-metrics",
        args: [{ model: "fixture-model" }],
      }),
    );
    assert.deepEqual(await metricsResponse, { ok: true });

    const workspaceSocket = await openedWebSocket(
      codexWebRoot,
      endpoint,
      cookie,
      fixture.origin,
    );
    const workspaceResponse = new Promise((resolve) => {
      workspaceSocket.once("message", (message) =>
        resolve(JSON.parse(String(message))),
      );
    });
    workspaceSocket.send(
      JSON.stringify({
        type: "workspace-directory-entries-request",
        requestId: "allowed-workspace",
        directoryPath: fixture.workspaceRoot,
        directoriesOnly: true,
      }),
    );
    assert.deepEqual(await workspaceResponse, {
      ok: true,
      directoryPath: fixture.workspaceRoot,
    });

    const outsideSocket = await openedWebSocket(
      codexWebRoot,
      endpoint,
      cookie,
      fixture.origin,
    );
    const outsideClosed = await closeAfterMessage(outsideSocket, {
      type: "workspace-directory-entries-request",
      requestId: "outside-workspace",
      directoryPath: "/",
      directoriesOnly: true,
    });
    assert.equal(outsideClosed.code, 1008);

    const logoutClose = new Promise((resolve) => {
      allowedSocket.once("close", (code) => resolve(code));
    });
    const logout = await fetch(`${fixture.origin}/__backend/session`, {
      method: "DELETE",
      headers: sameOriginHeaders(fixture.origin, {
        cookie,
        "x-codex-csrf": sessionBody.csrfToken,
      }),
    });
    assert.equal(logout.status, 204);
    assert.equal(await bounded(logoutClose, "logout websocket close"), 1008);
    assert.equal(
      await fetch(`${fixture.origin}/private`, {
        headers: { cookie },
      }).then((response) => response.status),
      401,
    );

    workspaceSocket.close();
  },
);

integrationTest(
  "renderer output filter rejects nested credential canaries without blocking usage metadata",
  async (context) => {
    const prepared = await prepareSecureOverlay(context);
    const { isAuthorizedRendererEvent } = await import(
      pathToFileURL(
        path.join(
          prepared.temporaryRoot,
          "src",
          "server",
          "browser-session-auth.js",
        ),
      ).href
    );
    assert.equal(
      isAuthorizedRendererEvent({
        type: "ipc-main-event",
        args: [
          {
            tokenUsage: { input: 7, output: 3 },
            outputTokenCount: 3,
          },
        ],
      }),
      true,
    );
    for (const value of [
      "The request completed with an ordinary status message.",
      "Authorization is required before continuing.",
      "Cookie settings are unavailable in browser mode.",
      "Token usage: 7 input tokens and 3 output tokens.",
    ]) {
      assert.equal(
        isAuthorizedRendererEvent({
          type: "ipc-main-event",
          args: [{ message: value }],
        }),
        true,
        value,
      );
    }
    for (const key of [
      "accessToken",
      "openaiApiKey",
      "oauthToken",
      "authToken",
      "secretKey",
      "proxyAuthorization",
      "sessionRefreshToken",
      "setCookie",
    ]) {
      assert.equal(
        isAuthorizedRendererEvent({
          type: "ipc-main-event",
          args: [{ nested: { [key]: "fixture-canary" } }],
        }),
        false,
        key,
      );
    }
    const secretShapeCanaries = [
      ["Authorization:", " Bearer ", "fixture-secret-1234567890"].join(""),
      ["Cookie:", " session=", "fixture-secret-1234567890"].join(""),
      ["sk-", "proj-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join(""),
      ["ghp", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join(""),
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiJmaXh0dXJlIn0",
        "c2lnbmF0dXJlMTIzNDU2",
      ].join("."),
      ["-----BEGIN ", "PRIVATE KEY-----", "\nfixture-secret-material"].join(
        "",
      ),
      ["refresh_token", "=", '"fixture-secret-1234567890"'].join(""),
    ];
    for (const value of secretShapeCanaries) {
      for (const key of ["message", "error"]) {
        assert.equal(
          isAuthorizedRendererEvent({
            type: "ipc-main-event",
            args: [{ [key]: value }],
          }),
          false,
          `${key}: ${value}`,
        );
      }
    }
    for (const headers of [
      [["authorization", "fixture-canary"]],
      [{ name: "set-cookie", value: "fixture-canary" }],
      [{ key: "proxy-authorization", value: "fixture-canary" }],
    ]) {
      assert.equal(
        isAuthorizedRendererEvent({
          type: "ipc-main-event",
          args: [{ headers }],
        }),
        false,
      );
    }
    assert.equal(
      isAuthorizedRendererEvent({
        type: "ipc-main-event",
        args: [
          {
            type: "fetch-response",
            bodyJsonString: JSON.stringify({
              result: { refresh_token: "fixture-canary" },
            }),
          },
        ],
      }),
      false,
    );
    assert.equal(
      isAuthorizedRendererEvent({
        type: "ipc-main-event",
        args: [{ bodyJsonString: "not-json" }],
      }),
      false,
    );
  },
);

integrationTest(
  "browser CSP permits only the pinned inline UUID bootstrap",
  async () => {
    const root = codexWebRoot;
    assert.ok(root && path.isAbsolute(root));
    const indexSource = await fs.readFile(
      path.join(root, "scratch", "asar", "webview", "index.html"),
      "utf8",
    );
    const inlineScripts = Array.from(
      indexSource.matchAll(/<script>([\s\S]*?)<\/script>/gu),
      (match) => match[1],
    );
    assert.equal(inlineScripts.length, 1);
    const digest = createHash("sha256")
      .update(inlineScripts[0])
      .digest("base64");
    const authSource = await fs.readFile(
      new URL(
        "../../../integrations/codex-web/src/server/browser-session-auth.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(authSource.includes(`sha256-${digest}`));
  },
);

test("browser auth policy is fail-closed even when the pinned checkout is unavailable", async () => {
  const source = await fs.readFile(
    new URL(
      "../../../integrations/codex-web/src/server/browser-session-auth.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /CODEX_WEB_ACCESS_TOKEN_FILE/);
  assert.match(source, /CODEX_WEB_PUBLIC_ORIGIN/);
  assert.match(source, /CODEX_WEB_CODEX_HOME/);
  assert.match(source, /CODEX_WEB_WORKSPACE_ROOTS/);
  assert.match(source, /request\.method !== "getAuthStatus"/);
  assert.match(source, /request\.params\.includeToken === false/);
  assert.match(source, /value\.request\.method !== "thread\/start"/);
  assert.match(source, /isAuthorizedRendererEvent/);
  assert.match(source, /SENSITIVE_OUTPUT_KEYS/);
  assert.doesNotMatch(source, /connect-src[^\\n]*https:/);
  assert.match(source, /SameSite=Strict/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /session\.expiryTimer = setTimeout/);
  assert.match(source, /response\.destroy\(\)/);
  assert.doesNotMatch(source, /console\\.(?:log|error|warn).*token/i);
});
