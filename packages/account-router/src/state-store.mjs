import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
import { normalizeRuntimeStateDocument } from "./runtime-state.mjs";

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;
const DEFAULT_FILE_NAME = "circuit-state.json";
const ROUTING_FILE_NAME = "routing-state.json";

function assertOwned(metadata, label) {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the service user`);
  }
}

function assertPrivate(metadata, label) {
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private to the service user`);
  }
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("state operation aborted");
}

function throwIfAborted(signal) {
  if (signal === null || signal === undefined) return;
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError("state store abort signal is invalid");
  }
  if (signal.aborted) throw abortReason(signal);
}

async function ignoreMissingUnlink(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function createStateStore({
  directory,
  filename = DEFAULT_FILE_NAME,
  maxBytes = 1024 * 1024,
  documentKind,
} = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("circuit state directory must be absolute");
  }
  if (typeof filename !== "string" || !FILE_NAME_PATTERN.test(filename)) {
    throw new Error("circuit state filename is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 16 * 1024 * 1024) {
    throw new Error("circuit state maxBytes must be an integer from 256 through 16777216");
  }

  const path = join(directory, filename);
  let operationQueue = Promise.resolve();

  function normalizeStoredDocument(document) {
    const normalized = normalizeRuntimeStateDocument(document);
    if (documentKind === "circuit") {
      if (Object.hasOwn(normalized, "routing")) {
        throw new Error("circuit state document must not contain routing state");
      }
      return normalized;
    }
    if (
      documentKind !== "routing" ||
      !Object.hasOwn(normalized, "routing") ||
      normalized.accounts.length !== 0 ||
      Object.hasOwn(normalized, "weekly_quota")
    ) {
      throw new Error("routing state document is invalid");
    }
    return normalized;
  }

  function enqueue(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
  }

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink()) {
      throw new Error("circuit state directory must not be a symlink");
    }
    if (!metadata.isDirectory()) {
      throw new Error("circuit state directory must be a directory");
    }
    assertOwned(metadata, "circuit state directory");
    assertPrivate(metadata, "circuit state directory");
  }

  async function readDocument() {
    await ensureDirectory();
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (before.isSymbolicLink()) {
      throw new Error("circuit state file must not be a symlink");
    }
    if (!before.isFile()) {
      throw new Error("circuit state file must be a regular file");
    }
    assertOwned(before, "circuit state file");
    assertPrivate(before, "circuit state file");
    if (before.size < 1) {
      throw new Error("invalid state file");
    }
    if (before.size > maxBytes) {
      throw new Error("circuit state file is too large");
    }

    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(path, flags);
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error("circuit state file changed while opening");
      }
      if (after.size > maxBytes) {
        throw new Error("circuit state file is too large");
      }
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
      }
      if (length > maxBytes) {
        throw new Error("circuit state file is too large");
      }
      try {
        return normalizeStoredDocument(JSON.parse(buffer.subarray(0, length).toString("utf8")));
      } catch {
        throw new Error("invalid state file");
      }
    } finally {
      await handle?.close();
    }
  }

  function syncDirectoryForCommit() {
    let descriptor;
    try {
      descriptor = openSync(directory, constants.O_RDONLY);
      fsyncSync(descriptor);
    } catch (error) {
      if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  async function writeDocument(document, { signal = null } = {}) {
    throwIfAborted(signal);
    await ensureDirectory();
    throwIfAborted(signal);
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) {
      throw new Error("circuit state document is too large");
    }
    const temporaryPath = join(directory, `${filename}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0);
      handle = await open(temporaryPath, flags, 0o600);
      await handle.writeFile(serialized, "utf8");
      throwIfAborted(signal);
      await handle.sync();
      throwIfAborted(signal);
      await handle.close();
      handle = null;
      await chmod(temporaryPath, 0o600);
      throwIfAborted(signal);
      renameSync(temporaryPath, path);
      syncDirectoryForCommit();
    } catch (error) {
      await handle?.close();
      await ignoreMissingUnlink(temporaryPath);
      throw error;
    }
  }

  const store = {
    async load() {
      return enqueue(readDocument);
    },
    async save(document, { signal = null } = {}) {
      throwIfAborted(signal);
      const normalized = normalizeStoredDocument(document);
      return enqueue(() => writeDocument(normalized, { signal }));
    },
    toString() {
      return documentKind === "circuit" ? "[CircuitStateStore]" : "[RoutingStateStore]";
    },
    toJSON() {
      return documentKind === "circuit" ? "[CircuitStateStore]" : "[RoutingStateStore]";
    },
    [inspect.custom]() {
      return documentKind === "circuit" ? "[CircuitStateStore]" : "[RoutingStateStore]";
    },
  };
  return Object.freeze(store);
}

export function createCircuitStateStore(options = {}) {
  return createStateStore({ ...options, documentKind: "circuit" });
}

export function createRoutingStateStore({ directory, maxBytes = 1024 * 1024 } = {}) {
  return createStateStore({
    directory,
    filename: ROUTING_FILE_NAME,
    maxBytes,
    documentKind: "routing",
  });
}
