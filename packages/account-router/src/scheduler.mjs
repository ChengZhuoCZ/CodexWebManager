import { inspect } from "node:util";

const CANDIDATE_FIELDS = new Set(["account", "active_requests", "cooldown_until", "quota"]);
const SELECTION_OPTION_FIELDS = new Set(["excludeAccountIds"]);
const ACCOUNT_FIELDS = new Set([
  "id",
  "alias",
  "enabled",
  "priority",
  "max_concurrency",
  "provider",
]);
const SNAPSHOT_FIELDS = new Set([
  "adapter",
  "source_state",
  "attempted_at",
  "observed_at",
  "staleness",
  "age_ms",
  "stale_after_ms",
  "confidence",
  "windows",
]);
const WINDOW_NAMES = Object.freeze(["five_hour", "weekly"]);
const WINDOW_FIELDS = new Set([
  "status",
  "remaining_ratio",
  "resets_at",
  "confidence",
  "reason",
]);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PROVIDER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const ADAPTER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const CONFIDENCE_RANK = Object.freeze({ unknown: 0, low: 1, medium: 2, high: 3 });
const AVAILABLE_CONFIDENCE = new Set(["high", "medium", "low"]);
const SOURCE_STATES = new Set(["available", "partial", "unavailable"]);
const STALENESS_STATES = new Set(["fresh", "stale", "unknown"]);
const UNAVAILABLE_REASONS = new Set([
  "not_reported",
  "unsupported",
  "source_unavailable",
  "source_error",
  "invalid_observation",
]);

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
      throw new Error(`unsupported ${label} field: ${field}`);
    }
  }
}

function parseCanonicalTimestamp(value, label) {
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
  return milliseconds;
}

function readClock(now) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(milliseconds)) {
    throw new Error("scheduler clock must return integer epoch milliseconds");
  }
  if (Number.isNaN(new Date(milliseconds).getTime())) {
    throw new Error("scheduler clock returned an out-of-range timestamp");
  }
  return milliseconds;
}

function validateWindow(window, name) {
  if (!isPlainObject(window)) {
    throw new Error(`quota snapshot ${name} window must be a plain object`);
  }
  try {
    assertOnlyFields(window, WINDOW_FIELDS, `quota snapshot ${name} window`);
  } catch (error) {
    throw new Error(`quota snapshot ${name} window is invalid`, { cause: error });
  }
  if (window.status === "available") {
    if (
      typeof window.remaining_ratio !== "number" ||
      !Number.isFinite(window.remaining_ratio) ||
      window.remaining_ratio < 0 ||
      window.remaining_ratio > 1 ||
      !AVAILABLE_CONFIDENCE.has(window.confidence) ||
      window.reason !== null
    ) {
      throw new Error(`quota snapshot ${name} available window is invalid`);
    }
    if (window.resets_at !== null) {
      parseCanonicalTimestamp(window.resets_at, `quota snapshot ${name} resets_at`);
    }
    return;
  }
  if (
    window.status !== "unavailable" ||
    window.remaining_ratio !== null ||
    window.resets_at !== null ||
    window.confidence !== "unknown" ||
    !UNAVAILABLE_REASONS.has(window.reason)
  ) {
    throw new Error(`quota snapshot ${name} unavailable window is invalid`);
  }
}

function aggregateConfidence(windows) {
  return WINDOW_NAMES
    .map((name) => windows[name].confidence)
    .reduce((lowest, confidence) =>
      CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[lowest] ? confidence : lowest,
    "high");
}

function validateQuotaSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new Error("quota snapshot must be a plain object");
  }
  try {
    assertOnlyFields(snapshot, SNAPSHOT_FIELDS, "quota snapshot");
  } catch (error) {
    throw new Error("quota snapshot contains unsupported fields", { cause: error });
  }
  if (typeof snapshot.adapter !== "string" || !ADAPTER_PATTERN.test(snapshot.adapter)) {
    throw new Error("quota snapshot adapter is invalid");
  }
  if (!SOURCE_STATES.has(snapshot.source_state)) {
    throw new Error("quota snapshot source_state is invalid");
  }
  parseCanonicalTimestamp(snapshot.attempted_at, "quota snapshot attempted_at");
  const observedMilliseconds =
    snapshot.observed_at === null
      ? null
      : parseCanonicalTimestamp(snapshot.observed_at, "quota snapshot observed_at");
  if (!STALENESS_STATES.has(snapshot.staleness)) {
    throw new Error("quota snapshot staleness is invalid");
  }
  if (
    !Number.isSafeInteger(snapshot.stale_after_ms) ||
    snapshot.stale_after_ms < 1 ||
    snapshot.stale_after_ms > 2_592_000_000
  ) {
    throw new Error("quota snapshot stale_after_ms is invalid");
  }
  if (!Object.hasOwn(CONFIDENCE_RANK, snapshot.confidence)) {
    throw new Error("quota snapshot confidence is invalid");
  }
  if (!isPlainObject(snapshot.windows)) {
    throw new Error("quota snapshot windows must be a plain object");
  }
  assertOnlyFields(snapshot.windows, new Set(WINDOW_NAMES), "quota snapshot windows");
  for (const name of WINDOW_NAMES) {
    if (!Object.hasOwn(snapshot.windows, name)) {
      throw new Error(`quota snapshot ${name} window is required`);
    }
    validateWindow(snapshot.windows[name], name);
  }

  const availableCount = WINDOW_NAMES.filter(
    (name) => snapshot.windows[name].status === "available",
  ).length;
  const expectedSourceState =
    availableCount === 2 ? "available" : availableCount === 1 ? "partial" : "unavailable";
  if (snapshot.source_state !== expectedSourceState) {
    throw new Error("quota snapshot source_state is inconsistent with its windows");
  }
  if (snapshot.confidence !== aggregateConfidence(snapshot.windows)) {
    throw new Error("quota snapshot confidence is inconsistent with its windows");
  }

  if (snapshot.observed_at === null) {
    if (snapshot.staleness !== "unknown" || snapshot.age_ms !== null || availableCount !== 0) {
      throw new Error("quota snapshot unknown observation metadata is inconsistent");
    }
  } else {
    if (
      !new Set(["fresh", "stale"]).has(snapshot.staleness) ||
      !Number.isSafeInteger(snapshot.age_ms) ||
      snapshot.age_ms < 0
    ) {
      throw new Error("quota snapshot observed metadata is inconsistent");
    }
    if (
      (snapshot.staleness === "fresh" && snapshot.age_ms >= snapshot.stale_after_ms) ||
      (snapshot.staleness === "stale" && snapshot.age_ms < snapshot.stale_after_ms)
    ) {
      throw new Error("quota snapshot age and staleness are inconsistent");
    }
  }
  return observedMilliseconds;
}

function validateAccount(account) {
  if (!isPlainObject(account)) {
    throw new Error("candidate account must be a plain object");
  }
  assertOnlyFields(account, ACCOUNT_FIELDS, "candidate account");
  if (typeof account.id !== "string" || !ACCOUNT_ID_PATTERN.test(account.id)) {
    throw new Error("candidate account id is invalid");
  }
  if (
    typeof account.alias !== "string" ||
    account.alias.trim() !== account.alias ||
    [...account.alias].length < 1 ||
    [...account.alias].length > 64
  ) {
    throw new Error("candidate account alias is invalid");
  }
  if (typeof account.enabled !== "boolean") {
    throw new Error("candidate account enabled is invalid");
  }
  if (!Number.isSafeInteger(account.priority) || account.priority < -1_000 || account.priority > 1_000) {
    throw new Error("candidate account priority is invalid");
  }
  if (
    !Number.isSafeInteger(account.max_concurrency) ||
    account.max_concurrency < 1 ||
    account.max_concurrency > 64
  ) {
    throw new Error("candidate account max_concurrency is invalid");
  }
  if (typeof account.provider !== "string" || !PROVIDER_PATTERN.test(account.provider)) {
    throw new Error("candidate account provider is invalid");
  }
}

function validateCandidate(candidate) {
  if (!isPlainObject(candidate)) {
    throw new Error("scheduler candidate must be a plain object");
  }
  assertOnlyFields(candidate, CANDIDATE_FIELDS, "candidate");
  validateAccount(candidate.account);
  if (
    !Number.isSafeInteger(candidate.active_requests) ||
    candidate.active_requests < 0 ||
    candidate.active_requests > 1_000_000
  ) {
    throw new Error("candidate active_requests is invalid");
  }
  let cooldownMilliseconds = null;
  if (candidate.cooldown_until !== null) {
    cooldownMilliseconds = parseCanonicalTimestamp(
      candidate.cooldown_until,
      "candidate cooldown_until",
    );
  }
  const observedMilliseconds = validateQuotaSnapshot(candidate.quota);
  return Object.freeze({ cooldownMilliseconds, observedMilliseconds });
}

function analyzeQuota(snapshot, observedMilliseconds, nowMilliseconds) {
  const currentAge =
    observedMilliseconds === null
      ? null
      : Math.max(snapshot.age_ms, Math.max(0, nowMilliseconds - observedMilliseconds));
  const effectiveStaleness =
    currentAge !== null && currentAge >= snapshot.stale_after_ms
      ? "stale"
      : snapshot.staleness;
  const complete = WINDOW_NAMES.every((name) => snapshot.windows[name].status === "available");
  if (effectiveStaleness === "fresh" && complete) {
    const remainingRatio = Math.min(
      snapshot.windows.five_hour.remaining_ratio,
      snapshot.windows.weekly.remaining_ratio,
    );
    return Object.freeze({
      basis: "fresh",
      confidenceRank: CONFIDENCE_RANK[snapshot.confidence],
      exhausted: remainingRatio === 0,
      remainingRatio,
      staleness: effectiveStaleness,
      tier: 2,
    });
  }
  const basis =
    effectiveStaleness === "stale"
      ? "stale"
      : snapshot.source_state === "partial"
        ? "partial"
        : "unavailable";
  return Object.freeze({
    basis,
    confidenceRank: 0,
    exhausted: false,
    remainingRatio: null,
    staleness: effectiveStaleness,
    tier: 1,
  });
}

function accountIdCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvaluations(left, right) {
  if (left.evaluation.eligible !== right.evaluation.eligible) {
    return left.evaluation.eligible ? -1 : 1;
  }
  if (!left.evaluation.eligible) {
    return accountIdCompare(left.evaluation.account_id, right.evaluation.account_id);
  }
  if (left.quota.tier !== right.quota.tier) {
    return right.quota.tier - left.quota.tier;
  }
  if (left.evaluation.priority !== right.evaluation.priority) {
    return right.evaluation.priority - left.evaluation.priority;
  }
  if (left.quota.remainingRatio !== right.quota.remainingRatio) {
    return (right.quota.remainingRatio ?? -1) > (left.quota.remainingRatio ?? -1) ? 1 : -1;
  }
  if (left.quota.confidenceRank !== right.quota.confidenceRank) {
    return right.quota.confidenceRank - left.quota.confidenceRank;
  }
  const utilizationComparison =
    left.evaluation.active_requests * right.evaluation.max_concurrency -
    right.evaluation.active_requests * left.evaluation.max_concurrency;
  if (utilizationComparison !== 0) {
    return utilizationComparison;
  }
  return accountIdCompare(left.evaluation.account_id, right.evaluation.account_id);
}

function evaluateCandidate(
  candidate,
  cooldownMilliseconds,
  observedMilliseconds,
  nowMilliseconds,
  excluded,
) {
  const quota = analyzeQuota(candidate.quota, observedMilliseconds, nowMilliseconds);
  let reason = "eligible";
  if (excluded) {
    reason = "excluded";
  } else if (!candidate.account.enabled) {
    reason = "disabled";
  } else if (cooldownMilliseconds !== null && cooldownMilliseconds > nowMilliseconds) {
    reason = "cooldown";
  } else if (candidate.active_requests >= candidate.account.max_concurrency) {
    reason = "concurrency_limit";
  } else if (quota.exhausted) {
    reason = "quota_exhausted";
  }
  const evaluation = Object.freeze({
    account_id: candidate.account.id,
    alias: candidate.account.alias,
    eligible: reason === "eligible",
    reason,
    priority: candidate.account.priority,
    remaining_ratio: quota.remainingRatio,
    quota_basis: quota.basis,
    quota_confidence: candidate.quota.confidence,
    quota_staleness: quota.staleness,
    active_requests: candidate.active_requests,
    max_concurrency: candidate.account.max_concurrency,
    cooldown_until: candidate.cooldown_until,
  });
  return Object.freeze({ evaluation, quota });
}

export function createDeterministicScheduler({ now = () => Date.now() } = {}) {
  if (typeof now !== "function") {
    throw new TypeError("scheduler clock must be a function");
  }
  const scheduler = {
    select(candidates, options = {}) {
      if (!Array.isArray(candidates) || candidates.length > 1_000) {
        throw new Error("scheduler candidates must be an array with at most 1000 entries");
      }
      if (!isPlainObject(options)) {
        throw new Error("scheduler selection options must be a plain object");
      }
      assertOnlyFields(options, SELECTION_OPTION_FIELDS, "scheduler selection option");
      const excludeAccountIds = options.excludeAccountIds ?? [];
      if (!Array.isArray(excludeAccountIds) || excludeAccountIds.length > 1_000) {
        throw new Error("excludeAccountIds must be an array with at most 1000 entries");
      }
      const nowMilliseconds = readClock(now);
      const ids = new Set();
      const normalized = candidates.map((candidate) => {
        const validation = validateCandidate(candidate);
        if (ids.has(candidate.account.id)) {
          throw new Error(`duplicate scheduler candidate: ${candidate.account.id}`);
        }
        ids.add(candidate.account.id);
        return Object.freeze({ candidate, ...validation });
      });
      const excludedIds = new Set();
      for (const accountId of excludeAccountIds) {
        if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
          throw new Error("excluded account id is invalid");
        }
        if (excludedIds.has(accountId)) {
          throw new Error(`duplicate excluded account: ${accountId}`);
        }
        if (!ids.has(accountId)) {
          throw new Error(`unknown excluded account: ${accountId}`);
        }
        excludedIds.add(accountId);
      }
      const ranked = normalized
        .map(({ candidate, cooldownMilliseconds, observedMilliseconds }) =>
          evaluateCandidate(
            candidate,
            cooldownMilliseconds,
            observedMilliseconds,
            nowMilliseconds,
            excludedIds.has(candidate.account.id),
          ))
        .sort(compareEvaluations);
      const evaluations = Object.freeze(ranked.map(({ evaluation }) => evaluation));
      const selected = ranked.find(({ evaluation }) => evaluation.eligible)?.evaluation ?? null;
      return Object.freeze({
        status: selected === null ? "all_accounts_unavailable" : "selected",
        selected_account_id: selected?.account_id ?? null,
        selected_alias: selected?.alias ?? null,
        evaluations,
      });
    },
    toString() {
      return "[DeterministicScheduler]";
    },
    toJSON() {
      return "[DeterministicScheduler]";
    },
    [inspect.custom]() {
      return "[DeterministicScheduler]";
    },
  };
  return Object.freeze(scheduler);
}
