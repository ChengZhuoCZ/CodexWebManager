import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createAccountCatalog, normalizeAccountDefinition } from "./accounts.mjs";
import { parseCodexAuthCredential } from "./codex-credentials.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const CREDENTIAL_PREFIX = "codex-account-router.auth.";
const OPAQUE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function assertAbsolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("path must be absolute");
  }
  return value;
}

function assertFunction(value) {
  if (typeof value !== "function") throw new TypeError("callback is required");
  return value;
}

async function readBoundedRegularFile(filePath, {
  requirePrivate = false,
  requireNoGroupOtherWrites = false,
} = {}) {
  let handle;
  try {
    handle = await fs.open(
      assertAbsolutePath(filePath),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    const forbiddenMode = requirePrivate ? 0o077 : requireNoGroupOtherWrites ? 0o022 : 0;
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAX_DOCUMENT_BYTES ||
      (stat.mode & forbiddenMode) !== 0
    ) {
      throw new Error("file boundary is invalid");
    }
    return Object.freeze({ bytes: await handle.readFile(), stat });
  } finally {
    await handle?.close();
  }
}

function parseAccounts(bytes) {
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("accounts configuration is invalid");
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.version !== 1 ||
    !Array.isArray(document.accounts) ||
    Object.keys(document).some((field) => field !== "version" && field !== "accounts")
  ) {
    throw new Error("accounts configuration is invalid");
  }
  createAccountCatalog(document.accounts);
  return document;
}

function accountDefinition({ id, alias, priority, maxConcurrency }) {
  if (typeof id !== "string" || !OPAQUE_ID_PATTERN.test(id)) {
    throw new Error("account id must be opaque");
  }
  if (typeof alias !== "string" || !SAFE_ALIAS_PATTERN.test(alias) || alias.includes("@")) {
    throw new Error("account alias must not identify a person");
  }
  return {
    id,
    alias,
    enabled: true,
    priority,
    max_concurrency: maxConcurrency,
    provider: "openai-codex",
    secret_provider: "codex-auth",
    credential_ref: `${CREDENTIAL_PREFIX}${id}`,
  };
}

async function writePrivateTemporary(directory, basename, bytes, { uid, gid, mode }) {
  const temporaryPath = path.join(directory, `.${basename}.${randomUUID()}.next`);
  let handle;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.chown(uid, gid);
    await handle.sync();
    return temporaryPath;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function assertPrivateCredentialDirectory(directory, uid) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("credential store boundary is invalid");
  }
}

async function installCredential(directory, reference, bytes, { uid, gid }) {
  const destination = path.join(directory, reference);
  const temporary = await writePrivateTemporary(directory, reference, bytes, {
    uid,
    gid,
    mode: 0o600,
  });
  let installed = false;
  try {
    await fs.link(temporary, destination);
    installed = true;
    await fs.rm(temporary);
    await syncDirectory(directory);
    return destination;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (installed) await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

async function replaceConfiguration(filePath, bytes, stat) {
  const directory = path.dirname(filePath);
  const temporary = await writePrivateTemporary(directory, path.basename(filePath), bytes, {
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
  });
  try {
    await fs.rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function stableDocument(document, definition) {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    accounts: [...document.accounts, definition],
  }, null, 2)}\n`, "utf8");
}

function stableDocumentWithout(document, accountId) {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    accounts: document.accounts.filter((account) => account.id !== accountId),
  }, null, 2)}\n`, "utf8");
}

async function moveCredentialAside(directory, reference) {
  const source = path.join(directory, reference);
  const backup = path.join(directory, `.${reference}.${randomUUID()}.removed`);
  const handle = await fs.open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_DOCUMENT_BYTES || (stat.mode & 0o077) !== 0) {
      throw new Error("credential boundary is invalid");
    }
  } finally {
    await handle.close();
  }
  await fs.rename(source, backup);
  await syncDirectory(directory);
  return { source, backup };
}

export function createAccountEnrollmentManager({
  accountsFile,
  credentialStoreDirectory,
  restartRouter,
  routerReady,
  accountEnrollmentAllowed = async () => true,
  accountRemovalAllowed = async () => false,
  credentialUid = typeof process.getuid === "function" ? process.getuid() : 0,
  credentialGid = typeof process.getgid === "function" ? process.getgid() : 0,
} = {}) {
  const configPath = assertAbsolutePath(accountsFile);
  const credentialDirectory = assertAbsolutePath(credentialStoreDirectory);
  const restart = assertFunction(restartRouter);
  const ready = assertFunction(routerReady);
  const enrollmentAllowed = assertFunction(accountEnrollmentAllowed);
  const removalAllowed = assertFunction(accountRemovalAllowed);

  return Object.freeze({
    async enroll({ sourceFile, id, alias, priority = 0, maxConcurrency = 1 } = {}) {
      let credentialPath;
      let configurationInstalled = false;
      let restartAttempted = false;
      let original;
      let lockHandle;
      const lockPath = path.join(path.dirname(configPath), ".account-enrollment.lock");
      try {
        await assertPrivateCredentialDirectory(credentialDirectory, credentialUid);
        lockHandle = await fs.open(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        );
        const source = await readBoundedRegularFile(sourceFile, { requirePrivate: true });
        parseCodexAuthCredential(source.bytes);

        original = await readBoundedRegularFile(configPath, {
          requireNoGroupOtherWrites: true,
        });
        const document = parseAccounts(original.bytes);
        const definition = accountDefinition({ id, alias, priority, maxConcurrency });
        normalizeAccountDefinition(definition);
        if (await enrollmentAllowed(Object.freeze({ id: definition.id, alias: definition.alias })) !== true) {
          throw new Error("account enrollment is not currently allowed");
        }
        if (
          document.accounts.some((account) =>
            account.id === definition.id ||
            account.credential_ref === definition.credential_ref)
        ) {
          throw new Error("account binding already exists");
        }

        const currentBytes = await fs.readFile(configPath);
        if (!currentBytes.equals(original.bytes)) {
          throw new Error("accounts configuration changed concurrently");
        }

        credentialPath = await installCredential(
          credentialDirectory,
          definition.credential_ref,
          source.bytes,
          { uid: credentialUid, gid: credentialGid },
        );
        configurationInstalled = true;
        await replaceConfiguration(
          configPath,
          stableDocument(document, definition),
          original.stat,
        );

        restartAttempted = true;
        await restart();
        if (await ready(document.accounts.length + 1) !== true) {
          throw new Error("router readiness failed");
        }

        return Object.freeze({
          event: "router_account_enrolled",
          configured_accounts: document.accounts.length + 1,
          credentials_exposed: false,
        });
      } catch {
        if (configurationInstalled && original !== undefined) {
          await replaceConfiguration(configPath, original.bytes, original.stat).catch(() => {});
        }
        if (credentialPath !== undefined) {
          await fs.rm(credentialPath, { force: true }).catch(() => {});
          await syncDirectory(credentialDirectory).catch(() => {});
        }
        if (restartAttempted) {
          await restart().catch(() => {});
          await ready(parseAccounts(original.bytes).accounts.length).catch(() => false);
        }
        throw new Error("account enrollment failed");
      } finally {
        if (lockHandle !== undefined) {
          await lockHandle.close().catch(() => {});
          await fs.rm(lockPath, { force: true }).catch(() => {});
          await syncDirectory(path.dirname(configPath)).catch(() => {});
        }
      }
    },
    async remove({ alias } = {}) {
      let original;
      let credential;
      let configurationInstalled = false;
      let restartAttempted = false;
      let lockHandle;
      const lockPath = path.join(path.dirname(configPath), ".account-enrollment.lock");
      try {
        if (typeof alias !== "string" || !SAFE_ALIAS_PATTERN.test(alias) || alias.includes("@")) {
          throw new Error("account alias is invalid");
        }
        await assertPrivateCredentialDirectory(credentialDirectory, credentialUid);
        lockHandle = await fs.open(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        );
        original = await readBoundedRegularFile(configPath, {
          requireNoGroupOtherWrites: true,
        });
        const document = parseAccounts(original.bytes);
        if (document.accounts.length <= 1) throw new Error("last account cannot be removed");
        const definition = document.accounts.find((account) => account.alias === alias);
        if (definition === undefined) throw new Error("account binding is unavailable");
        if (await removalAllowed(Object.freeze({ id: definition.id, alias: definition.alias })) !== true) {
          throw new Error("account removal is not currently allowed");
        }

        const currentBytes = await fs.readFile(configPath);
        if (!currentBytes.equals(original.bytes)) {
          throw new Error("accounts configuration changed concurrently");
        }

        credential = await moveCredentialAside(
          credentialDirectory,
          definition.credential_ref,
        );
        configurationInstalled = true;
        await replaceConfiguration(
          configPath,
          stableDocumentWithout(document, definition.id),
          original.stat,
        );

        restartAttempted = true;
        await restart();
        if (await ready(document.accounts.length - 1) !== true) {
          throw new Error("router readiness failed");
        }
        await fs.rm(credential.backup);
        await syncDirectory(credentialDirectory);
        credential = undefined;
        return Object.freeze({
          event: "router_account_removed",
          configured_accounts: document.accounts.length - 1,
          credentials_exposed: false,
        });
      } catch {
        if (configurationInstalled && original !== undefined) {
          await replaceConfiguration(configPath, original.bytes, original.stat).catch(() => {});
        }
        if (credential !== undefined) {
          await fs.rename(credential.backup, credential.source).catch(() => {});
          await syncDirectory(credentialDirectory).catch(() => {});
        }
        if (restartAttempted && original !== undefined) {
          await restart().catch(() => {});
          await ready(parseAccounts(original.bytes).accounts.length).catch(() => false);
        }
        throw new Error("account removal failed");
      } finally {
        if (lockHandle !== undefined) {
          await lockHandle.close().catch(() => {});
          await fs.rm(lockPath, { force: true }).catch(() => {});
          await syncDirectory(path.dirname(configPath)).catch(() => {});
        }
      }
    },
  });
}
