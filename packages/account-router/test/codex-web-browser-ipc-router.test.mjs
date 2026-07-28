import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const codexWebRoot =
  process.env.M6_3_CODEX_WEB_ROOT ?? process.env.M4_2_CODEX_WEB_ROOT;
const integrationTest =
  codexWebRoot && path.isAbsolute(codexWebRoot) ? test : test.skip;
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const routerSource = path.join(
  repositoryRoot,
  "integrations/codex-web/src/server/browser-ipc-router.ts",
);

async function compileRouter(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-3-browser-ipc-router-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  const build = spawnSync(
    process.execPath,
    [
      path.join(codexWebRoot, "node_modules", "typescript", "bin", "tsc"),
      routerSource,
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--lib",
      "ES2023",
      "--strict",
      "--skipLibCheck",
      "--rootDir",
      path.dirname(routerSource),
      "--outDir",
      directory,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  return import(
    pathToFileURL(path.join(directory, "browser-ipc-router.js")).href
  );
}

class FixtureSocket {
  readyState = 1;
  sent = [];

  send(serialized) {
    this.sent.push(JSON.parse(serialized));
  }
}

function rendererMessage(payload, requestId = "bridge-request") {
  return {
    type: "ipc-renderer-invoke",
    requestId,
    channel: "codex_desktop:message-from-view",
    args: [payload],
  };
}

function mainMessage(payload) {
  return {
    type: "ipc-main-event",
    channel: "codex_desktop:message-for-view",
    args: [payload],
  };
}

integrationTest(
  "browser IPC router requires transport readiness and scopes MCP correlation by socket and id type",
  async (context) => {
    const { BrowserIpcRouter } = await compileRouter(context);
    const router = new BrowserIpcRouter(() => true);
    const first = new FixtureSocket();
    const second = new FixtureSocket();
    router.addSocket(first);
    router.addSocket(second);

    assert.equal(
      router.trackRendererMessage(first, rendererMessage({ type: "ready" })),
      false,
    );
    assert.equal(router.markTransportReady(first), true);
    assert.equal(router.markTransportReady(first), false);
    assert.equal(router.markTransportReady(second), true);
    assert.equal(
      router.trackRendererMessage(first, rendererMessage({ type: "ready" })),
      true,
    );
    assert.equal(
      router.trackRendererMessage(first, rendererMessage({ type: "ready" })),
      false,
    );

    assert.equal(
      router.trackRendererMessage(
        first,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: { id: "1", method: "account/read", params: {} },
        }),
      ),
      true,
    );
    assert.equal(
      router.trackRendererMessage(
        second,
        rendererMessage(
          {
            type: "mcp-request",
            hostId: "local",
            request: { id: 1, method: "account/read", params: {} },
          },
          "bridge-request-2",
        ),
      ),
      true,
    );
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: { id: "1", result: { ok: "string" } },
      }),
    );
    assert.equal(first.sent.length, 1);
    assert.equal(second.sent.length, 0);
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: { id: 1, result: { ok: "number" } },
      }),
    );
    assert.equal(first.sent.length, 1);
    assert.equal(second.sent.length, 1);

    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "remote",
        message: { id: "uncorrelated", result: { shouldNotBroadcast: true } },
      }),
    );
    assert.equal(first.sent.length, 1);
    assert.equal(second.sent.length, 1);
  },
);

integrationTest(
  "browser IPC router assigns main requests to one tab and redacts blocked correlated responses",
  async (context) => {
    const { BrowserIpcRouter } = await compileRouter(context);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...values) => warnings.push(values.join(" "));
    context.after(() => {
      console.warn = originalWarn;
    });
    const router = new BrowserIpcRouter(
      (message) => !JSON.stringify(message).includes("fixture-access-canary"),
    );
    const first = new FixtureSocket();
    const second = new FixtureSocket();
    router.addSocket(first);
    router.addSocket(second);
    assert.equal(router.markTransportReady(first), true);
    assert.equal(router.markTransportReady(second), true);
    router.routeMainMessage(
      mainMessage({
        type: "mcp-request",
        hostId: "local",
        request: {
          id: "before-view-ready",
          method: "item/requestApproval",
          params: {},
        },
      }),
    );
    assert.equal(first.sent.length, 0);
    assert.equal(second.sent.length, 0);
    assert.equal(
      router.trackRendererMessage(first, rendererMessage({ type: "ready" })),
      true,
    );

    router.routeMainMessage(
      mainMessage({
        type: "mcp-request",
        hostId: "local",
        request: { id: "approval", method: "item/requestApproval", params: {} },
      }),
    );
    assert.equal(first.sent.length, 1);
    assert.equal(second.sent.length, 0);
    const response = rendererMessage({
      type: "mcp-response",
      hostId: "local",
      response: { id: "approval", result: { decision: "accept" } },
    });
    assert.equal(router.trackRendererMessage(second, response), false);
    assert.equal(router.trackRendererMessage(first, response), true);

    assert.equal(
      router.trackRendererMessage(
        first,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: { id: "secret-result", method: "account/read", params: {} },
        }),
      ),
      true,
    );
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "secret-result",
          result: { accessToken: "fixture-access-canary" },
        },
      }),
    );
    assert.equal(first.sent.length, 2);
    const fallback = first.sent.at(-1);
    assert.equal(fallback.args[0].type, "mcp-response");
    assert.equal(fallback.args[0].message.error.code, -32603);
    assert.doesNotMatch(JSON.stringify(fallback), /fixture-access-canary/);
    assert.deepEqual(warnings, [
      "[browser-ipc-router] filtered renderer response method=account/read",
    ]);
    assert.doesNotMatch(warnings.join("\n"), /fixture-access-canary/);
  },
);

integrationTest(
  "browser IPC router clears cached state after the last authenticated socket closes",
  async (context) => {
    const { BrowserIpcRouter } = await compileRouter(context);
    const router = new BrowserIpcRouter(() => true);
    const first = new FixtureSocket();
    router.addSocket(first);
    assert.equal(router.markTransportReady(first), true);
    router.routeMainMessage(
      mainMessage({
        type: "codex-app-server-initialized",
        hostId: "local",
        state: "ready",
      }),
    );
    assert.equal(first.sent.length, 0);
    assert.equal(
      router.trackRendererMessage(first, rendererMessage({ type: "ready" })),
      true,
    );
    assert.equal(first.sent.length, 1);
    router.removeSocket(first);

    const nextSession = new FixtureSocket();
    router.addSocket(nextSession);
    assert.equal(router.markTransportReady(nextSession), true);
    assert.deepEqual(nextSession.sent, []);
    assert.equal(
      router.trackRendererMessage(
        nextSession,
        rendererMessage({ type: "ready" }),
      ),
      true,
    );
    assert.deepEqual(nextSession.sent, []);
  },
);
