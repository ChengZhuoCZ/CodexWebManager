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

integrationTest(
  "browser IPC router sends only the five newest complete history turns and closes older pagination",
  async (context) => {
    const { BrowserIpcRouter } = await compileRouter(context);
    const router = new BrowserIpcRouter(() => true, true);
    const socket = new FixtureSocket();
    const turns = Array.from({ length: 7 }, (_, index) => ({
      id: `turn-${index + 1}`,
      items: [
        {
          id: `message-${index + 1}`,
          type: "userMessage",
          content: [{ type: "text", text: `fixture-${index + 1}` }],
        },
      ],
      status: "completed",
    }));
    router.addSocket(socket);
    assert.equal(router.markTransportReady(socket), true);
    assert.equal(
      router.trackRendererMessage(socket, rendererMessage({ type: "ready" })),
      true,
    );

    assert.equal(
      router.trackRendererMessage(
        socket,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: {
            id: "read-history",
            method: "thread/read",
            params: { threadId: "thread-fixture", includeTurns: true },
          },
        }),
      ),
      true,
    );
    const readResponse = mainMessage({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: "read-history",
        result: {
          thread: {
            id: "thread-fixture",
            turns,
          },
        },
      },
    });
    router.routeMainMessage(readResponse);
    assert.deepEqual(
      socket.sent.at(-1).args[0].message.result.thread.turns.map(({ id }) => id),
      ["turn-3", "turn-4", "turn-5", "turn-6", "turn-7"],
    );
    assert.equal(readResponse.args[0].message.result.thread.turns.length, 7);

    assert.equal(
      router.trackRendererMessage(
        socket,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: {
            id: "recent-page",
            method: "thread/turns/list",
            params: {
              threadId: "thread-fixture",
              cursor: null,
              limit: 50,
              sortDirection: "desc",
            },
          },
        }),
      ),
      true,
    );
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "recent-page",
          result: {
            data: turns.toReversed(),
            nextCursor: "older-page",
            backwardsCursor: "newer-page",
          },
        },
      }),
    );
    assert.deepEqual(
      socket.sent.at(-1).args[0].message.result,
      {
        data: turns.toReversed().slice(0, 5),
        nextCursor: null,
        backwardsCursor: null,
      },
    );

    assert.equal(
      router.trackRendererMessage(
        socket,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: {
            id: "older-page",
            method: "thread/turns/list",
            params: {
              threadId: "thread-fixture",
              cursor: "older-page",
              limit: 5,
              sortDirection: "desc",
            },
          },
        }),
      ),
      true,
    );
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "older-page",
          result: {
            data: turns.slice(0, 2).toReversed(),
            nextCursor: null,
            backwardsCursor: "fixture-cursor",
          },
        },
      }),
    );
    assert.deepEqual(socket.sent.at(-1).args[0].message.result, {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });

    for (const [requestId, turnId, expectedItems] of [
      ["old-turn-items", "turn-2", []],
      [
        "recent-turn-items",
        "turn-7",
        [{ turnId: "turn-7", item: turns[6].items[0] }],
      ],
    ]) {
      assert.equal(
        router.trackRendererMessage(
          socket,
          rendererMessage({
            type: "mcp-request",
            hostId: "local",
            request: {
              id: requestId,
              method: "thread/items/list",
              params: { threadId: "thread-fixture", turnId },
            },
          }),
        ),
        true,
      );
      router.routeMainMessage(
        mainMessage({
          type: "mcp-response",
          hostId: "local",
          message: {
            id: requestId,
            result: {
              data: [{ turnId, item: turns.find(({ id }) => id === turnId)?.items[0] }],
              nextCursor: "fixture-items-cursor",
              backwardsCursor: "fixture-items-backwards",
            },
          },
        }),
      );
      assert.deepEqual(
        socket.sent.at(-1).args[0].message.result.data,
        expectedItems,
      );
      if (expectedItems.length === 0) {
        assert.equal(socket.sent.at(-1).args[0].message.result.nextCursor, null);
        assert.equal(
          socket.sent.at(-1).args[0].message.result.backwardsCursor,
          null,
        );
      }
    }
  },
);

integrationTest(
  "browser IPC router leaves loopback history unchanged when the Tailnet limit is disabled",
  async (context) => {
    const { BrowserIpcRouter } = await compileRouter(context);
    const router = new BrowserIpcRouter(() => true);
    const socket = new FixtureSocket();
    const turns = Array.from({ length: 7 }, (_, index) => ({
      id: `local-turn-${index + 1}`,
    }));
    router.addSocket(socket);
    assert.equal(router.markTransportReady(socket), true);
    assert.equal(
      router.trackRendererMessage(
        socket,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: {
            id: "local-history",
            method: "thread/read",
            params: { threadId: "local-thread", includeTurns: true },
          },
        }),
      ),
      true,
    );
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "local-history",
          result: { thread: { id: "local-thread", turns } },
        },
      }),
    );
    assert.deepEqual(
      socket.sent.at(-1).args[0].message.result.thread.turns,
      turns,
    );
  },
);

integrationTest(
  "browser IPC router limits resume bootstrap history without changing live semantic events",
  async (context) => {
    const { BrowserIpcRouter } = await compileRouter(context);
    const router = new BrowserIpcRouter(() => true, true);
    const socket = new FixtureSocket();
    const turns = Array.from({ length: 8 }, (_, index) => ({
      id: `resume-turn-${index + 1}`,
      items: [],
      status: "completed",
    }));
    router.addSocket(socket);
    assert.equal(router.markTransportReady(socket), true);
    assert.equal(
      router.trackRendererMessage(socket, rendererMessage({ type: "ready" })),
      true,
    );
    assert.equal(
      router.trackRendererMessage(
        socket,
        rendererMessage({
          type: "mcp-request",
          hostId: "local",
          request: {
            id: "resume-history",
            method: "thread/resume",
            params: {
              threadId: "resume-thread",
              initialTurnsPage: {
                limit: 25,
                itemsView: "full",
                sortDirection: "desc",
              },
            },
          },
        }),
      ),
      true,
    );
    router.routeMainMessage(
      mainMessage({
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "resume-history",
          result: {
            thread: { id: "resume-thread", turns },
            initialTurnsPage: {
              data: turns.toReversed(),
              nextCursor: "older-resume-page",
              backwardsCursor: "newer-resume-page",
            },
            turnsBackwardsCursor: "resume-head",
          },
        },
      }),
    );
    const response = socket.sent.at(-1).args[0].message.result;
    assert.deepEqual(
      response.thread.turns.map(({ id }) => id),
      turns.slice(-5).map(({ id }) => id),
    );
    assert.deepEqual(
      response.initialTurnsPage.data.map(({ id }) => id),
      turns.toReversed().slice(0, 5).map(({ id }) => id),
    );
    assert.equal(response.initialTurnsPage.nextCursor, null);
    assert.equal(response.initialTurnsPage.backwardsCursor, null);
    assert.equal(response.turnsBackwardsCursor, null);

    const liveEvent = mainMessage({
      type: "mcp-notification",
      hostId: "local",
      message: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "resume-thread",
          turnId: "live-turn",
          delta: "fixture-live-semantic-delta",
        },
      },
    });
    router.routeMainMessage(liveEvent);
    assert.deepEqual(socket.sent.at(-1), liveEvent);
  },
);
