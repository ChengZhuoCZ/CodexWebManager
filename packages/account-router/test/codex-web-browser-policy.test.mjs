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
