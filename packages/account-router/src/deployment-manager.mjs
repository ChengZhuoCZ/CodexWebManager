import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { createAccountCatalog } from "./accounts.mjs";
import { normalizeRuntimeStateDocument } from "./runtime-state.mjs";

const PACKAGE_NAME = "@codex-web-manager/account-router";
const RELEASE_NAME_PATTERN =
  /^codex-account-router-([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)-linux-(x64|arm64)$/;
const SNAPSHOT_ID_PATTERN = /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/;
const RELEASE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_OPERATIONAL_BYTES = 16 * 1024 * 1024;
const MAX_RELEASE_BYTES = 256 * 1024 * 1024;
const MAX_RELEASE_FILES = 2_000;
const MANIFEST_FIELDS = new Set([
  "schema_version",
  "name",
  "version",
  "target",
  "runtime",
  "reproducibility",
  "schemas",
  "files",
]);
const SNAPSHOT_FIELDS = new Set([
  "schema_version",
  "snapshot_id",
  "created_at",
  "previous_release",
  "schemas",
  "credentials_included",
  "files",
]);
const SNAPSHOT_FILE_FIELDS = new Set([
  "present",
  "file",
  "size",
  "sha256",
  "mode",
  "uid",
  "gid",
]);
const CONFIG_FIELDS = new Set(["version", "accounts"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${label} contains an unsupported field`);
  }
}

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function assertSchemaSet(schemas) {
  if (
    !isPlainObject(schemas) ||
    Object.keys(schemas).length !== 2 ||
    schemas.accounts !== 1 ||
    schemas.circuit_state !== 1
  ) {
    throw new Error("release schema compatibility is unsupported");
  }
}

function releaseSchemaSet(manifest) {
  if (manifest.schemas === undefined && manifest.version === "0.1.0") {
    return Object.freeze({ accounts: 1, circuit_state: 1 });
  }
  assertSchemaSet(manifest.schemas);
  return manifest.schemas;
}

function assertCanonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativeFile(value) {
  if (
    typeof value !== "string" ||
    !RELEASE_FILE_PATTERN.test(value) ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.endsWith("/")
  ) {
    throw new Error("release file path is invalid");
  }
  return value;
}

function parseMode(value) {
  if (typeof value !== "string" || !/^0[4567][0-7]{2}$/.test(value)) {
    throw new Error("release file mode is invalid");
  }
  return Number.parseInt(value, 8);
}

async function readBoundedRegularFile(filePath, maximum, label) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) {
      throw new Error(`${label} is invalid`);
    }
    const bytes = await handle.readFile();
    if (bytes.length < 1 || bytes.length > maximum) throw new Error(`${label} is invalid`);
    return { bytes, metadata };
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function validateAccountsDocument(value) {
  if (!isPlainObject(value)) throw new Error("accounts configuration schema is invalid");
  assertOnlyFields(value, CONFIG_FIELDS, "accounts configuration");
  if (value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new Error("accounts configuration schema is invalid");
  }
  createAccountCatalog(value.accounts);
  return value;
}

async function assertDirectory(directory, label, { create = false, privateMode = false } = {}) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
  if (privateMode && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private`);
  }
  return metadata;
}

async function assertSourcePath(root, relativePath) {
  const components = relativePath.split("/");
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("release source path is invalid");
    }
  }
}

async function validateReleaseDirectory(releaseDirectory, platform, architecture) {
  assertAbsolute(releaseDirectory, "release directory");
  await assertDirectory(releaseDirectory, "release directory");
  const { bytes: manifestBytes } = await readBoundedRegularFile(
    path.join(releaseDirectory, "manifest.json"),
    MAX_MANIFEST_BYTES,
    "release manifest",
  );
  const manifest = parseJson(manifestBytes, "release manifest");
  if (!isPlainObject(manifest)) throw new Error("release manifest is invalid");
  assertOnlyFields(manifest, MANIFEST_FIELDS, "release manifest");
  if (
    manifest.schema_version !== 1 ||
    manifest.name !== PACKAGE_NAME ||
    typeof manifest.version !== "string" ||
    !isPlainObject(manifest.target) ||
    manifest.target.os !== platform ||
    manifest.target.architecture !== architecture
  ) {
    throw new Error("release manifest is incompatible");
  }
  const schemas = releaseSchemaSet(manifest);
  const releaseName = `codex-account-router-${manifest.version}-linux-${architecture}`;
  const nameMatch = RELEASE_NAME_PATTERN.exec(releaseName);
  if (!nameMatch || nameMatch[1] !== manifest.version || nameMatch[2] !== architecture) {
    throw new Error("release version is invalid");
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > MAX_RELEASE_FILES
  ) {
    throw new Error("release manifest file list is invalid");
  }
  const names = new Set();
  const files = [];
  let totalBytes = 0;
  for (const candidate of manifest.files) {
    if (!isPlainObject(candidate)) throw new Error("release manifest file is invalid");
    const relativePath = safeRelativeFile(candidate.path);
    if (names.has(relativePath)) throw new Error("release manifest file list is invalid");
    names.add(relativePath);
    const mode = parseMode(candidate.mode);
    if (
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0 ||
      candidate.size > MAX_OPERATIONAL_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.sha256)
    ) {
      throw new Error("release manifest file is invalid");
    }
    totalBytes += candidate.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RELEASE_BYTES) {
      throw new Error("release payload is too large");
    }
    await assertSourcePath(releaseDirectory, relativePath);
    const source = path.join(releaseDirectory, ...relativePath.split("/"));
    const { bytes, metadata } = await readBoundedRegularFile(
      source,
      Math.max(1, candidate.size),
      "release file",
    );
    if (
      bytes.length !== candidate.size ||
      sha256(bytes) !== candidate.sha256 ||
      (metadata.mode & 0o777) !== mode
    ) {
      throw new Error("release file integrity is invalid");
    }
    files.push({ bytes, mode, path: relativePath });
  }
  if (!names.has("bin/codex-account-router")) {
    throw new Error("release router entrypoint is missing");
  }
  return Object.freeze({
    files: Object.freeze(files),
    manifest,
    manifestBytes,
    releaseName,
    schemas,
  });
}

async function currentRelease(prefix) {
  const currentPath = path.join(prefix, "current");
  let metadata;
  try {
    metadata = await lstat(currentPath);
  } catch {
    throw new Error("current release link is unavailable");
  }
  if (!metadata.isSymbolicLink()) throw new Error("current release link is invalid");
  const target = await readlink(currentPath);
  const match = /^releases\/([^/]+)$/.exec(target);
  if (!match || !RELEASE_NAME_PATTERN.test(match[1])) {
    throw new Error("current release link is invalid");
  }
  await assertDirectory(path.join(prefix, target), "current release directory");
  return match[1];
}

async function readOperationalFile(filePath, role, required) {
  let result;
  try {
    result = await readBoundedRegularFile(filePath, MAX_OPERATIONAL_BYTES, role);
  } catch (error) {
    if (!required) {
      try {
        await lstat(filePath);
      } catch (statError) {
        if (statError?.code === "ENOENT") return null;
      }
    }
    throw error;
  }
  if ((result.metadata.mode & 0o077) !== 0) {
    throw new Error(`${role} must be private`);
  }
  const document = parseJson(result.bytes, role);
  if (role === "accounts configuration") {
    validateAccountsDocument(document);
  } else {
    normalizeRuntimeStateDocument(document);
  }
  return {
    bytes: result.bytes,
    gid: result.metadata.gid,
    mode: result.metadata.mode & 0o777,
    uid: result.metadata.uid,
  };
}

function snapshotFileRecord(file, name) {
  if (file === null) {
    return Object.freeze({
      present: false,
      file: name,
      size: 0,
      sha256: null,
      mode: null,
      uid: null,
      gid: null,
    });
  }
  return Object.freeze({
    present: true,
    file: name,
    size: file.bytes.length,
    sha256: sha256(file.bytes),
    mode: file.mode.toString(8).padStart(4, "0"),
    uid: file.uid,
    gid: file.gid,
  });
}

function snapshotId(now) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds)) throw new Error("deployment clock is invalid");
  const timestamp = new Date(milliseconds);
  if (Number.isNaN(timestamp.getTime())) throw new Error("deployment clock is invalid");
  const compact = timestamp.toISOString().replace(/[-:.]/g, "");
  return `${compact}-${randomBytes(6).toString("hex")}`;
}

async function atomicPrivateWrite(filePath, bytes, metadata) {
  const directory = path.dirname(filePath);
  await assertDirectory(directory, "operational file directory");
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, metadata.mode);
    await chown(temporaryPath, metadata.uid, metadata.gid);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function installRelease(prefix, release) {
  const releasesDirectory = path.join(prefix, "releases");
  await mkdir(releasesDirectory, { recursive: true, mode: 0o755 });
  await assertDirectory(releasesDirectory, "release storage directory");
  const target = path.join(releasesDirectory, release.releaseName);
  try {
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("installed release target is invalid");
    }
    const existing = await readFile(path.join(target, "manifest.json"));
    if (!existing.equals(release.manifestBytes)) {
      throw new Error("installed release target does not match the requested release");
    }
    const installed = await validateReleaseDirectory(
      target,
      release.manifest.target.os,
      release.manifest.target.architecture,
    );
    if (installed.releaseName !== release.releaseName) {
      throw new Error("installed release target does not match the requested release");
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const staging = path.join(releasesDirectory, `.${release.releaseName}.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o755 });
  try {
    for (const file of release.files) {
      const destination = path.join(staging, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: file.mode });
      await chmod(destination, file.mode);
    }
    await writeFile(path.join(staging, "manifest.json"), release.manifestBytes, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function activateRelease(prefix, releaseName) {
  if (!RELEASE_NAME_PATTERN.test(releaseName)) throw new Error("release name is invalid");
  await assertDirectory(
    path.join(prefix, "releases", releaseName),
    "rollback release directory",
  );
  const temporaryLink = path.join(prefix, `.current.${randomUUID()}.tmp`);
  try {
    await symlink(`releases/${releaseName}`, temporaryLink);
    await rename(temporaryLink, path.join(prefix, "current"));
  } finally {
    await rm(temporaryLink, { force: true });
  }
}

function validateSnapshotFileRecord(value, expectedName) {
  if (!isPlainObject(value)) throw new Error("snapshot manifest file is invalid");
  assertOnlyFields(value, SNAPSHOT_FILE_FIELDS, "snapshot manifest file");
  if (value.file !== expectedName || typeof value.present !== "boolean") {
    throw new Error("snapshot manifest file is invalid");
  }
  if (!value.present) {
    if (
      value.size !== 0 ||
      value.sha256 !== null ||
      value.mode !== null ||
      value.uid !== null ||
      value.gid !== null
    ) {
      throw new Error("snapshot manifest file is invalid");
    }
    return value;
  }
  if (
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_OPERATIONAL_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.mode !== "string" ||
    !/^0[4567][0-7]{2}$/.test(value.mode) ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0
  ) {
    throw new Error("snapshot manifest file is invalid");
  }
  return value;
}

async function loadSnapshot(backupRoot, snapshotIdValue) {
  if (typeof snapshotIdValue !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotIdValue)) {
    throw new Error("snapshot id is invalid");
  }
  const directory = path.join(backupRoot, snapshotIdValue);
  await assertDirectory(directory, "snapshot directory", { privateMode: true });
  const { bytes } = await readBoundedRegularFile(
    path.join(directory, "manifest.json"),
    MAX_MANIFEST_BYTES,
    "snapshot manifest",
  );
  const manifest = parseJson(bytes, "snapshot manifest");
  if (!isPlainObject(manifest)) throw new Error("snapshot manifest is invalid");
  assertOnlyFields(manifest, SNAPSHOT_FIELDS, "snapshot manifest");
  if (
    manifest.schema_version !== 1 ||
    manifest.snapshot_id !== snapshotIdValue ||
    !RELEASE_NAME_PATTERN.test(manifest.previous_release) ||
    manifest.credentials_included !== false ||
    !isPlainObject(manifest.files)
  ) {
    throw new Error("snapshot manifest is invalid");
  }
  assertCanonicalTimestamp(manifest.created_at, "snapshot timestamp");
  assertSchemaSet(manifest.schemas);
  if (
    Object.keys(manifest.files).length !== 2 ||
    !Object.hasOwn(manifest.files, "accounts") ||
    !Object.hasOwn(manifest.files, "circuit_state")
  ) {
    throw new Error("snapshot manifest is invalid");
  }
  const records = {
    accounts: validateSnapshotFileRecord(manifest.files.accounts, "accounts.json"),
    circuit_state: validateSnapshotFileRecord(
      manifest.files.circuit_state,
      "circuit-state.json",
    ),
  };
  if (!records.accounts.present) {
    throw new Error("snapshot accounts configuration is missing");
  }
  const files = {};
  for (const [role, record] of Object.entries(records)) {
    if (!record.present) {
      files[role] = null;
      continue;
    }
    const result = await readBoundedRegularFile(
      path.join(directory, record.file),
      record.size,
      "snapshot file",
    );
    if (result.bytes.length !== record.size || sha256(result.bytes) !== record.sha256) {
      throw new Error("snapshot file integrity is invalid");
    }
    const document = parseJson(result.bytes, "snapshot file");
    if (role === "accounts") validateAccountsDocument(document);
    else normalizeRuntimeStateDocument(document);
    files[role] = { bytes: result.bytes, ...record };
  }
  return { directory, files, manifest };
}

export function createDeploymentManager({
  architecture = process.arch,
  backupRoot,
  configFile,
  healthCheck,
  now = () => Date.now(),
  platform = process.platform,
  prefix,
  serviceController,
  stateFile,
} = {}) {
  assertAbsolute(prefix, "release prefix");
  assertAbsolute(configFile, "configuration file");
  assertAbsolute(stateFile, "state file");
  assertAbsolute(backupRoot, "backup root");
  if (!new Set(["x64", "arm64"]).has(architecture)) {
    throw new Error("deployment architecture is invalid");
  }
  if (platform !== "linux") throw new Error("deployment manager requires Linux");
  if (
    !isPlainObject(serviceController) ||
    typeof serviceController.stop !== "function" ||
    typeof serviceController.start !== "function"
  ) {
    throw new TypeError("service controller is invalid");
  }
  if (typeof healthCheck !== "function") throw new TypeError("health check is invalid");
  if (typeof now !== "function") throw new TypeError("deployment clock is invalid");

  async function ensureBackupRoot() {
    await assertDirectory(backupRoot, "backup root", { create: true, privateMode: true });
  }

  async function backup() {
    await ensureBackupRoot();
    const previousRelease = await currentRelease(prefix);
    const validatedCurrent = await validateReleaseDirectory(
      path.join(prefix, "releases", previousRelease),
      platform,
      architecture,
    );
    if (validatedCurrent.releaseName !== previousRelease) {
      throw new Error("current release manifest is invalid");
    }
    await assertDirectory(path.dirname(configFile), "configuration directory");
    await assertDirectory(path.dirname(stateFile), "state directory");
    const accounts = await readOperationalFile(configFile, "accounts configuration", true);
    const circuitState = await readOperationalFile(stateFile, "circuit state", false);
    const id = snapshotId(now);
    const directory = path.join(backupRoot, id);
    await mkdir(directory, { mode: 0o700 });
    try {
      if (accounts !== null) {
        await writeFile(path.join(directory, "accounts.json"), accounts.bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      if (circuitState !== null) {
        await writeFile(path.join(directory, "circuit-state.json"), circuitState.bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      const createdAt = new Date(now()).toISOString();
      const manifest = {
        schema_version: 1,
        snapshot_id: id,
        created_at: createdAt,
        previous_release: previousRelease,
        schemas: { accounts: 1, circuit_state: 1 },
        credentials_included: false,
        files: {
          accounts: snapshotFileRecord(accounts, "accounts.json"),
          circuit_state: snapshotFileRecord(circuitState, "circuit-state.json"),
        },
      };
      await writeFile(
        path.join(directory, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return Object.freeze({ snapshot_id: id, release: previousRelease });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async function restoreSnapshot(snapshot) {
    const { files, manifest } = snapshot;
    await atomicPrivateWrite(configFile, files.accounts.bytes, {
      gid: files.accounts.gid,
      mode: Number.parseInt(files.accounts.mode, 8),
      uid: files.accounts.uid,
    });
    if (files.circuit_state === null) {
      try {
        await unlink(stateFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } else {
      await atomicPrivateWrite(stateFile, files.circuit_state.bytes, {
        gid: files.circuit_state.gid,
        mode: Number.parseInt(files.circuit_state.mode, 8),
        uid: files.circuit_state.uid,
      });
    }
    await activateRelease(prefix, manifest.previous_release);
  }

  async function rollback({ snapshotId: requestedSnapshotId } = {}) {
    await ensureBackupRoot();
    const snapshot = await loadSnapshot(backupRoot, requestedSnapshotId);
    const rollbackRelease = await validateReleaseDirectory(
      path.join(prefix, "releases", snapshot.manifest.previous_release),
      platform,
      architecture,
    );
    if (rollbackRelease.releaseName !== snapshot.manifest.previous_release) {
      throw new Error("rollback release manifest is invalid");
    }
    await serviceController.stop();
    try {
      await restoreSnapshot(snapshot);
      await serviceController.start();
      if (await healthCheck() !== true) {
        throw new Error("rollback health verification failed");
      }
      return Object.freeze({
        snapshot_id: requestedSnapshotId,
        release: snapshot.manifest.previous_release,
      });
    } catch (error) {
      try {
        await serviceController.start();
      } catch {}
      throw error;
    }
  }

  async function upgrade({ releaseDirectory } = {}) {
    const release = await validateReleaseDirectory(releaseDirectory, platform, architecture);
    const current = await currentRelease(prefix);
    if (release.releaseName === current) throw new Error("requested release is already active");
    const snapshot = await backup();
    await installRelease(prefix, release);
    await serviceController.stop();
    try {
      await activateRelease(prefix, release.releaseName);
      await serviceController.start();
      if (await healthCheck() !== true) {
        throw new Error("upgrade health verification failed");
      }
      return Object.freeze({
        snapshot_id: snapshot.snapshot_id,
        release: release.releaseName,
      });
    } catch (error) {
      try {
        await rollback({ snapshotId: snapshot.snapshot_id });
      } catch {
        throw new Error("upgrade failed and automatic rollback failed", { cause: error });
      }
      if (error?.message === "upgrade health verification failed") throw error;
      throw new Error("upgrade failed and was rolled back", { cause: error });
    }
  }

  return Object.freeze({
    backup,
    rollback,
    upgrade,
    toString() {
      return "[DeploymentManager]";
    },
    toJSON() {
      return "[DeploymentManager]";
    },
    [inspect.custom]() {
      return "[DeploymentManager]";
    },
  });
}
