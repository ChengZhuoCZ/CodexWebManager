import { normalizeCircuitStateDocument } from "./circuit-breaker.mjs";
import { normalizeWeeklyQuotaStateEntries } from "./weekly-quota-tracker.mjs";

const RUNTIME_STATE_FIELDS = new Set([
  "version",
  "saved_at",
  "accounts",
  "weekly_quota",
  "routing",
]);
const ROUTING_STATE_FIELDS = new Set([
  "current_account_id",
  "preferred_account_id",
]);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRoutingAccountId(value, field) {
  if (value !== null && (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value))) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function normalizeRoutingStateDocument(document) {
  if (!isPlainObject(document)) {
    throw new Error("routing state must be a plain object");
  }
  for (const field of Object.keys(document)) {
    if (!ROUTING_STATE_FIELDS.has(field)) {
      throw new Error("routing state contains an unsupported field");
    }
  }
  if (
    !Object.hasOwn(document, "current_account_id") ||
    !Object.hasOwn(document, "preferred_account_id")
  ) {
    throw new Error("routing state is incomplete");
  }
  return Object.freeze({
    current_account_id: normalizeRoutingAccountId(
      document.current_account_id,
      "current_account_id",
    ),
    preferred_account_id: normalizeRoutingAccountId(
      document.preferred_account_id,
      "preferred_account_id",
    ),
  });
}

export function normalizeRuntimeStateDocument(document) {
  try {
    if (!isPlainObject(document)) throw new Error("must be a plain object");
    for (const field of Object.keys(document)) {
      if (!RUNTIME_STATE_FIELDS.has(field)) {
        throw new Error("runtime state contains an unsupported field");
      }
    }
    const circuit = normalizeCircuitStateDocument({
      version: document.version,
      saved_at: document.saved_at,
      accounts: document.accounts,
    });
    if (
      !Object.hasOwn(document, "weekly_quota") &&
      !Object.hasOwn(document, "routing")
    ) {
      return circuit;
    }
    return Object.freeze({
      ...circuit,
      ...(Object.hasOwn(document, "weekly_quota")
        ? { weekly_quota: normalizeWeeklyQuotaStateEntries(document.weekly_quota) }
        : {}),
      ...(Object.hasOwn(document, "routing")
        ? { routing: normalizeRoutingStateDocument(document.routing) }
        : {}),
    });
  } catch (error) {
    throw new Error("runtime state document is invalid", { cause: error });
  }
}

export function circuitStateFromRuntimeState(document) {
  if (document === null || document === undefined) return null;
  const normalized = normalizeRuntimeStateDocument(document);
  return Object.freeze({
    version: normalized.version,
    saved_at: normalized.saved_at,
    accounts: normalized.accounts,
  });
}
