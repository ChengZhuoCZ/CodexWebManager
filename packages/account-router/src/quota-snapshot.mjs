import { inspect } from "node:util";

const ADAPTER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const OBSERVATION_FIELDS = new Set(["observed_at", "five_hour", "weekly"]);
const AVAILABLE_WINDOW_FIELDS = new Set([
  "status",
  "remaining_ratio",
  "resets_at",
  "confidence",
]);
const UNAVAILABLE_WINDOW_FIELDS = new Set(["status", "reason"]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
const CONFIDENCE_RANK = Object.freeze({ unknown: 0, low: 1, medium: 2, high: 3 });
const INPUT_UNAVAILABLE_REASONS = new Set(["not_reported", "unsupported", "source_unavailable"]);
const MAX_STALE_AFTER_MS = 30 * 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`${label} contains an unsupported field`);
    }
  }
}

function parseTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return Object.freeze({ milliseconds, iso: value });
}

function readClock(now) {
  const milliseconds = now();
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds)) {
    throw new Error("quota clock must return integer epoch milliseconds");
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error("quota clock returned an out-of-range timestamp");
  }
  return Object.freeze({ milliseconds, iso: date.toISOString() });
}

function unavailableWindow(reason) {
  return Object.freeze({
    status: "unavailable",
    remaining_ratio: null,
    resets_at: null,
    confidence: "unknown",
    reason,
  });
}

function normalizeWindow(rawWindow) {
  if (rawWindow === undefined) {
    return unavailableWindow("not_reported");
  }
  if (!isPlainObject(rawWindow) || typeof rawWindow.status !== "string") {
    throw new Error("quota window must be a status-tagged plain object");
  }
  if (rawWindow.status === "unavailable") {
    assertOnlyFields(rawWindow, UNAVAILABLE_WINDOW_FIELDS, "unavailable quota window");
    if (!INPUT_UNAVAILABLE_REASONS.has(rawWindow.reason)) {
      throw new Error("unavailable quota window reason is invalid");
    }
    return unavailableWindow(rawWindow.reason);
  }
  if (rawWindow.status !== "available") {
    throw new Error("quota window status is invalid");
  }
  assertOnlyFields(rawWindow, AVAILABLE_WINDOW_FIELDS, "available quota window");
  if (
    typeof rawWindow.remaining_ratio !== "number" ||
    !Number.isFinite(rawWindow.remaining_ratio) ||
    rawWindow.remaining_ratio < 0 ||
    rawWindow.remaining_ratio > 1
  ) {
    throw new Error("remaining_ratio must be a number from 0 through 1");
  }
  if (!CONFIDENCE_LEVELS.has(rawWindow.confidence)) {
    throw new Error("available quota window confidence is invalid");
  }
  let resetsAt = null;
  if (rawWindow.resets_at !== undefined && rawWindow.resets_at !== null) {
    resetsAt = parseTimestamp(rawWindow.resets_at, "resets_at").iso;
  }
  return Object.freeze({
    status: "available",
    remaining_ratio: rawWindow.remaining_ratio,
    resets_at: resetsAt,
    confidence: rawWindow.confidence,
    reason: null,
  });
}

function aggregateConfidence(windows) {
  return Object.values(windows)
    .map(({ confidence }) => confidence)
    .reduce((lowest, confidence) =>
      CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[lowest] ? confidence : lowest,
    "high");
}

function calculateStaleness(observedMilliseconds, nowMilliseconds, staleAfterMs, maxFutureSkewMs) {
  const difference = nowMilliseconds - observedMilliseconds;
  if (difference < -maxFutureSkewMs) {
    throw new Error("quota observation is too far in the future");
  }
  const ageMs = Math.max(0, difference);
  return Object.freeze({
    ageMs,
    state: ageMs >= staleAfterMs ? "stale" : "fresh",
  });
}

function freezeSnapshot(snapshot) {
  Object.freeze(snapshot.windows);
  return Object.freeze(snapshot);
}

function buildUnavailableSnapshot({ adapter, attemptedAt, staleAfterMs, reason }) {
  return freezeSnapshot({
    adapter,
    source_state: "unavailable",
    attempted_at: attemptedAt,
    observed_at: null,
    staleness: "unknown",
    age_ms: null,
    stale_after_ms: staleAfterMs,
    confidence: "unknown",
    windows: {
      five_hour: unavailableWindow(reason),
      weekly: unavailableWindow(reason),
    },
  });
}

function normalizeObservation({
  adapter,
  observation,
  attempted,
  staleAfterMs,
  maxFutureSkewMs,
}) {
  if (!isPlainObject(observation)) {
    throw new Error("quota observation must be a plain object");
  }
  assertOnlyFields(observation, OBSERVATION_FIELDS, "quota observation");
  const observed = parseTimestamp(observation.observed_at, "observed_at");
  const windows = Object.freeze({
    five_hour: normalizeWindow(observation.five_hour),
    weekly: normalizeWindow(observation.weekly),
  });
  const availableCount = Object.values(windows).filter(({ status }) => status === "available").length;
  const staleness = calculateStaleness(
    observed.milliseconds,
    attempted.milliseconds,
    staleAfterMs,
    maxFutureSkewMs,
  );
  return freezeSnapshot({
    adapter,
    source_state: availableCount === 2 ? "available" : availableCount === 1 ? "partial" : "unavailable",
    attempted_at: attempted.iso,
    observed_at: observed.iso,
    staleness: staleness.state,
    age_ms: staleness.ageMs,
    stale_after_ms: staleAfterMs,
    confidence: aggregateConfidence(windows),
    windows,
  });
}

export function createQuotaSnapshotAdapter({
  name,
  observe,
  now = () => Date.now(),
  staleAfterMs = 5 * 60_000,
  maxFutureSkewMs = 30_000,
} = {}) {
  if (typeof name !== "string" || !ADAPTER_NAME_PATTERN.test(name)) {
    throw new Error("quota adapter name is invalid");
  }
  if (typeof observe !== "function") {
    throw new TypeError("quota observe must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("quota clock must be a function");
  }
  if (
    !Number.isSafeInteger(staleAfterMs) ||
    staleAfterMs < 1 ||
    staleAfterMs > MAX_STALE_AFTER_MS
  ) {
    throw new Error("staleAfterMs must be an integer from 1 through 2592000000");
  }
  if (
    !Number.isSafeInteger(maxFutureSkewMs) ||
    maxFutureSkewMs < 0 ||
    maxFutureSkewMs > MAX_FUTURE_SKEW_MS
  ) {
    throw new Error("maxFutureSkewMs must be an integer from 0 through 300000");
  }

  const ownedSnapshots = new WeakSet();

  function own(snapshot) {
    ownedSnapshots.add(snapshot);
    return snapshot;
  }

  const adapter = {
    name,
    async read(context = undefined) {
      const attempted = readClock(now);
      let observation;
      try {
        observation = await observe(context);
      } catch {
        return own(buildUnavailableSnapshot({
          adapter: name,
          attemptedAt: attempted.iso,
          staleAfterMs,
          reason: "source_error",
        }));
      }
      if (observation === null || observation === undefined) {
        return own(buildUnavailableSnapshot({
          adapter: name,
          attemptedAt: attempted.iso,
          staleAfterMs,
          reason: "source_unavailable",
        }));
      }
      try {
        return own(normalizeObservation({
          adapter: name,
          observation,
          attempted,
          staleAfterMs,
          maxFutureSkewMs,
        }));
      } catch {
        return own(buildUnavailableSnapshot({
          adapter: name,
          attemptedAt: attempted.iso,
          staleAfterMs,
          reason: "invalid_observation",
        }));
      }
    },
    refreshStaleness(snapshot) {
      if (!ownedSnapshots.has(snapshot)) {
        throw new Error("snapshot was not created by this adapter");
      }
      if (snapshot.observed_at === null) {
        return own(freezeSnapshot({ ...snapshot, windows: snapshot.windows }));
      }
      const current = readClock(now);
      const observed = parseTimestamp(snapshot.observed_at, "observed_at");
      const staleness = calculateStaleness(
        observed.milliseconds,
        current.milliseconds,
        staleAfterMs,
        maxFutureSkewMs,
      );
      return own(freezeSnapshot({
        ...snapshot,
        staleness: staleness.state,
        age_ms: staleness.ageMs,
        windows: snapshot.windows,
      }));
    },
    toString() {
      return `[QuotaSnapshotAdapter ${name}]`;
    },
    toJSON() {
      return `[QuotaSnapshotAdapter ${name}]`;
    },
    [inspect.custom]() {
      return `[QuotaSnapshotAdapter ${name}]`;
    },
  };
  return Object.freeze(adapter);
}
