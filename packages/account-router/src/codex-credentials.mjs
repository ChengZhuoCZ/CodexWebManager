import { validateHeaderValue } from "node:http";
import { TextDecoder } from "node:util";
import {
  createFileSecretProvider,
  defineSecretProvider,
  SecretLease,
} from "./secrets.mjs";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const BUNDLE_FIELDS = new Set(["version", "authorization", "account_id"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBoundedHeader(value, name, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error("Codex auth credential is invalid");
  }
  validateHeaderValue(name, value);
  return value;
}

function credentialBundle(authDocument) {
  if (!isPlainObject(authDocument) || !isPlainObject(authDocument.tokens)) {
    throw new Error("Codex auth credential is invalid");
  }
  const accessToken = assertBoundedHeader(
    authDocument.tokens.access_token,
    "authorization",
    64 * 1024,
  );
  const accountId = assertBoundedHeader(
    authDocument.tokens.account_id,
    "chatgpt-account-id",
    4 * 1024,
  );
  return Object.freeze({
    version: 1,
    authorization: `Bearer ${accessToken}`,
    account_id: accountId,
  });
}

export function parseCodexCredentialBundle(value) {
  let document;
  try {
    document = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Codex credential bundle is invalid");
  }
  if (!isPlainObject(document)) throw new Error("Codex credential bundle is invalid");
  for (const field of Object.keys(document)) {
    if (!BUNDLE_FIELDS.has(field)) throw new Error("Codex credential bundle is invalid");
  }
  if (document.version !== 1) throw new Error("Codex credential bundle is invalid");
  const authorization = assertBoundedHeader(document.authorization, "authorization", 64 * 1024);
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Codex credential bundle is invalid");
  }
  const accountId = assertBoundedHeader(document.account_id, "chatgpt-account-id", 4 * 1024);
  return Object.freeze({ authorization, accountId });
}

export function createCodexAuthSecretProvider({
  rootDirectory,
  name = "codex-auth",
  maxBytes = 1024 * 1024,
} = {}) {
  const rawProvider = createFileSecretProvider({
    rootDirectory,
    name: `${name}.raw`,
    maxBytes,
  });
  return defineSecretProvider({
    name,
    async acquire(credentialReference) {
      let rawLease;
      try {
        rawLease = await rawProvider.acquire(credentialReference);
        const bundle = rawLease.use((text) => credentialBundle(JSON.parse(UTF8.decode(Buffer.from(text)))));
        return SecretLease.fromUtf8(JSON.stringify(bundle));
      } catch {
        throw new Error("credential acquisition failed");
      } finally {
        rawLease?.dispose();
      }
    },
  });
}
