#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CODEX_WEB_REVISION = "888692f7d885118c6a92bbaf60cf2121f5947adf";
const EXPECTED_MAIN_SHA256 = "93cae9db150ef3a17ac859d0de803b608d64d64ee22beaed5ffb5453641d3788";
const EXPECTED_SHIM_SHA256 = "bd191409b7a134f1be9e698f9c16f94fd22532f4a3a6850ecb1a48e6cfa9e837";
const EXPECTED_FILES_SHA256 = "5459233ca620920dbbd18c4f01e6d89b3a3910d717600f794484cd1d046b08d3";
const EXPECTED_VITE_SHA256 = "ddcd625927e3f831b33eac0d25aa39e3223424d71d712ba083daf10ca0ed4e4a";
const integrationDirectory = fileURLToPath(new URL(".", import.meta.url));
const serverOverlaySource = path.join(integrationDirectory, "src", "server", "router-status-bridge.ts");
const accountManagementOverlaySource = path.join(
  integrationDirectory,
  "src",
  "server",
  "router-account-management.ts",
);
const browserOverlaySource = path.join(integrationDirectory, "src", "browser", "router-account-panel.ts");
const browserAuthOverlaySource = path.join(
  integrationDirectory,
  "src",
  "server",
  "browser-session-auth.ts",
);
const browserSessionOverlaySource = path.join(
  integrationDirectory,
  "src",
  "browser",
  "browser-session.ts",
);
const browserUploadStoreOverlaySource = path.join(
  integrationDirectory,
  "src",
  "server",
  "browser-upload-store.ts",
);
const browserIpcRouterOverlaySource = path.join(
  integrationDirectory,
  "src",
  "server",
  "browser-ipc-router.ts",
);
const preferredContentEncodingOverlaySource = path.join(
  integrationDirectory,
  "src",
  "server",
  "preferred-content-encoding.ts",
);
const browserMessagePolicyOverlaySource = path.join(
  integrationDirectory,
  "src",
  "browser",
  "browser-message-policy.ts",
);

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function prepareBrowserIndexForRuntime(originalBrowserIndex) {
  if (typeof originalBrowserIndex !== "string") {
    throw new Error("codex-web browser index is unavailable");
  }
  const unversionedPreload = 'src="./assets/preload.js"';
  const versionedPreloads = originalBrowserIndex.match(
    /src="\.\/assets\/preload-[a-f0-9]{8}\.js"/gu,
  ) ?? [];
  const unversionedCount = originalBrowserIndex.split(unversionedPreload).length - 1;
  let browserIndexWithCacheKey;
  if (unversionedCount === 1 && versionedPreloads.length === 0) {
    browserIndexWithCacheKey = originalBrowserIndex.replace(
      unversionedPreload,
      'src="./assets/preload.js?v=m6-8-startup-chat-r8"',
    );
  } else if (unversionedCount === 0 && versionedPreloads.length === 1) {
    browserIndexWithCacheKey = originalBrowserIndex;
  } else {
    throw new Error("codex-web browser preload anchor is unavailable");
  }

  const transparentBackground = "--startup-background: transparent;";
  const stagedBackground = "--startup-background: rgb(248 248 248);";
  const canvasBackground = "--startup-background: Canvas;";
  const backgroundCounts = [transparentBackground, stagedBackground, canvasBackground]
    .map((anchor) => browserIndexWithCacheKey.split(anchor).length - 1);
  if (backgroundCounts.reduce((total, count) => total + count, 0) !== 1) {
    throw new Error("codex-web startup background anchor is unavailable");
  }
  const browserIndexWithBackground = backgroundCounts[0] === 1
    ? browserIndexWithCacheKey.replace(transparentBackground, canvasBackground)
    : browserIndexWithCacheKey;
  const startupProbeScript =
    '<script src="/__backend/startup-probe.js"></script>';
  if (browserIndexWithBackground.includes(startupProbeScript)) {
    throw new Error("codex-web browser startup probe anchor is unavailable");
  }
  const preloadSource = unversionedCount === 1
    ? 'src="./assets/preload.js?v=m6-8-startup-chat-r8"'
    : versionedPreloads[0];
  const preloadSourceIndex = browserIndexWithBackground.indexOf(preloadSource);
  const preloadLineStart = browserIndexWithBackground.lastIndexOf(
    "\n",
    preloadSourceIndex,
  ) + 1;
  if (preloadSourceIndex < 0 || preloadLineStart < 0) {
    throw new Error("codex-web browser startup probe anchor is unavailable");
  }
  const indentation = browserIndexWithBackground
    .slice(preloadLineStart, preloadSourceIndex)
    .match(/^[ \t]*/u)?.[0] ?? "";
  return (
    browserIndexWithBackground.slice(0, preloadLineStart) +
    indentation + startupProbeScript + "\n" +
    browserIndexWithBackground.slice(preloadLineStart)
  );
}

function replaceOnce(value, anchor, replacement, label) {
  if (!value.includes(anchor)) {
    throw new Error(`codex-web ${label} integration anchor is unavailable`);
  }
  return value.replace(anchor, replacement);
}

function replaceAllExactly(value, anchor, replacement, count, label) {
  const matches = value.split(anchor).length - 1;
  if (matches !== count) {
    throw new Error(`codex-web ${label} integration anchor is unavailable`);
  }
  return value.replaceAll(anchor, replacement);
}

async function stageReplacement(target, content) {
  const mode = (await fs.stat(target)).mode & 0o777;
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.codex-patch-${randomUUID()}`,
  );
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return temporary;
}

export async function replaceFilesRecoverably(
  entries,
  { beforeInstall = null } = {},
) {
  const staged = [];
  const installed = [];
  try {
    for (const entry of entries) {
      staged.push({
        ...entry,
        temporary: await stageReplacement(entry.target, entry.replacement),
      });
    }
    for (let index = 0; index < staged.length; index += 1) {
      const entry = staged[index];
      if (beforeInstall) {
        await beforeInstall({ index, target: entry.target });
      }
      await fs.rename(entry.temporary, entry.target);
      installed.push(entry);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const entry of installed.reverse()) {
      let recovery = null;
      try {
        recovery = await stageReplacement(entry.target, entry.original);
        await fs.rename(recovery, entry.target);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      } finally {
        if (recovery !== null) {
          await fs.rm(recovery, { force: true }).catch(() => undefined);
        }
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        "codex-web patch transaction recovery failed",
      );
    }
    throw error;
  } finally {
    await Promise.allSettled(
      staged.map((entry) => fs.rm(entry.temporary, { force: true })),
    );
  }
}

async function applyStatusBridgeLocked({ codexWebRoot, revision = null } = {}) {
  if (typeof codexWebRoot !== "string" || !path.isAbsolute(codexWebRoot)) {
    throw new Error("codex-web root must be an absolute path");
  }
  if (revision !== EXPECTED_CODEX_WEB_REVISION) {
    throw new Error("codex-web revision is not supported");
  }
  const mainPath = path.join(codexWebRoot, "src", "server", "main.ts");
  const shimPath = path.join(codexWebRoot, "src", "browser", "shim.ts");
  const filesPath = path.join(codexWebRoot, "src", "browser", "files.ts");
  const vitePath = path.join(codexWebRoot, "vite.browser.config.ts");
  const targetServerOverlay = path.join(codexWebRoot, "src", "server", "router-status-bridge.ts");
  const targetAccountManagementOverlay = path.join(
    codexWebRoot,
    "src",
    "server",
    "router-account-management.ts",
  );
  const targetBrowserOverlay = path.join(codexWebRoot, "src", "browser", "router-account-panel.ts");
  const targetBrowserAuthOverlay = path.join(
    codexWebRoot,
    "src",
    "server",
    "browser-session-auth.ts",
  );
  const targetBrowserSessionOverlay = path.join(
    codexWebRoot,
    "src",
    "browser",
    "browser-session.ts",
  );
  const targetBrowserUploadStoreOverlay = path.join(
    codexWebRoot,
    "src",
    "server",
    "browser-upload-store.ts",
  );
  const targetBrowserIpcRouterOverlay = path.join(
    codexWebRoot,
    "src",
    "server",
    "browser-ipc-router.ts",
  );
  const targetPreferredContentEncodingOverlay = path.join(
    codexWebRoot,
    "src",
    "server",
    "preferred-content-encoding.ts",
  );
  const targetBrowserMessagePolicyOverlay = path.join(
    codexWebRoot,
    "src",
    "browser",
    "browser-message-policy.ts",
  );
  const originalMain = await fs.readFile(mainPath, "utf8");
  if (digest(originalMain) !== EXPECTED_MAIN_SHA256) {
    throw new Error("codex-web main source does not match the pinned revision");
  }
  const originalShim = await fs.readFile(shimPath, "utf8");
  if (digest(originalShim) !== EXPECTED_SHIM_SHA256) {
    throw new Error("codex-web browser shim does not match the pinned revision");
  }
  const originalFiles = await fs.readFile(filesPath, "utf8");
  if (digest(originalFiles) !== EXPECTED_FILES_SHA256) {
    throw new Error("codex-web browser files source does not match the pinned revision");
  }
  let originalVite = null;
  try {
    originalVite = await fs.readFile(vitePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (originalVite !== null && digest(originalVite) !== EXPECTED_VITE_SHA256) {
    throw new Error("codex-web Vite source does not match the pinned revision");
  }
  const importAnchor = 'import { glob } from "glob";';
  const registrationAnchor = "  const app = Fastify({ logger: false });";
  const browserImportAnchor = 'import {\n  openSelectWorkspaceRootDialog,\n  type WorkspaceDirectoryEntries,\n} from "./workspace-root-dialog";';
  const browserInstallAnchor = "ensureSocket();\n\nexport const contextBridge";
  let patchedMain = replaceOnce(
    originalMain,
    'import fs from "node:fs/promises";',
    'import { createReadStream } from "node:fs";\nimport fs from "node:fs/promises";',
    "server import",
  );
  patchedMain = replaceOnce(
    patchedMain,
    importAnchor,
    `${importAnchor}\nimport { BrowserIpcRouter } from "./browser-ipc-router";\nimport { registerRouterAccountManagement } from "./router-account-management";\nimport { registerBrowserSessionAuth } from "./browser-session-auth";\nimport { BROWSER_UPLOAD_LIMITS, BrowserUploadStore, isBrowserUploadLimitError } from "./browser-upload-store";\nimport { preferBrotliAcceptEncoding } from "./preferred-content-encoding";\nimport { registerRouterStatusBridge } from "./router-status-bridge";`,
    "server import",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `type RendererToMainMessage =
  | {`,
    `type RendererToMainMessage =
  | {
      type: "ipc-renderer-ready";
    }
  | {`,
    "server renderer-ready message",
  );
  patchedMain = replaceOnce(
    patchedMain,
    registrationAnchor,
    `${registrationAnchor}
  const browserSessionAuth = await registerBrowserSessionAuth(app, process.env);
  const browserUploadStore = await BrowserUploadStore.create(process.env);
  const unbindUploadCleanup = browserSessionAuth.onSessionRevoked(
    (sessionId) => {
      void browserUploadStore.removeSession(sessionId);
    },
  );
  app.addHook("onClose", async () => {
    unbindUploadCleanup();
    await browserUploadStore.close();
  });
  await registerRouterStatusBridge(app, process.env);
  await registerRouterAccountManagement(app, process.env);`,
    "server registration",
  );
  patchedMain = replaceOnce(
    patchedMain,
    "  const websocketServer = new WebSocketServer({ noServer: true });",
    "  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });",
    "websocket payload limit",
  );
  patchedMain = replaceOnce(
    patchedMain,
    "  const sockets = new Set<WebSocket>();",
    `  const sockets = new Set<WebSocket>();
  const browserIpcRouter = new BrowserIpcRouter(
    browserSessionAuth.authorizeRendererEvent,
    browserSessionAuth.limitRemoteHistory,
  );`,
    "browser IPC router",
  );
  patchedMain = replaceOnce(
    patchedMain,
    "      fileSize: Infinity,",
    `      fileSize: BROWSER_UPLOAD_LIMITS.fileBytes,
      files: BROWSER_UPLOAD_LIMITS.requestFiles,
      parts: BROWSER_UPLOAD_LIMITS.requestFiles + 2,`,
    "multipart limits",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );`,
    "",
    "temporary upload root",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });`,
    `  app.post("/__backend/upload", async (request, reply) => {
    const sessionId = browserSessionAuth.sessionIdForRequest(request);
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const uploadedPaths: string[] = [];
    let requestBytes = 0;
    try {
      const files = await Array.fromAsync(
        (async function* () {
          for await (const part of request.files()) {
            if (uploadedPaths.length >= BROWSER_UPLOAD_LIMITS.requestFiles) {
              throw new Error("browser upload request file limit exceeded");
            }
            const metadata = await browserUploadStore.write(
              sessionId,
              part.file,
              part.mimetype,
              BROWSER_UPLOAD_LIMITS.requestBytes - requestBytes,
            );
            uploadedPaths.push(metadata.path);
            requestBytes += metadata.size;
            yield {
              label: part.filename?.trim() || "upload",
              path: metadata.path,
              fsPath: metadata.path,
            };
          }
        })(),
      );
      return reply.send({ files });
    } catch (error) {
      await browserUploadStore.removePaths(sessionId, uploadedPaths);
      const statusCode = isBrowserUploadLimitError(error) ? 413 : 500;
      return reply.code(statusCode).send({
        error:
          statusCode === 413
            ? "upload_limits_exceeded"
            : "upload_failed",
      });
    }
  });`,
    "streaming upload",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });`,
    `  app.get<{ Params: { "*": string } }>("/@fs/*", async (request, reply) => {
    const wildcardPath = request.params["*"];
    const requestedPath = wildcardPath.startsWith("/")
      ? wildcardPath
      : "/" + wildcardPath;
    const resolvedPath = path.resolve("/", requestedPath);
    const metadata = browserUploadStore.find(
      resolvedPath,
      browserSessionAuth.sessionIdForRequest(request),
    );
    if (metadata === null) {
      return reply.code(404).send({ error: "Not Found" });
    }
    let stat;
    try {
      stat = await fs.lstat(resolvedPath);
    } catch {
      return reply.code(404).send({ error: "Not Found" });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return reply.code(404).send({ error: "Not Found" });
    }
    reply.header("x-content-type-options", "nosniff");
    if (metadata.contentType === "application/octet-stream") {
      reply.header("content-disposition", "attachment");
    }
    return reply.type(metadata.contentType).send(createReadStream(resolvedPath));
  });`,
    "file allowlist",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
    prefix: "/",
  });`,
    `  app.addHook("onRequest", async (request) => {
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      request.url.startsWith("/assets/") &&
      typeof request.headers["accept-encoding"] === "string"
    ) {
      request.headers["accept-encoding"] = preferBrotliAcceptEncoding(
        request.headers["accept-encoding"],
      );
    }
  });

  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
    prefix: "/",
    preCompressed: true,
    maxAge: "1y",
    immutable: true,
  });

  const browserIndexPath = path.resolve(
    __dirname,
    "../../scratch/asar/webview/index.html",
  );
  const originalBrowserIndex = await fs.readFile(browserIndexPath, "utf8");
  const unversionedPreload = 'src="./assets/preload.js"';
  const versionedPreloads = originalBrowserIndex.match(
    /src="\\.\\/assets\\/preload-[a-f0-9]{8}\\.js"/gu,
  ) ?? [];
  const unversionedCount = originalBrowserIndex.split(unversionedPreload).length - 1;
  let browserIndexWithCacheKey: string;
  if (unversionedCount === 1 && versionedPreloads.length === 0) {
    browserIndexWithCacheKey = originalBrowserIndex.replace(
      unversionedPreload,
      'src="./assets/preload.js?v=m6-8-startup-chat-r8"',
    );
  } else if (unversionedCount === 0 && versionedPreloads.length === 1) {
    browserIndexWithCacheKey = originalBrowserIndex;
  } else {
    throw new Error("codex-web browser preload anchor is unavailable");
  }

  const transparentBackground = "--startup-background: transparent;";
  const stagedBackground = "--startup-background: rgb(248 248 248);";
  const canvasBackground = "--startup-background: Canvas;";
  const backgroundCounts = [transparentBackground, stagedBackground, canvasBackground]
    .map((anchor) => browserIndexWithCacheKey.split(anchor).length - 1);
  if (backgroundCounts.reduce((total, count) => total + count, 0) !== 1) {
    throw new Error("codex-web startup background anchor is unavailable");
  }
  const browserIndexWithBackground = backgroundCounts[0] === 1
    ? browserIndexWithCacheKey.replace(transparentBackground, canvasBackground)
    : browserIndexWithCacheKey;
  const startupProbeScript = '<script src="/__backend/startup-probe.js"></script>';
  if (browserIndexWithBackground.includes(startupProbeScript)) {
    throw new Error("codex-web browser startup probe anchor is unavailable");
  }
  const preloadSource: string = unversionedCount === 1
    ? 'src="./assets/preload.js?v=m6-8-startup-chat-r8"'
    : versionedPreloads[0]!;
  const preloadSourceIndex = browserIndexWithBackground.indexOf(preloadSource);
  const preloadLineStart = browserIndexWithBackground.lastIndexOf("\\n", preloadSourceIndex) + 1;
  if (preloadSourceIndex < 0 || preloadLineStart < 0) {
    throw new Error("codex-web browser startup probe anchor is unavailable");
  }
  const indentation = browserIndexWithBackground
    .slice(preloadLineStart, preloadSourceIndex)
    .match(/^[ \\t]*/u)?.[0] ?? "";
  const browserIndexHtml =
    browserIndexWithBackground.slice(0, preloadLineStart) +
    indentation + startupProbeScript + "\\n" +
    browserIndexWithBackground.slice(preloadLineStart);
  const sendBrowserIndex = (reply: import("fastify").FastifyReply) =>
    reply.type("text/html; charset=utf-8").send(browserIndexHtml);`,
    "browser preload cache key",
  );
  patchedMain = replaceAllExactly(
    patchedMain,
    'return reply.sendFile("index.html");',
    "return sendBrowserIndex(reply);",
    2,
    "browser index response",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, \`http://\${host}\`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });`,
    `    const requestUrl = request.url ?? "/";
    const authorization = browserSessionAuth.authorizeWebSocket(request);
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
    });`,
    "websocket authorization",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };`,
    `  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    browserIpcRouter.routeMainMessage(message);
  };`,
    "renderer event routing",
  );
  patchedMain = replaceOnce(
    patchedMain,
    '  websocketServer.on("connection", (socket) => {\n    sockets.add(socket);',
    `  websocketServer.on("connection", (socket, request) => {
    const authorization = browserSessionAuth.authorizeWebSocket(request);
    if (!authorization.ok) {
      socket.close(1008, "session unavailable");
      return;
    }
    const unbindSessionSocket = browserSessionAuth.bindWebSocket(
      authorization.sessionId,
      socket,
    );
    sockets.add(socket);
    browserIpcRouter.addSocket(socket);`,
    "websocket session binding",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `    socket.on("close", () => {
      sockets.delete(socket);
    });`,
    `    socket.on("close", () => {
      unbindSessionSocket();
      sockets.delete(socket);
      browserIpcRouter.removeSocket(socket);
    });`,
    "websocket session cleanup",
  );
  patchedMain = replaceOnce(
    patchedMain,
    `      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "ipc-renderer-send") {`,
    `      } catch {
        socket.close(1007, "invalid message");
        return;
      }
      if (!browserSessionAuth.authorizeRendererMessage(message)) {
        socket.close(1008, "request not permitted");
        return;
      }
      if (message.type === "ipc-renderer-ready") {
        if (!browserIpcRouter.markTransportReady(socket)) {
          socket.close(1008, "duplicate renderer ready");
        }
        return;
      }
      if (!browserIpcRouter.trackRendererMessage(socket, message)) {
        socket.close(1008, "request state conflict");
        return;
      }

      if (message.type === "ipc-renderer-send") {`,
    "renderer authorization",
  );
  patchedMain = replaceOnce(
    patchedMain,
    "        getWorkspaceDirectoryEntries(message)\n          .then((result) => {",
    `        browserSessionAuth
          .resolveWorkspaceDirectory(message.directoryPath)
          .then((directoryPath) =>
            getWorkspaceDirectoryEntries({ ...message, directoryPath }),
          )
          .then((result) => {`,
    "workspace authorization",
  );
  patchedMain = replaceAllExactly(
    patchedMain,
    `.catch((error) => {
            const payload: MainToRendererMessage = {`,
    `.catch((error) => {
            browserIpcRouter.cancelRendererMessage(socket, message);
            const payload: MainToRendererMessage = {`,
    2,
    "failed request cleanup",
  );
  patchedMain = replaceAllExactly(
    patchedMain,
    `            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }`,
    `            browserIpcRouter.sendDirect(socket, payload);`,
    4,
    "direct renderer response",
  );
  patchedMain = replaceAllExactly(
    patchedMain,
    "errorMessage(error)",
    '"Request failed"',
    2,
    "renderer error redaction",
  );

  let patchedShim = replaceOnce(
    originalShim,
    browserImportAnchor,
    `${browserImportAnchor}\nimport { classifyBrowserMessage } from "./browser-message-policy";\nimport { installBrowserFetchPolicy } from "./browser-session";\nimport { installRouterAccountPanel } from "./router-account-panel";`,
    "browser import",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";`,
    'import { handleLocalFilePickerMessage } from "./files";',
    "browser file import",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `type RendererToMainMessage =
  | {`,
    `type RendererToMainMessage =
  | {
      type: "ipc-renderer-ready";
    }
  | {`,
    "browser renderer-ready message",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;`,
    `declare const __CODEX_APP_VERSION__: string;

const BROWSER_CONFIG_DEADLINE_MS = 10_000;
const MAX_OUTBOUND_QUEUE = 1_024;
const MAX_PENDING_INVOKES = 4_096;
const LOCAL_NOOP_INVOKE_CHANNELS = new Set([
  "codex_desktop:show-application-menu",
  "codex_desktop:show-context-menu",
  "codex_desktop:trigger-sentry-test",
]);
const LOCAL_DISABLED_INVOKE_CHANNELS = new Set([
  "codex_desktop:connect-app-host",
]);
const SERVER_GIT_INVOKE_CHANNEL = "codex_desktop:worker:git:from-view";

type BrowserConfig = {
  codexHome: string;
  workspaceRoots: string[];
};

function installRandomUuidPolyfill(): void {
  const webCrypto = globalThis.crypto;
  if (
    typeof webCrypto?.randomUUID === "function" ||
    typeof webCrypto?.getRandomValues !== "function"
  ) {
    return;
  }
  Object.defineProperty(webCrypto, "randomUUID", {
    configurable: true,
    value: (): \`\${string}-\${string}-\${string}-\${string}-\${string}\` => {
      const bytes = webCrypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(
        12,
        16,
      )}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
    },
    writable: false,
  });
}

installRandomUuidPolyfill();
installBrowserFetchPolicy();

let requestCounter = 0;`,
    "browser random UUID support",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];`,
    `let requestCounter = 0;
let socket: WebSocket | null = null;
let readyAnnouncedSocket: WebSocket | null = null;
let viewReady = false;
let viewReadyAnnouncedSocket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
let browserConfigPromise: Promise<BrowserConfig> | null = null;
let browserWorkspaceRootsInitialized = false;
const browserWorkspaceRoots = new Set<string>();
const outboundQueue: RendererToMainMessage[] = [];`,
    "browser bridge state",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();`,
    `    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
    socket: WebSocket | null;
  }
>();`,
    "browser invoke socket tracking",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();`,
    `    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
    socket: WebSocket | null;
  }
>();`,
    "browser directory socket tracking",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}`,
    `function markMessageSent(
  message: RendererToMainMessage,
  targetSocket: WebSocket,
): void {
  if (
    message.type === "ipc-renderer-invoke" ||
    message.type === "workspace-directory-entries-request"
  ) {
    const pending =
      message.type === "ipc-renderer-invoke"
        ? pendingInvokes.get(message.requestId)
        : pendingDirectoryEntries.get(message.requestId);
    if (pending) {
      pending.socket = targetSocket;
    }
  }
}

function flushOutboundQueue(): void {
  const currentSocket = socket;
  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    markMessageSent(message, currentSocket);
    currentSocket.send(JSON.stringify(message));
  }
}

function announceRendererReady(): void {
  const currentSocket = socket;
  if (
    !currentSocket ||
    currentSocket.readyState !== WebSocket.OPEN ||
    readyAnnouncedSocket === currentSocket
  ) {
    return;
  }
  currentSocket.send(JSON.stringify({ type: "ipc-renderer-ready" }));
  readyAnnouncedSocket = currentSocket;
}

function announceViewReady(): void {
  const currentSocket = socket;
  if (
    !viewReady ||
    !currentSocket ||
    currentSocket.readyState !== WebSocket.OPEN ||
    viewReadyAnnouncedSocket === currentSocket
  ) {
    return;
  }
  currentSocket.send(
    JSON.stringify({
      type: "ipc-renderer-invoke",
      requestId: nextRequestId(),
      channel: "codex_desktop:message-from-view",
      args: [{ type: "ready" }],
    }),
  );
  viewReadyAnnouncedSocket = currentSocket;
}

function rejectPendingForSocket(closedSocket: WebSocket): void {
  for (const [requestId, pending] of pendingInvokes) {
    if (pending.socket === closedSocket) {
      pendingInvokes.delete(requestId);
      pending.reject(new Error("[electron-stub] IPC bridge disconnected"));
    }
  }
  for (const [requestId, pending] of pendingDirectoryEntries) {
    if (pending.socket === closedSocket) {
      pendingDirectoryEntries.delete(requestId);
      pending.reject(new Error("[electron-stub] IPC bridge disconnected"));
    }
  }
}`,
    "browser outbound routing",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(
    \`\${window.location.protocol === "https:" ? "wss:" : "ws:"}//\${window.location.host}/__backend/ipc\`,
  );
  socket.addEventListener("open", () => {
    flushOutboundQueue();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  socket.addEventListener("close", () => {
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}`,
    `function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const nextSocket = new WebSocket(
    \`\${window.location.protocol === "https:" ? "wss:" : "ws:"}//\${window.location.host}/__backend/ipc\`,
    "codex-ipc.v1",
  );
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    announceRendererReady();
    announceViewReady();
    flushOutboundQueue();
  });
  nextSocket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch {
      nextSocket.close(1007, "invalid bridge response");
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket === nextSocket) {
      socket = null;
    }
    if (readyAnnouncedSocket === nextSocket) {
      readyAnnouncedSocket = null;
    }
    if (viewReadyAnnouncedSocket === nextSocket) {
      viewReadyAnnouncedSocket = null;
    }
    rejectPendingForSocket(nextSocket);
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    scheduleReconnect();
  });
}`,
    "browser websocket lifecycle",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}`,
    `function enqueueMessage(message: RendererToMainMessage): void {
  if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) {
    throw new Error("[electron-stub] IPC bridge queue is full");
  }
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}`,
    "browser outbound queue bound",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}`,
    `function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    if (pendingInvokes.size >= MAX_PENDING_INVOKES) {
      reject(new Error("[electron-stub] too many pending IPC requests"));
      return;
    }
    pendingInvokes.set(requestId, { resolve, reject, socket: null });
    try {
      enqueueMessage({
        type: "ipc-renderer-invoke",
        requestId,
        channel,
        args,
      });
    } catch (error) {
      pendingInvokes.delete(requestId);
      reject(error);
    }
  });
}`,
    "browser invoke bound",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });`,
    `  return new Promise((resolve, reject) => {
    if (pendingDirectoryEntries.size >= MAX_PENDING_INVOKES) {
      reject(new Error("[electron-stub] too many pending directory requests"));
      return;
    }
    pendingDirectoryEntries.set(requestId, {
      resolve,
      reject,
      socket: null,
    });
    try {
      enqueueMessage({
        type: "workspace-directory-entries-request",
        requestId,
        directoryPath,
        directoriesOnly: true,
      });
    } catch (error) {
      pendingDirectoryEntries.delete(requestId);
      reject(error);
    }
  });`,
    "browser directory request bound",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}`,
    `function isBrowserConfig(value: unknown): value is BrowserConfig {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") === "codexHome,workspaceRoots" &&
    typeof value.codexHome === "string" &&
    value.codexHome.startsWith("/") &&
    value.codexHome.length <= 4_096 &&
    Array.isArray(value.workspaceRoots) &&
    value.workspaceRoots.length >= 1 &&
    value.workspaceRoots.length <= 16 &&
    value.workspaceRoots.every(
      (root) =>
        typeof root === "string" &&
        root.startsWith("/") &&
        root.length <= 4_096,
    )
  );
}

async function loadBrowserConfig(): Promise<BrowserConfig> {
  browserConfigPromise ??= (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      BROWSER_CONFIG_DEADLINE_MS,
    );
    try {
      const response = await fetch("/__backend/browser-config", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const value = (await response.json()) as unknown;
      if (!response.ok || !isBrowserConfig(value)) {
        throw new Error("browser configuration is unavailable");
      }
      if (!browserWorkspaceRootsInitialized) {
        browserWorkspaceRootsInitialized = true;
        for (const root of value.workspaceRoots) {
          browserWorkspaceRoots.add(root);
        }
      }
      return value;
    } finally {
      window.clearTimeout(timeoutId);
    }
  })().catch((error) => {
    browserConfigPromise = null;
    throw error;
  });
  return browserConfigPromise;
}

function emitFetchSuccess(requestId: string, body: unknown): void {
  emitRendererEvent("codex_desktop:message-for-view", [
    {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify(body),
    },
  ]);
}

function emitFetchError(
  requestId: string,
  status: number,
  error: string,
): void {
  emitRendererEvent("codex_desktop:message-for-view", [
    {
      type: "fetch-response",
      responseType: "error",
      requestId,
      status,
      error,
    },
  ]);
}

function emitWorkspaceRootsUpdated(): void {
  emitRendererEvent("codex_desktop:message-for-view", [
    {
      type: "workspace-root-options-updated",
      hostId: "local",
    },
  ]);
}

async function validateWorkspaceRoot(root: string): Promise<string> {
  return (await requestWorkspaceDirectoryEntries(root)).directoryPath;
}

async function setBrowserWorkspaceRoots(roots: string[]): Promise<void> {
  const resolved = await Promise.all(roots.map(validateWorkspaceRoot));
  browserWorkspaceRootsInitialized = true;
  browserWorkspaceRoots.clear();
  for (const root of resolved) {
    browserWorkspaceRoots.add(root);
  }
  emitWorkspaceRootsUpdated();
}

async function addBrowserWorkspaceRoot(root: string): Promise<void> {
  const resolved = await validateWorkspaceRoot(root);
  await loadBrowserConfig();
  browserWorkspaceRoots.add(resolved);
  emitWorkspaceRootsUpdated();
}

async function handleLocalBrowserMessage(
  message: unknown,
): Promise<"server" | "handled"> {
  const disposition = classifyBrowserMessage(message);
  switch (disposition.kind) {
    case "server":
      return "server";
    case "local-noop":
      return "handled";
    case "local-persisted-sync":
      emitRendererEvent("codex_desktop:message-for-view", [
        { type: "persisted-atom-sync", state: {} },
      ]);
      return "handled";
    case "local-fetch-response":
      emitFetchSuccess(disposition.requestId, disposition.body);
      return "handled";
    case "local-fetch-error":
      emitFetchError(
        disposition.requestId,
        disposition.status,
        disposition.error,
      );
      return "handled";
    case "local-fetch-stream-error":
      emitRendererEvent("codex_desktop:message-for-view", [
        {
          type: "fetch-stream-error",
          requestId: disposition.requestId,
          error: disposition.error,
        },
      ]);
      return "handled";
    case "local-file-picker":
      await handleLocalFilePickerMessage(disposition.message);
      return "handled";
    case "local-mcp-error":
      emitRendererEvent("codex_desktop:message-for-view", [
        {
          type: "mcp-response",
          hostId: "local",
          message: {
            id: disposition.requestId,
            error: {
              code: -32_600,
              message: "Request not permitted in browser mode",
            },
          },
        },
      ]);
      return "handled";
    case "local-mcp-response":
      emitRendererEvent("codex_desktop:message-for-view", [
        {
          type: "mcp-response",
          hostId: "local",
          message: {
            id: disposition.requestId,
            result: disposition.result,
          },
        },
      ]);
      return "handled";
    case "open-external":
      window.open(disposition.url, "_blank", "noopener,noreferrer");
      return "handled";
    case "request-browser-config":
      try {
        const config = await loadBrowserConfig();
        emitFetchSuccess(
          disposition.requestId,
          disposition.field === "codexHome"
            ? {
                codexHome: config.codexHome,
                worktreesSegment:
                  config.codexHome.replace(/\\/$/u, "") + "/worktrees",
              }
            : {
                roots: [...browserWorkspaceRoots],
                labels: {},
                canonicalPathByRoot: {},
              },
        );
      } catch {
        emitFetchError(
          disposition.requestId,
          503,
          "browser_configuration_unavailable",
        );
      }
      return "handled";
    case "local-workspace-root-add":
      await addBrowserWorkspaceRoot(disposition.root);
      return "handled";
    case "local-workspace-roots-update":
      await setBrowserWorkspaceRoots(disposition.roots);
      return "handled";
    case "reject":
      throw new Error("[electron-stub] browser message is not permitted");
  }
}`,
    "browser message runtime",
  );
  patchedShim = replaceOnce(
    patchedShim,
    `  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },`,
    `  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (LOCAL_NOOP_INVOKE_CHANNELS.has(channel)) {
      return Promise.resolve(undefined);
    }
    if (LOCAL_DISABLED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(
        new Error("[electron-stub] channel unavailable in browser mode"),
      );
    }
    if (channel === SERVER_GIT_INVOKE_CHANNEL && args.length === 1) {
      return invokeMain(channel, args);
    }
    if (channel !== "codex_desktop:message-from-view" || args.length !== 1) {
      return invokeMain(channel, args);
    }
    const message = args[0];
    if (isUnhandledAddWorkspaceRootOptionMessage(message)) {
      return openSelectWorkspaceRootDialog({
        listDirectory: requestWorkspaceDirectoryEntries,
      }).then(async (root) => {
        if (root) {
          await addBrowserWorkspaceRoot(root);
        }
        return undefined;
      });
    }
    return handleLocalBrowserMessage(message).then((result) => {
      if (result === "handled") {
        return undefined;
      }
      if (isRecord(message) && message.type === "ready") {
        viewReady = true;
        announceViewReady();
        return undefined;
      }
      return invokeMain(channel, args);
    });
  },`,
    "browser message dispatch",
  );
  patchedShim = replaceOnce(
    patchedShim,
    browserInstallAnchor,
    "ensureSocket();\nvoid installRouterAccountPanel();\n\nexport const contextBridge",
    "browser install",
  );

  let patchedFiles = replaceOnce(
    originalFiles,
    'import { emitRendererEvent, isRecord } from "./shim";',
    'import { emitRendererEvent, isRecord } from "./shim";\nimport { browserCsrfHeaders } from "./browser-session.js";',
    "browser upload import",
  );
  patchedFiles = replaceOnce(
    patchedFiles,
    `  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });`,
    `  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: await browserCsrfHeaders(),
    body: formData,
  });`,
    "browser upload csrf",
  );
  let patchedVite = null;
  if (originalVite !== null) {
    patchedVite = replaceOnce(
      originalVite,
      'import { readFileSync } from "node:fs";',
      'import { readFileSync } from "node:fs";\nimport { gzipSync } from "node:zlib";',
      "Vite gzip import",
    );
    patchedVite = replaceOnce(
      patchedVite,
      `  build: {`,
      `  plugins: [
    {
      name: "codex-web-precompress-browser-entry",
      generateBundle(_outputOptions, bundle) {
        const entry = bundle["preload.js"];
        if (!entry || entry.type !== "chunk") {
          throw new Error("codex-web browser entry is unavailable");
        }
        this.emitFile({
          type: "asset",
          fileName: "preload.js.gz",
          source: gzipSync(Buffer.from(entry.code), { level: 9 }),
        });
        const startupEntryName = "index-LQUNCOO3.js";
        const startupEntry = readFileSync(
          path.resolve(webviewRoot, "assets", startupEntryName),
          "utf8",
        );
        const dependencyPrefix = "m.f||(m.f=";
        const dependencyStart = startupEntry.indexOf(dependencyPrefix);
        const dependencyEnd = startupEntry.indexOf(
          ")))=>",
          dependencyStart,
        );
        if (dependencyStart < 0 || dependencyEnd < 0) {
          throw new Error("codex-web startup dependency manifest is unavailable");
        }
        const parsedDependencies = JSON.parse(
          startupEntry.slice(
            dependencyStart + dependencyPrefix.length,
            dependencyEnd,
          ),
        ) as unknown;
        if (
          !Array.isArray(parsedDependencies) ||
          parsedDependencies.length > 256 ||
          !parsedDependencies.every(
            (value) =>
              typeof value === "string" &&
              value.startsWith("./") &&
              /^[A-Za-z0-9._~-]+\\.(?:css|js)$/u.test(value.slice(2)),
          )
        ) {
          throw new Error("codex-web startup dependency manifest is unsafe");
        }
        const startupAssetNames = new Set([
          startupEntryName,
          "index-LQUNCOO3.js",
          "rolldown-runtime-Czos8NxU.js",
          "modulepreload-polyfill-D8LKdSkT.js",
          ...parsedDependencies.map((value) => value.slice(2)),
        ]);
        for (const fileName of startupAssetNames) {
          const source = readFileSync(path.resolve(webviewRoot, "assets", fileName));
          this.emitFile({
            type: "asset",
            fileName: \`\${fileName}.gz\`,
            source: gzipSync(source, { level: 9 }),
          });
        }
      },
    },
  ],
  build: {`,
      "Vite gzip plugin",
    );
    patchedVite = replaceOnce(
      patchedVite,
      "    minify: false,",
      '    minify: "oxc",',
      "Vite routed preload minifier",
    );
  }

  const overlayCopies = [
    [serverOverlaySource, targetServerOverlay],
    [accountManagementOverlaySource, targetAccountManagementOverlay],
    [browserOverlaySource, targetBrowserOverlay],
    [browserAuthOverlaySource, targetBrowserAuthOverlay],
    [browserSessionOverlaySource, targetBrowserSessionOverlay],
    [browserUploadStoreOverlaySource, targetBrowserUploadStoreOverlay],
    [browserIpcRouterOverlaySource, targetBrowserIpcRouterOverlay],
    [preferredContentEncodingOverlaySource, targetPreferredContentEncodingOverlay],
    [browserMessagePolicyOverlaySource, targetBrowserMessagePolicyOverlay],
  ];
  const copiedTargets = [];
  try {
    for (const [source, target] of overlayCopies) {
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      copiedTargets.push(target);
    }
  } catch (error) {
    await Promise.allSettled(
      copiedTargets.map((target) => fs.rm(target, { force: true })),
    );
    throw error;
  }
  try {
    await replaceFilesRecoverably([
      {
        target: mainPath,
        original: originalMain,
        replacement: patchedMain,
      },
      {
        target: shimPath,
        original: originalShim,
        replacement: patchedShim,
      },
      {
        target: filesPath,
        original: originalFiles,
        replacement: patchedFiles,
      },
      ...(patchedVite === null
        ? []
        : [
            {
              target: vitePath,
              original: originalVite,
              replacement: patchedVite,
            },
          ]),
    ]);
  } catch (error) {
    await Promise.allSettled([
      ...copiedTargets.map((target) => fs.rm(target, { force: true })),
    ]);
    throw error;
  }
}

export async function applyStatusBridge(options = {}) {
  const { codexWebRoot } = options;
  if (typeof codexWebRoot !== "string" || !path.isAbsolute(codexWebRoot)) {
    throw new Error("codex-web root must be an absolute path");
  }
  const lockPath = path.join(codexWebRoot, ".codex-web-status-bridge.lock");
  let lock;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("codex-web status bridge patch is already in progress");
  }
  try {
    return await applyStatusBridgeLocked(options);
  } finally {
    await lock.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true });
  }
}

async function cli() {
  const codexWebRoot = process.argv[2];
  if (!codexWebRoot || !path.isAbsolute(codexWebRoot)) {
    throw new Error("usage: apply-status-bridge.mjs /absolute/path/to/codex-web");
  }
  const revision = spawnSync("git", ["-C", codexWebRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (revision.status !== 0) throw new Error("codex-web revision is unavailable");
  await applyStatusBridge({ codexWebRoot, revision: revision.stdout.trim() });
  process.stdout.write("codex-web optional router integration applied\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(() => {
    process.stderr.write("codex-web optional status bridge could not be applied\n");
    process.exitCode = 1;
  });
}
