import { inspect } from "node:util";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const WEEKLY_WINDOW_MINUTES = new Set([10_079, 10_080]);
const MAX_SSE_EVENT_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 1_000;
const STATE_ENTRY_FIELDS = new Set([
  "account_id",
  "observed_at",
  "remaining_ratio",
  "resets_at",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readClock(now) {
  const milliseconds = now();
  if (
    !Number.isSafeInteger(milliseconds) ||
    !Number.isFinite(milliseconds) ||
    Number.isNaN(new Date(milliseconds).getTime())
  ) {
    throw new Error("weekly quota clock must return valid integer epoch milliseconds");
  }
  return milliseconds;
}

function resetTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function unavailableFiveHourWindow() {
  return Object.freeze({ status: "unavailable", reason: "unsupported" });
}

function freezeObservation({ observedAt, remainingRatio, resetsAt }) {
  return Object.freeze({
    observed_at: observedAt,
    five_hour: unavailableFiveHourWindow(),
    weekly: Object.freeze({
      status: "available",
      remaining_ratio: remainingRatio,
      resets_at: resetsAt,
      confidence: "high",
    }),
  });
}

function weeklyWindowFromEvent(event) {
  if (
    !isPlainObject(event) ||
    event.type !== "codex.rate_limits" ||
    (event.metered_limit_name !== undefined &&
      event.metered_limit_name !== null &&
      event.metered_limit_name !== "codex") ||
    !isPlainObject(event.rate_limits)
  ) {
    return null;
  }
  const candidates = ["primary", "secondary"]
    .map((slot) => event.rate_limits[slot])
    .filter((window) =>
      isPlainObject(window) && WEEKLY_WINDOW_MINUTES.has(window.window_minutes));
  if (candidates.length !== 1) return null;
  const [window] = candidates;
  if (
    typeof window.used_percent !== "number" ||
    !Number.isFinite(window.used_percent) ||
    window.used_percent < 0 ||
    window.used_percent > 100
  ) {
    return null;
  }
  const resetsAt = resetTimestamp(window.reset_at);
  if (resetsAt === undefined) return null;
  return Object.freeze({
    remainingRatio: Math.max(0, Math.min(1, (100 - window.used_percent) / 100)),
    resetsAt,
  });
}

export function weeklyQuotaObservationFromEvent(event, { now = () => Date.now() } = {}) {
  if (typeof now !== "function") throw new TypeError("weekly quota clock must be a function");
  const window = weeklyWindowFromEvent(event);
  if (window === null) return null;
  return freezeObservation({
    observedAt: new Date(readClock(now)).toISOString(),
    remainingRatio: window.remainingRatio,
    resetsAt: window.resetsAt,
  });
}

export function parseRateLimitSseEvent(bytes) {
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_SSE_EVENT_BYTES
  ) {
    return null;
  }
  const lines = Buffer.from(bytes).toString("utf8").split(/\r?\n/);
  let explicitEvent = null;
  const data = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") explicitEvent = value;
    if (field === "data") data.push(value);
  }
  if (explicitEvent !== null && explicitEvent !== "codex.rate_limits") return null;
  if (data.length === 0) return null;
  let event;
  try {
    event = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  return isPlainObject(event) && event.type === "codex.rate_limits" ? event : null;
}

function validateStoredObservation(observation) {
  if (!isPlainObject(observation)) throw new Error("weekly quota observation is invalid");
  const timestamp = observation.observed_at;
  if (
    typeof timestamp !== "string" ||
    Number.isNaN(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp ||
    !isPlainObject(observation.five_hour) ||
    observation.five_hour.status !== "unavailable" ||
    observation.five_hour.reason !== "unsupported" ||
    Object.keys(observation.five_hour).length !== 2 ||
    !isPlainObject(observation.weekly) ||
    observation.weekly.status !== "available" ||
    typeof observation.weekly.remaining_ratio !== "number" ||
    !Number.isFinite(observation.weekly.remaining_ratio) ||
    observation.weekly.remaining_ratio < 0 ||
    observation.weekly.remaining_ratio > 1 ||
    observation.weekly.confidence !== "high" ||
    !Object.hasOwn(observation.weekly, "resets_at") ||
    (observation.weekly.resets_at !== null &&
      (typeof observation.weekly.resets_at !== "string" ||
        Number.isNaN(Date.parse(observation.weekly.resets_at)) ||
        new Date(Date.parse(observation.weekly.resets_at)).toISOString() !==
          observation.weekly.resets_at)) ||
    Object.keys(observation.weekly).length !== 4 ||
    Object.keys(observation).length !== 3
  ) {
    throw new Error("weekly quota observation is invalid");
  }
}

function observationFromStateEntry(entry) {
  if (!isPlainObject(entry)) throw new Error("weekly quota state entry is invalid");
  for (const field of Object.keys(entry)) {
    if (!STATE_ENTRY_FIELDS.has(field)) {
      throw new Error("weekly quota state entry is invalid");
    }
  }
  if (
    typeof entry.account_id !== "string" ||
    !ACCOUNT_ID_PATTERN.test(entry.account_id)
  ) {
    throw new Error("weekly quota state account id is invalid");
  }
  const observation = {
    observed_at: entry.observed_at,
    five_hour: { status: "unavailable", reason: "unsupported" },
    weekly: {
      status: "available",
      remaining_ratio: entry.remaining_ratio,
      resets_at: entry.resets_at,
      confidence: "high",
    },
  };
  validateStoredObservation(observation);
  return Object.freeze({
    accountId: entry.account_id,
    observation: freezeObservation({
      observedAt: observation.observed_at,
      remainingRatio: observation.weekly.remaining_ratio,
      resetsAt: observation.weekly.resets_at,
    }),
  });
}

export function normalizeWeeklyQuotaStateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ACCOUNTS) {
    throw new Error("weekly quota state must be a bounded array");
  }
  const seen = new Set();
  const normalized = entries.map((entry) => {
    const restored = observationFromStateEntry(entry);
    if (seen.has(restored.accountId)) {
      throw new Error("weekly quota state account ids must be unique");
    }
    seen.add(restored.accountId);
    return Object.freeze({
      account_id: restored.accountId,
      observed_at: restored.observation.observed_at,
      remaining_ratio: restored.observation.weekly.remaining_ratio,
      resets_at: restored.observation.weekly.resets_at,
    });
  });
  normalized.sort((left, right) =>
    left.account_id < right.account_id ? -1 : left.account_id > right.account_id ? 1 : 0);
  return Object.freeze(normalized);
}

export function createWeeklyQuotaTracker({
  accountIds,
  initialState = [],
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(accountIds) || accountIds.length > MAX_ACCOUNTS || typeof now !== "function") {
    throw new TypeError("weekly quota tracker configuration is invalid");
  }
  const known = new Set();
  for (const accountId of accountIds) {
    if (
      typeof accountId !== "string" ||
      !ACCOUNT_ID_PATTERN.test(accountId) ||
      known.has(accountId)
    ) {
      throw new Error("weekly quota tracker account id is invalid");
    }
    known.add(accountId);
  }
  const observations = new Map();
  const restoredAt = initialState.length === 0 ? null : readClock(now);
  for (const entry of normalizeWeeklyQuotaStateEntries(initialState)) {
    if (!known.has(entry.account_id)) continue;
    const observation = observationFromStateEntry(entry).observation;
    if (
      observation.weekly.resets_at !== null &&
      Date.parse(observation.weekly.resets_at) <= restoredAt
    ) {
      continue;
    }
    observations.set(entry.account_id, observation);
  }
  const requireAccount = (accountId) => {
    if (!known.has(accountId)) throw new Error("unknown account");
  };
  const tracker = {
    observe(accountId, event) {
      requireAccount(accountId);
      const observation = weeklyQuotaObservationFromEvent(event, { now });
      if (observation === null) return false;
      observations.set(accountId, observation);
      return true;
    },
    record(accountId, observation) {
      requireAccount(accountId);
      validateStoredObservation(observation);
      observations.set(accountId, observation);
    },
    read(accountId) {
      requireAccount(accountId);
      return observations.get(accountId) ?? null;
    },
    exportState() {
      return normalizeWeeklyQuotaStateEntries(
        [...observations.entries()].map(([accountId, observation]) => ({
          account_id: accountId,
          observed_at: observation.observed_at,
          remaining_ratio: observation.weekly.remaining_ratio,
          resets_at: observation.weekly.resets_at,
        })),
      );
    },
    toString() {
      return "[WeeklyQuotaTracker]";
    },
    toJSON() {
      return "[WeeklyQuotaTracker]";
    },
    [inspect.custom]() {
      return "[WeeklyQuotaTracker]";
    },
  };
  return Object.freeze(tracker);
}
