const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_FIELDS = new Set([
  "id",
  "alias",
  "enabled",
  "priority",
  "max_concurrency",
  "provider",
  "secret_provider",
  "credential_ref",
]);

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("account definition must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("account definition must be a plain object");
  }
}

function assertIntegerInRange(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function assertBoundedText(value, field, minimum, maximum) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const length = [...value].length;
  if (length < minimum || length > maximum || value.trim() !== value) {
    throw new Error(`${field} must contain ${minimum} through ${maximum} trimmed characters`);
  }
  return value;
}

function assertProviderName(value, field) {
  if (typeof value !== "string" || !PROVIDER_NAME_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded provider name`);
  }
  return value;
}

function assertCredentialReference(value) {
  if (typeof value !== "string" || !CREDENTIAL_REFERENCE_PATTERN.test(value)) {
    throw new Error("credential_ref must be a single opaque credential reference");
  }
  return value;
}

export function normalizeAccountDefinition(definition) {
  assertPlainObject(definition);
  for (const field of Object.keys(definition)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error(`unsupported account field: ${field}`);
    }
  }

  const id = definition.id;
  if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id)) {
    throw new Error("id must match the public account identifier pattern");
  }
  const alias = assertBoundedText(definition.alias, "alias", 1, 64);
  if (typeof definition.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const priority = assertIntegerInRange(definition.priority, "priority", -1_000, 1_000);
  const maxConcurrency = assertIntegerInRange(
    definition.max_concurrency ?? 1,
    "max_concurrency",
    1,
    64,
  );
  const provider = assertProviderName(definition.provider ?? "openai-codex", "provider");
  const secretProvider = assertProviderName(
    definition.secret_provider ?? "file",
    "secret_provider",
  );
  const credentialRef = assertCredentialReference(definition.credential_ref);

  const publicMetadata = Object.freeze({
    id,
    alias,
    enabled: definition.enabled,
    priority,
    max_concurrency: maxConcurrency,
    provider,
  });
  const credentialBinding = Object.freeze({
    accountId: id,
    secretProvider,
    credentialRef,
  });
  return Object.freeze({ publicMetadata, credentialBinding });
}

export function createAccountCatalog(definitions = []) {
  if (!Array.isArray(definitions)) {
    throw new TypeError("account definitions must be an array");
  }
  const publicById = new Map();
  const bindingById = new Map();
  const orderedPublic = [];
  for (const definition of definitions) {
    const normalized = normalizeAccountDefinition(definition);
    const { id } = normalized.publicMetadata;
    if (publicById.has(id)) {
      throw new Error(`duplicate account id: ${id}`);
    }
    publicById.set(id, normalized.publicMetadata);
    bindingById.set(id, normalized.credentialBinding);
    orderedPublic.push(normalized.publicMetadata);
  }
  const publicSnapshot = Object.freeze(orderedPublic);

  return Object.freeze({
    get size() {
      return publicSnapshot.length;
    },
    listPublic() {
      return publicSnapshot;
    },
    getPublic(accountId) {
      return publicById.get(accountId) ?? null;
    },
    getCredentialBinding(accountId) {
      return bindingById.get(accountId) ?? null;
    },
  });
}
