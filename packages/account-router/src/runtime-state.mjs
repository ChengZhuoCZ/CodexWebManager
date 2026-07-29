import { normalizeCircuitStateDocument } from "./circuit-breaker.mjs";
import { normalizeWeeklyQuotaStateEntries } from "./weekly-quota-tracker.mjs";

const RUNTIME_STATE_FIELDS = new Set([
  "version",
  "saved_at",
  "accounts",
  "weekly_quota",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    if (!Object.hasOwn(document, "weekly_quota")) return circuit;
    return Object.freeze({
      ...circuit,
      weekly_quota: normalizeWeeklyQuotaStateEntries(document.weekly_quota),
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
