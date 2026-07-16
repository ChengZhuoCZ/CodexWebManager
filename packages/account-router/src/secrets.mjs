import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_BYTES = 64 * 1024;
const REDACTED_LEASE = "[REDACTED SecretLease]";

function assertProviderName(value) {
  if (typeof value !== "string" || !PROVIDER_NAME_PATTERN.test(value)) {
    throw new Error("secret provider name is invalid");
  }
  return value;
}

function assertCredentialReference(value) {
  if (typeof value !== "string" || !CREDENTIAL_REFERENCE_PATTERN.test(value)) {
    throw new Error("credential reference must be a single opaque name");
  }
  return value;
}

function assertOwnedByCurrentUser(stat, label) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the service user`);
  }
}

function assertPrivateMode(stat, label) {
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must deny group and other access`);
  }
}

async function assertPrivateDirectory(rootDirectory) {
  let stat;
  try {
    stat = await fs.lstat(rootDirectory);
  } catch {
    throw new Error("credential directory must exist and be private");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("credential directory must be a private regular directory");
  }
  assertOwnedByCurrentUser(stat, "credential directory");
  assertPrivateMode(stat, "credential directory");
}

export class SecretLease {
  #bytes;

  constructor(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new TypeError("SecretLease requires a non-empty Buffer");
    }
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }

  static fromUtf8(value) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("secret value must be a non-empty string");
    }
    return new SecretLease(Buffer.from(value, "utf8"));
  }

  get disposed() {
    return this.#bytes === null;
  }

  use(callback) {
    if (this.#bytes === null) {
      throw new Error("SecretLease has been disposed");
    }
    if (typeof callback !== "function") {
      throw new TypeError("SecretLease callback must be a function");
    }
    return callback(this.#bytes.toString("utf8"));
  }

  dispose() {
    if (this.#bytes !== null) {
      this.#bytes.fill(0);
      this.#bytes = null;
    }
  }

  toString() {
    return REDACTED_LEASE;
  }

  toJSON() {
    return REDACTED_LEASE;
  }

  [inspect.custom]() {
    return REDACTED_LEASE;
  }
}

export function defineSecretProvider({ name, acquire }) {
  const providerName = assertProviderName(name);
  if (typeof acquire !== "function") {
    throw new TypeError("secret provider acquire must be a function");
  }
  return Object.freeze({ name: providerName, acquire });
}

export class SecretProviderRegistry {
  #providers = new Map();

  register(provider) {
    if (
      provider === null ||
      typeof provider !== "object" ||
      typeof provider.acquire !== "function"
    ) {
      throw new TypeError("provider must implement acquire(reference)");
    }
    const name = assertProviderName(provider.name);
    if (this.#providers.has(name)) {
      throw new Error("secret provider is already registered");
    }
    this.#providers.set(name, provider);
    return this;
  }

  has(name) {
    return this.#providers.has(name);
  }

  async acquire(providerName, credentialReference) {
    const name = assertProviderName(providerName);
    const reference = assertCredentialReference(credentialReference);
    const provider = this.#providers.get(name);
    if (!provider) {
      throw new Error("secret provider is not registered");
    }
    let lease;
    try {
      lease = await provider.acquire(reference);
    } catch {
      throw new Error("secret provider acquisition failed");
    }
    if (!(lease instanceof SecretLease)) {
      throw new Error("secret provider returned an invalid lease");
    }
    return lease;
  }

  async withSecret(providerName, credentialReference, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("secret callback must be a function");
    }
    const lease = await this.acquire(providerName, credentialReference);
    try {
      return await lease.use(callback);
    } finally {
      lease.dispose();
    }
  }
}

export function createFileSecretProvider({
  rootDirectory,
  name = "file",
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
    throw new Error("credential root directory must be an absolute path");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error("credential maxBytes must be an integer from 1 through 1048576");
  }

  return defineSecretProvider({
    name,
    async acquire(credentialReference) {
      const reference = assertCredentialReference(credentialReference);
      await assertPrivateDirectory(rootDirectory);
      const credentialPath = path.join(rootDirectory, reference);
      let handle;
      try {
        handle = await fs.open(
          credentialPath,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        );
      } catch {
        throw new Error("credential path must be a regular credential file");
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new Error("credential path must be a regular credential file");
        }
        assertOwnedByCurrentUser(stat, "credential file");
        assertPrivateMode(stat, "credential file");
        if (stat.size < 1 || stat.size > maxBytes) {
          throw new Error("credential file size is outside the configured bound");
        }
        const bytes = await handle.readFile();
        if (bytes.length < 1 || bytes.length > maxBytes) {
          bytes.fill(0);
          throw new Error("credential file size is outside the configured bound");
        }
        const lease = new SecretLease(bytes);
        bytes.fill(0);
        return lease;
      } finally {
        await handle.close();
      }
    },
  });
}
