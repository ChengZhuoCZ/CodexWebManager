import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} anchor is unavailable or ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function installPersistentUploads(source, options = {}) {
  let output = replaceOnce(
    source,
    'const node_crypto_1 = require("node:crypto");',
    'const node_crypto_1 = require("node:crypto");\nconst node_fs_1 = require("node:fs");',
    "filesystem stream import",
  );
  output = replaceOnce(
    output,
    'const browser_session_auth_1 = require("./browser-session-auth");',
    'const browser_session_auth_1 = require("./browser-session-auth");\nconst browser_upload_store_1 = require("./browser-upload-store");',
    "upload store import",
  );
  output = replaceOnce(
    output,
    '    await (0, browser_session_auth_1.registerBrowserSessionAuth)(app, process.env);',
    `    const browserSessionAuth = await (0, browser_session_auth_1.registerBrowserSessionAuth)(app, process.env);
    const browserUploadStore = await browser_upload_store_1.BrowserUploadStore.create(process.env);
    const unbindUploadCleanup = browserSessionAuth.onSessionRevoked((sessionId) => {
        void browserUploadStore.removeSession(sessionId);
    });
    app.addHook("onClose", async () => {
        unbindUploadCleanup();
        await browserUploadStore.close();
    });`,
    "browser auth registration",
  );
  const temporaryUploadImplementation =
    options.temporaryUploadImplementation ??
    `    await app.register(multipart_1.default, {
        limits: {
            fileSize: Infinity,
        },
    });
    const uploadRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "codex-web-uploads-"));
    app.post("/__backend/upload", async (request, reply) => {
        if (!request.isMultipart()) {
            return reply.code(400).send({ error: "expected multipart upload body" });
        }
        const files = await Array.fromAsync((async function* () {
            for await (const part of request.files()) {
                const label = part.filename?.trim() || "upload";
                const uploadedPath = node_path_1.default.join(uploadRoot, (0, node_crypto_1.randomUUID)());
                await promises_1.default.writeFile(uploadedPath, await part.toBuffer());
                yield {
                    label,
                    path: uploadedPath,
                    fsPath: uploadedPath,
                };
            }
        })());
        return reply.send({ files });
    });
    await app.register(static_1.default, {
        root: "/",
        prefix: "/@fs/",
        decorateReply: false,
    });`;
  output = replaceOnce(
    output,
    temporaryUploadImplementation,
    `    await app.register(multipart_1.default, {
        limits: {
            fileSize: browser_upload_store_1.BROWSER_UPLOAD_LIMITS.fileBytes,
            files: browser_upload_store_1.BROWSER_UPLOAD_LIMITS.requestFiles,
            parts: browser_upload_store_1.BROWSER_UPLOAD_LIMITS.requestFiles + 2,
        },
    });
    app.post("/__backend/upload", async (request, reply) => {
        const sessionId = browserSessionAuth.sessionIdForRequest(request);
        if (!request.isMultipart()) {
            return reply.code(400).send({ error: "expected multipart upload body" });
        }
        const uploadedPaths = [];
        let requestBytes = 0;
        try {
            const files = await Array.fromAsync((async function* () {
                for await (const part of request.files()) {
                    if (uploadedPaths.length >= browser_upload_store_1.BROWSER_UPLOAD_LIMITS.requestFiles) {
                        throw new Error("browser upload request file limit exceeded");
                    }
                    const metadata = await browserUploadStore.write(sessionId, part.file, part.mimetype, browser_upload_store_1.BROWSER_UPLOAD_LIMITS.requestBytes - requestBytes);
                    uploadedPaths.push(metadata.path);
                    requestBytes += metadata.size;
                    yield {
                        label: part.filename?.trim() || "upload",
                        path: metadata.path,
                        fsPath: metadata.path,
                    };
                }
            })());
            return reply.send({ files });
        }
        catch (error) {
            await browserUploadStore.removePaths(sessionId, uploadedPaths);
            const statusCode = (0, browser_upload_store_1.isBrowserUploadLimitError)(error) ? 413 : 500;
            return reply.code(statusCode).send({
                error: statusCode === 413 ? "upload_limits_exceeded" : "upload_failed",
            });
        }
    });
    app.get("/@fs/*", async (request, reply) => {
        const wildcardPath = request.params["*"];
        const requestedPath = wildcardPath.startsWith("/") ? wildcardPath : "/" + wildcardPath;
        const resolvedPath = node_path_1.default.resolve("/", requestedPath);
        const metadata = browserUploadStore.find(resolvedPath, browserSessionAuth.sessionIdForRequest(request));
        if (metadata === null) {
            return reply.code(404).send({ error: "Not Found" });
        }
        return reply.type(metadata.contentType).send((0, node_fs_1.createReadStream)(metadata.path));
    });`,
    "temporary upload implementation",
  );
  return output;
}

async function main() {
  const candidateIndex = process.argv.indexOf("--candidate");
  const storeIndex = process.argv.indexOf("--upload-store");
  if (candidateIndex < 0 || storeIndex < 0) {
    throw new Error("usage: replace-r108-persistent-uploads.mjs --candidate <release> --upload-store <file>");
  }
  const candidate = path.resolve(process.argv[candidateIndex + 1] ?? "");
  const storeSource = path.resolve(process.argv[storeIndex + 1] ?? "");
  const mainPath = path.join(candidate, "src/server/main.js");
  const targetStore = path.join(candidate, "src/server/browser-upload-store.js");
  const source = await fs.readFile(mainPath, "utf8");
  const output = installPersistentUploads(source);
  await fs.writeFile(mainPath, output, { mode: 0o644 });
  await fs.copyFile(storeSource, targetStore);
  await fs.chmod(targetStore, 0o644);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
