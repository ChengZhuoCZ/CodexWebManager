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
const policySource = path.join(
  repositoryRoot,
  "integrations/codex-web/src/browser/browser-message-policy.ts",
);
const browserSessionSource = path.join(
  repositoryRoot,
  "integrations/codex-web/src/browser/browser-session.ts",
);

async function compilePolicy(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-3-browser-policy-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  const build = spawnSync(
    process.execPath,
    [
      path.join(codexWebRoot, "node_modules", "typescript", "bin", "tsc"),
      policySource,
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--lib",
      "ES2023,DOM",
      "--strict",
      "--skipLibCheck",
      "--rootDir",
      path.dirname(policySource),
      "--outDir",
      directory,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  return import(
    pathToFileURL(path.join(directory, "browser-message-policy.js")).href
  );
}

async function compileBrowserSession(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "m6-8-browser-session-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  const build = spawnSync(
    process.execPath,
    [
      path.join(codexWebRoot, "node_modules", "typescript", "bin", "tsc"),
      policySource,
      browserSessionSource,
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--lib",
      "ES2023,DOM",
      "--strict",
      "--skipLibCheck",
      "--rootDir",
      path.dirname(policySource),
      "--outDir",
      directory,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  return import(
    pathToFileURL(path.join(directory, "browser-session.js")).href
  );
}

integrationTest(
  "browser policy handles lifecycle and local state without crossing the server boundary",
  async (context) => {
    const { classifyBrowserMessage } = await compilePolicy(context);
    for (const type of [
      "electron-avatar-overlay-feedback-diagnostics-changed",
      "electron-avatar-overlay-restore-ready",
      "electron-desktop-features-changed",
      "electron-sparkle-gates-changed",
      "log-message",
      "set-telemetry-user",
      "view-focused",
    ]) {
      assert.deepEqual(classifyBrowserMessage({ type }), {
        kind: "local-noop",
      });
    }
    assert.deepEqual(
      classifyBrowserMessage({ type: "persisted-atom-sync-request" }),
      { kind: "local-persisted-sync" },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "persisted-atom-update",
        key: "fixture-key",
        value: { enabled: true },
      }),
      { kind: "local-noop" },
    );
    for (const type of [
      "shared-object-set",
      "shared-object-subscribe",
      "shared-object-unsubscribe",
    ]) {
      assert.deepEqual(
        classifyBrowserMessage({
          type,
          key: "fixture-key",
          ...(type === "shared-object-set" ? { value: true } : {}),
        }),
        { kind: "local-noop" },
      );
    }
    assert.deepEqual(classifyBrowserMessage({ type: "ready" }), {
      kind: "server",
    });
    assert.deepEqual(
      classifyBrowserMessage({ type: "terminal-run-action" }),
      { kind: "reject" },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "log-message",
        message: "x".repeat(300 * 1024),
      }),
      { kind: "reject" },
    );
  },
);

integrationTest(
  "browser policy normalizes evidence-backed external HTTP links and rejects active schemes",
  async (context) => {
    const { classifyBrowserMessage } = await compilePolicy(context);
    assert.deepEqual(
      classifyBrowserMessage({
        type: "open-in-browser",
        url: "https://example.com/docs",
        disposition: undefined,
        hostId: "local",
        initiator: "fixture",
        openTarget: undefined,
        openTargetIntent: undefined,
        originHostId: "local",
        source: "fixture",
        useExternalBrowser: true,
      }),
      { kind: "open-external", url: "https://example.com/docs" },
    );
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///etc/passwd",
      "vscode://codex/read-file",
      "https://user:secret@example.com/",
      "https://example.com/\u0000",
    ]) {
      assert.deepEqual(
        classifyBrowserMessage({ type: "open-in-browser", url }),
        { kind: "reject" },
      );
    }
    assert.deepEqual(
      classifyBrowserMessage({
        type: "open-in-browser",
        url: "https://example.com/",
        unknown: true,
      }),
      { kind: "reject" },
    );
  },
);

integrationTest(
  "browser policy always terminates correlated desktop fetches with a local result",
  async (context) => {
    const { classifyBrowserMessage } = await compilePolicy(context);
    const request = (url, extra = {}) => ({
      type: "fetch",
      requestId: "fixture-request",
      method: "POST",
      url,
      ...extra,
    });
    assert.deepEqual(
      classifyBrowserMessage(request("vscode://codex/get-settings")),
      {
        kind: "local-fetch-response",
        requestId: "fixture-request",
        body: { configuredValues: {}, values: {} },
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        request("vscode://codex/get-global-state", {
          body: JSON.stringify({ key: "fixture-key" }),
        }),
      ),
      {
        kind: "local-fetch-response",
        requestId: "fixture-request",
        body: { value: null },
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(request("vscode://codex/workspace-root-options")),
      {
        kind: "request-browser-config",
        requestId: "fixture-request",
        field: "workspaceRoots",
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(request("vscode://codex/codex-home")),
      {
        kind: "request-browser-config",
        requestId: "fixture-request",
        field: "codexHome",
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        request(
          "https://ab.chatgpt.com/v1/initialize?k=fixture&st=javascript-client",
          { body: JSON.stringify({ fixture: true }) },
        ),
      ),
      {
        kind: "local-fetch-response",
        requestId: "fixture-request",
        body: {
          dynamic_configs: {},
          feature_gates: {},
          has_updates: true,
          layer_configs: {},
          param_stores: {},
          time: 1,
        },
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        request("https://chatgpt.com/ces/v1/rgstr?k=fixture"),
      ),
      {
        kind: "local-fetch-response",
        requestId: "fixture-request",
        body: {},
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        request("https://ab.chatgpt.com/v1/rgstr?k=fixture"),
      ),
      {
        kind: "local-fetch-response",
        requestId: "fixture-request",
        body: {},
      },
    );
    for (const url of [
      "http://ab.chatgpt.com/v1/initialize?k=fixture",
      "https://ab.chatgpt.com/v1/initialize/extra?k=fixture",
      "https://ab.chatgpt.com.evil.example/v1/initialize?k=fixture",
      "https://ab.chatgpt.com/v1/rgstr/extra?k=fixture",
      "https://chatgpt.com/ces/v1/rgstr/extra?k=fixture",
      "https://example.com/v1/initialize?k=fixture",
    ]) {
      assert.deepEqual(classifyBrowserMessage(request(url)), {
        kind: "local-fetch-error",
        requestId: "fixture-request",
        status: 403,
        error: "unsupported_browser_route",
      });
    }
    assert.deepEqual(
      classifyBrowserMessage(
        request("vscode://codex/pick-files", {
          body: JSON.stringify({
            imagesOnly: true,
            pickerTitle: "Choose evidence",
          }),
        }),
      ),
      {
        kind: "local-file-picker",
        message: {
          body: JSON.stringify({
            imagesOnly: true,
            pickerTitle: "Choose evidence",
          }),
          method: "POST",
          requestId: "fixture-request",
          type: "fetch",
          url: "vscode://codex/pick-files",
        },
      },
    );
    for (const invalid of [
      request("vscode://codex/read-file"),
      request("vscode://codex/get-global-state"),
      request("vscode://codex/get-global-state", {
        body: JSON.stringify({ key: "__proto__" }),
      }),
      request("vscode://codex/get-settings", { method: "GET" }),
      request("vscode://codex/get-settings?bypass=1"),
      request("vscode://codex/pick-file", {
        body: JSON.stringify({ imagesOnly: "yes" }),
      }),
      request("//attacker.invalid/collect"),
    ]) {
      const disposition = classifyBrowserMessage(invalid);
      assert.equal(disposition.kind, "local-fetch-error");
      assert.equal(disposition.requestId, "fixture-request");
    }
    assert.deepEqual(
      classifyBrowserMessage({
        type: "fetch-stream",
        requestId: "fixture-stream",
        method: "POST",
        url: "vscode://codex/read-file",
      }),
      {
        kind: "local-fetch-stream-error",
        requestId: "fixture-stream",
        error: "browser_stream_route_unavailable",
      },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "fetch",
        method: "POST",
        url: "vscode://codex/get-settings",
      }),
      { kind: "reject" },
    );
  },
);

integrationTest(
  "browser native fetch terminates only exact Statsig POST routes locally",
  async (context) => {
    const originalFetch = globalThis.fetch;
    let forwarded = 0;
    globalThis.fetch = async () => {
      forwarded += 1;
      return new Response('{"forwarded":true}', {
        headers: { "content-type": "application/json" },
      });
    };
    context.after(() => {
      globalThis.fetch = originalFetch;
    });

    const { installBrowserFetchPolicy } =
      await compileBrowserSession(context);
    installBrowserFetchPolicy();

    const initialize = await fetch(
      "https://ab.chatgpt.com/v1/initialize?k=fixture",
      { method: "POST", body: "{}" },
    );
    assert.deepEqual(await initialize.json(), {
      dynamic_configs: {},
      feature_gates: {},
      has_updates: true,
      layer_configs: {},
      param_stores: {},
      time: 1,
    });
    const events = await fetch(
      "https://ab.chatgpt.com/v1/rgstr?k=fixture",
      { method: "POST", body: '{"fixture":true}' },
    );
    assert.deepEqual(await events.json(), {});
    const logEvents = await fetch(
      "https://ab.chatgpt.com/v1/log_event?k=fixture",
      { method: "POST", body: '{"fixture":true}' },
    );
    assert.deepEqual(await logEvents.json(), {});
    const cesLogEvents = await fetch(
      "https://chatgpt.com/ces/v1/log_event?k=fixture",
      { method: "POST", body: '{"fixture":true}' },
    );
    assert.deepEqual(await cesLogEvents.json(), {});
    assert.equal(forwarded, 0);

    const lookalike = await fetch(
      "https://ab.chatgpt.com.evil.example/v1/rgstr?k=fixture",
      { method: "POST" },
    );
    assert.deepEqual(await lookalike.json(), { forwarded: true });
    const readOnly = await fetch(
      "https://ab.chatgpt.com/v1/log_event?k=fixture",
      { method: "GET" },
    );
    assert.deepEqual(await readOnly.json(), { forwarded: true });
    assert.equal(forwarded, 2);
  },
);

integrationTest(
  "browser policy locally no-ops desktop-only picture-in-picture state updates",
  async (context) => {
    const { classifyBrowserMessage } = await compilePolicy(context);
    assert.deepEqual(
      classifyBrowserMessage({
        type: "remote-hosted-pip-active-thread-changed",
        conversationId: null,
      }),
      { kind: "local-noop" },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "remote-hosted-pip-hidden-thread-ids-changed",
        hiddenThreadIds: [],
      }),
      { kind: "local-noop" },
    );
  },
);

integrationTest(
  "browser policy restricts MCP correlation and workspace mutations",
  async (context) => {
    const { classifyBrowserMessage } = await compilePolicy(context);
    const mcp = (type, request) => ({
      type,
      hostId: "local",
      request,
    });
    assert.deepEqual(
      classifyBrowserMessage(
        mcp("mcp-request", {
          id: "account-read",
          method: "account/read",
          params: {},
        }),
      ),
      { kind: "server" },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        mcp("mcp-request", {
          id: "plugin-list",
          method: "plugin/list",
          params: {},
        }),
      ),
      {
        kind: "local-mcp-response",
        requestId: "plugin-list",
        result: {
          featuredPluginIds: [],
          marketplaceLoadErrors: [],
          marketplaces: [],
        },
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        mcp("mcp-request", {
          id: "mcp-server-status-list",
          method: "mcpServerStatus/list",
          params: {},
        }),
      ),
      {
        kind: "local-mcp-response",
        requestId: "mcp-server-status-list",
        result: {
          data: [],
          nextCursor: null,
        },
      },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        mcp("thread-prewarm-start", {
          id: "prewarm",
          method: "thread/start",
          params: {},
        }),
      ),
      { kind: "server" },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        mcp("thread-prewarm-start", {
          id: "wrong-prewarm",
          method: "account/read",
          params: {},
        }),
      ),
      { kind: "local-mcp-error", requestId: "wrong-prewarm" },
    );
    assert.deepEqual(
      classifyBrowserMessage(
        mcp("mcp-request", {
          id: "unsafe-auth",
          method: "getAuthStatus",
          params: { includeToken: true, refreshToken: false },
        }),
      ),
      { kind: "local-mcp-error", requestId: "unsafe-auth" },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "mcp-response",
        hostId: "local",
        response: { id: 7, result: { decision: "accept" } },
      }),
      { kind: "server" },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "electron-add-new-workspace-root-option",
        root: "/srv/codex-workspaces/project",
      }),
      {
        kind: "local-workspace-root-add",
        root: "/srv/codex-workspaces/project",
      },
    );
    assert.deepEqual(
      classifyBrowserMessage({
        type: "electron-update-workspace-root-options",
        roots: ["/srv/codex-workspaces/project"],
      }),
      {
        kind: "local-workspace-roots-update",
        roots: ["/srv/codex-workspaces/project"],
      },
    );
  },
);
