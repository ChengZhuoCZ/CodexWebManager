"use strict";

const { randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const BROWSER_UPLOAD_LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  requestBytes: 64 * 1024 * 1024,
  requestFiles: 4,
  sessionBytes: 128 * 1024 * 1024,
  sessionFiles: 16,
  globalBytes: 256 * 1024 * 1024,
  globalFiles: 64,
});

const COMPLETED_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PARTIAL_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/u;

class BrowserUploadLimitError extends Error {
  constructor() {
    super("browser upload limit exceeded");
    this.name = "BrowserUploadLimitError";
  }
}

class ByteLimitTransform extends Transform {
  constructor(maximumBytes) {
    super();
    this.maximumBytes = maximumBytes;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    const length = Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(chunk, encoding);
    if (this.bytes + length > this.maximumBytes) {
      callback(new BrowserUploadLimitError());
      return;
    }
    this.bytes += length;
    callback(null, chunk);
  }
}

function emptyUsage() {
  return {
    bytes: 0,
    files: 0,
    reservedBytes: 0,
    reservedFiles: 0,
  };
}

function safeUploadContentType(contentType) {
  const normalized = String(contentType ?? "").trim().toLowerCase();
  return new Set([
    "application/pdf",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
  ]).has(normalized)
    ? normalized
    : "application/octet-stream";
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function isBrowserUploadLimitError(error) {
  if (error instanceof BrowserUploadLimitError) {
    return true;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return new Set([
    "FST_FILES_LIMIT",
    "FST_PARTS_LIMIT",
    "FST_REQ_FILE_TOO_LARGE",
  ]).has(String(error.code));
}

class BrowserUploadStore {
  constructor(root, persistFiles) {
    this.root = root;
    this.persistFiles = persistFiles;
    this.files = new Map();
    this.globalUsage = emptyUsage();
    this.inFlight = new Map();
    this.revokedSessions = new Set();
    this.sessionUsage = new Map();
  }

  static async create(environment) {
    const configuredRoot = environment.CODEX_WEB_UPLOAD_ROOT?.trim();
    if (
      !configuredRoot ||
      !path.isAbsolute(configuredRoot) ||
      path.resolve(configuredRoot) !== configuredRoot
    ) {
      throw new Error("codex web upload root is unavailable");
    }
    const configuredStat = await fs.lstat(configuredRoot);
    if (
      !configuredStat.isDirectory() ||
      configuredStat.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        configuredStat.uid !== process.getuid())
    ) {
      throw new Error("codex web upload root is not private");
    }
    const sharedRoot = await fs.realpath(configuredRoot);
    const stat = await fs.stat(sharedRoot);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("codex web upload root is not private");
    }

    const persistFiles = environment.CODEX_WEB_UPLOAD_PERSIST?.trim() === "1";
    if (persistFiles) {
      let retainedBytes = 0;
      let retainedFiles = 0;
      for (const entry of await fs.readdir(sharedRoot, { withFileTypes: true })) {
        const retainedPath = path.join(sharedRoot, entry.name);
        const retainedStat = await fs.lstat(retainedPath);
        if (
          !entry.isFile() ||
          retainedStat.isSymbolicLink() ||
          (retainedStat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            retainedStat.uid !== process.getuid()) ||
          (!COMPLETED_NAME.test(entry.name) && !PARTIAL_NAME.test(entry.name))
        ) {
          throw new Error("persistent browser upload root contains an unsafe entry");
        }
        if (PARTIAL_NAME.test(entry.name)) {
          await fs.rm(retainedPath, { force: true });
          continue;
        }
        retainedBytes += retainedStat.size;
        retainedFiles += 1;
      }
      if (
        retainedBytes > BROWSER_UPLOAD_LIMITS.globalBytes ||
        retainedFiles > BROWSER_UPLOAD_LIMITS.globalFiles
      ) {
        throw new Error("persistent browser upload root exceeds its storage limit");
      }
      const store = new BrowserUploadStore(sharedRoot, true);
      store.globalUsage.bytes = retainedBytes;
      store.globalUsage.files = retainedFiles;
      return store;
    }

    for (const entry of await fs.readdir(sharedRoot, { withFileTypes: true })) {
      if (!/^codex-web-[A-Za-z0-9]{6}$/u.test(entry.name)) {
        continue;
      }
      const stalePath = path.join(sharedRoot, entry.name);
      const staleStat = await fs.lstat(stalePath);
      if (
        !entry.isDirectory() ||
        staleStat.isSymbolicLink() ||
        (staleStat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          staleStat.uid !== process.getuid())
      ) {
        throw new Error("codex web upload root contains an unsafe stale entry");
      }
      await fs.rm(stalePath, { recursive: true, force: true });
    }
    const instanceRoot = await fs.mkdtemp(path.join(sharedRoot, "codex-web-"));
    await fs.chmod(instanceRoot, 0o700);
    return new BrowserUploadStore(instanceRoot, false);
  }

  async write(sessionId, source, contentType, maximumBytes) {
    if (this.revokedSessions.has(sessionId)) {
      throw new Error("browser upload session is unavailable");
    }
    const boundedMaximum = Math.min(
      BROWSER_UPLOAD_LIMITS.fileBytes,
      Math.max(0, Math.floor(maximumBytes)),
    );
    if (boundedMaximum === 0) {
      throw new BrowserUploadLimitError();
    }
    const session = this.sessionUsage.get(sessionId) ?? emptyUsage();
    if (!this.sessionUsage.has(sessionId)) {
      this.sessionUsage.set(sessionId, session);
    }
    const sessionRemaining = Math.min(
      BROWSER_UPLOAD_LIMITS.sessionBytes - session.bytes - session.reservedBytes,
      BROWSER_UPLOAD_LIMITS.globalBytes -
        this.globalUsage.bytes -
        this.globalUsage.reservedBytes,
    );
    const reservationBytes = Math.min(boundedMaximum, sessionRemaining);
    if (
      reservationBytes <= 0 ||
      session.files + session.reservedFiles >= BROWSER_UPLOAD_LIMITS.sessionFiles ||
      this.globalUsage.files + this.globalUsage.reservedFiles >=
        BROWSER_UPLOAD_LIMITS.globalFiles
    ) {
      throw new BrowserUploadLimitError();
    }

    session.reservedBytes += reservationBytes;
    session.reservedFiles += 1;
    this.globalUsage.reservedBytes += reservationBytes;
    this.globalUsage.reservedFiles += 1;
    const finalPath = path.join(this.root, randomUUID());
    const partialPath = `${finalPath}.part`;
    const counter = new ByteLimitTransform(reservationBytes);
    const controller = new AbortController();
    const sessionControllers = this.inFlight.get(sessionId) ?? new Set();
    sessionControllers.add(controller);
    this.inFlight.set(sessionId, sessionControllers);
    let metadata = null;
    try {
      await pipeline(
        source,
        counter,
        createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
        { signal: controller.signal },
      );
      if (this.revokedSessions.has(sessionId)) {
        throw new Error("browser upload session is unavailable");
      }
      await fs.rename(partialPath, finalPath);
      metadata = {
        contentType: safeUploadContentType(contentType),
        path: finalPath,
        sessionId,
        size: counter.bytes,
      };
      this.files.set(finalPath, metadata);
      session.bytes += counter.bytes;
      session.files += 1;
      this.globalUsage.bytes += counter.bytes;
      this.globalUsage.files += 1;
      return metadata;
    } finally {
      sessionControllers.delete(controller);
      if (sessionControllers.size === 0) {
        this.inFlight.delete(sessionId);
      }
      session.reservedBytes -= reservationBytes;
      session.reservedFiles -= 1;
      this.globalUsage.reservedBytes -= reservationBytes;
      this.globalUsage.reservedFiles -= 1;
      if (metadata === null) {
        await fs.rm(partialPath, { force: true }).catch(() => undefined);
        await fs.rm(finalPath, { force: true }).catch(() => undefined);
      }
      if (
        session.bytes === 0 &&
        session.files === 0 &&
        session.reservedBytes === 0 &&
        session.reservedFiles === 0
      ) {
        this.sessionUsage.delete(sessionId);
      }
    }
  }

  find(pathname, sessionId) {
    const resolved = path.resolve(pathname);
    if (!isWithinRoot(this.root, resolved)) {
      return null;
    }
    const metadata = this.files.get(resolved);
    return metadata?.sessionId === sessionId ? metadata : null;
  }

  async removePaths(sessionId, paths) {
    const removals = [];
    for (const pathname of paths) {
      const metadata = this.files.get(pathname);
      if (metadata?.sessionId !== sessionId) {
        continue;
      }
      this.files.delete(pathname);
      this.release(metadata);
      removals.push(pathname);
    }
    await Promise.allSettled(
      removals.map((pathname) => fs.rm(pathname, { force: true })),
    );
  }

  async removeSession(sessionId) {
    this.revokedSessions.add(sessionId);
    for (const controller of this.inFlight.get(sessionId) ?? []) {
      controller.abort();
    }
    const paths = Array.from(this.files.values())
      .filter((metadata) => metadata.sessionId === sessionId)
      .map((metadata) => metadata.path);
    if (!this.persistFiles) {
      await this.removePaths(sessionId, paths);
      return;
    }
    for (const pathname of paths) {
      const metadata = this.files.get(pathname);
      if (metadata?.sessionId !== sessionId) {
        continue;
      }
      this.files.delete(pathname);
      this.releaseSession(metadata);
    }
  }

  async close() {
    for (const controllers of this.inFlight.values()) {
      for (const controller of controllers) {
        controller.abort();
      }
    }
    this.inFlight.clear();
    this.revokedSessions.clear();
    this.files.clear();
    this.sessionUsage.clear();
    Object.assign(this.globalUsage, emptyUsage());
    if (!this.persistFiles) {
      await fs.rm(this.root, { recursive: true, force: true });
    }
  }

  release(metadata) {
    this.globalUsage.bytes -= metadata.size;
    this.globalUsage.files -= 1;
    this.releaseSession(metadata);
  }

  releaseSession(metadata) {
    const session = this.sessionUsage.get(metadata.sessionId);
    if (session === undefined) {
      return;
    }
    session.bytes -= metadata.size;
    session.files -= 1;
    if (
      session.bytes === 0 &&
      session.files === 0 &&
      session.reservedBytes === 0 &&
      session.reservedFiles === 0
    ) {
      this.sessionUsage.delete(metadata.sessionId);
    }
  }
}

module.exports = {
  BROWSER_UPLOAD_LIMITS,
  BrowserUploadStore,
  isBrowserUploadLimitError,
};
