import { inspect } from "node:util";

const FAILURE_KINDS = Object.freeze([
  "quota_exhausted",
  "auth_expired",
  "rate_limited",
  "network_error",
  "upstream_5xx",
]);
const FAILURE_KIND_SET = new Set(FAILURE_KINDS);
const DEFAULT_COOLDOWNS = Object.freeze({
  quota_exhausted: 60 * 60_000,
  auth_expired: 5 * 60_000,
  rate_limited: 60_000,
  network_error: 15_000,
  upstream_5xx: 15_000,
});
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DOCUMENT_FIELDS = new Set(["version", "saved_at", "accounts"]);
const PERSISTED_ACCOUNT_FIELDS = new Set([
  "account_id",
  "phase",
  "last_failure_kind",
  "opened_at",
  "cooldown_until",
  "consecutive_failures",
  "last_failure_at",
  "last_success_at",
  "generation",
]);
const FAILURE_OPTION_FIELDS = new Set(["kind", "retryAfterMs", "probeToken"]);
const SUCCESS_OPTION_FIELDS = new Set(["probeToken"]);
const PHASES = new Set(["closed", "open", "half_open"]);
const MAX_ACCOUNTS = 1_000;
const MAX_COUNTER = 1_000_000_000;
const MAX_ALLOWED_COOLDOWN_MS = 30 * 24 * 60 * 60_000;

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
      throw new Error(`${label} contains unsupported field: ${field}`);
    }
  }
}

function assertAccountId(accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("circuit account id is invalid");
  }
  return accountId;
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
  return milliseconds;
}

function nullableTimestamp(value, label) {
  if (value === null) {
    return null;
  }
  parseTimestamp(value, label);
  return value;
}

function readClock(now) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(milliseconds)) {
    throw new Error("circuit clock must return integer epoch milliseconds");
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error("circuit clock returned an out-of-range timestamp");
  }
  return Object.freeze({ milliseconds, iso: date.toISOString() });
}

function incrementCounter(value) {
  return value >= MAX_COUNTER ? 1 : value + 1;
}

function normalizePersistedAccount(candidate) {
  if (!isPlainObject(candidate)) {
    throw new Error("state document account must be a plain object");
  }
  assertOnlyFields(candidate, PERSISTED_ACCOUNT_FIELDS, "state document account");
  const accountId = assertAccountId(candidate.account_id);
  if (!PHASES.has(candidate.phase)) {
    throw new Error("state document account phase is invalid");
  }
  if (candidate.last_failure_kind !== null && !FAILURE_KIND_SET.has(candidate.last_failure_kind)) {
    throw new Error("state document account failure kind is invalid");
  }
  const openedAt = nullableTimestamp(candidate.opened_at, "state document opened_at");
  const cooldownUntil = nullableTimestamp(
    candidate.cooldown_until,
    "state document cooldown_until",
  );
  const lastFailureAt = nullableTimestamp(
    candidate.last_failure_at,
    "state document last_failure_at",
  );
  const lastSuccessAt = nullableTimestamp(
    candidate.last_success_at,
    "state document last_success_at",
  );
  if (
    !Number.isSafeInteger(candidate.consecutive_failures) ||
    candidate.consecutive_failures < 0 ||
    candidate.consecutive_failures > MAX_COUNTER
  ) {
    throw new Error("state document consecutive_failures is invalid");
  }
  if (
    !Number.isSafeInteger(candidate.generation) ||
    candidate.generation < 0 ||
    candidate.generation > MAX_COUNTER
  ) {
    throw new Error("state document generation is invalid");
  }
  if (candidate.last_failure_kind === null ? lastFailureAt !== null : lastFailureAt === null) {
    throw new Error("state document failure metadata is inconsistent");
  }
  if (candidate.phase === "closed") {
    if (openedAt !== null || cooldownUntil !== null || candidate.consecutive_failures !== 0) {
      throw new Error("state document closed account is inconsistent");
    }
  } else {
    if (
      openedAt === null ||
      cooldownUntil === null ||
      candidate.last_failure_kind === null ||
      candidate.consecutive_failures < 1 ||
      parseTimestamp(cooldownUntil, "state document cooldown_until") <
        parseTimestamp(openedAt, "state document opened_at")
    ) {
      throw new Error("state document open account is inconsistent");
    }
  }
  return Object.freeze({
    account_id: accountId,
    phase: candidate.phase,
    last_failure_kind: candidate.last_failure_kind,
    opened_at: openedAt,
    cooldown_until: cooldownUntil,
    consecutive_failures: candidate.consecutive_failures,
    last_failure_at: lastFailureAt,
    last_success_at: lastSuccessAt,
    generation: candidate.generation,
  });
}

export function normalizeCircuitStateDocument(document) {
  try {
    if (!isPlainObject(document)) {
      throw new Error("must be a plain object");
    }
    assertOnlyFields(document, DOCUMENT_FIELDS, "state document");
    if (document.version !== 1) {
      throw new Error("version is unsupported");
    }
    const savedAtMilliseconds = parseTimestamp(document.saved_at, "state document saved_at");
    if (!Array.isArray(document.accounts) || document.accounts.length > MAX_ACCOUNTS) {
      throw new Error("accounts must be a bounded array");
    }
    const ids = new Set();
    const accounts = document.accounts.map((candidate) => {
      const account = normalizePersistedAccount(candidate);
      if (ids.has(account.account_id)) {
        throw new Error("account identifiers must be unique");
      }
      ids.add(account.account_id);
      if (
        account.phase === "half_open" &&
        parseTimestamp(account.cooldown_until, "state document cooldown_until") >
          savedAtMilliseconds
      ) {
        throw new Error("half-open account precedes its cooldown boundary");
      }
      return account;
    });
    accounts.sort((left, right) =>
      left.account_id < right.account_id ? -1 : left.account_id > right.account_id ? 1 : 0);
    return Object.freeze({
      version: 1,
      saved_at: document.saved_at,
      accounts: Object.freeze(accounts),
    });
  } catch (error) {
    throw new Error("circuit state document is invalid", { cause: error });
  }
}

function normalizeCooldownPolicy(cooldowns, maxCooldownMs) {
  if (!isPlainObject(cooldowns)) {
    throw new Error("circuit cooldown policy must be a plain object");
  }
  assertOnlyFields(cooldowns, new Set(FAILURE_KINDS), "circuit cooldown policy");
  const normalized = {};
  for (const kind of FAILURE_KINDS) {
    const duration = cooldowns[kind];
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > maxCooldownMs) {
      throw new Error(`circuit cooldown for ${kind} is invalid`);
    }
    normalized[kind] = duration;
  }
  return Object.freeze(normalized);
}

function persistedState(state) {
  return Object.freeze({
    account_id: state.accountId,
    phase: state.phase,
    last_failure_kind: state.lastFailureKind,
    opened_at: state.openedAt,
    cooldown_until: state.cooldownUntil,
    consecutive_failures: state.consecutiveFailures,
    last_failure_at: state.lastFailureAt,
    last_success_at: state.lastSuccessAt,
    generation: state.generation,
  });
}

function publicSnapshot(state) {
  return Object.freeze({
    account_id: state.accountId,
    phase: state.phase,
    last_failure_kind: state.lastFailureKind,
    opened_at: state.openedAt,
    cooldown_until: state.cooldownUntil,
    consecutive_failures: state.consecutiveFailures,
    last_failure_at: state.lastFailureAt,
    last_success_at: state.lastSuccessAt,
    generation: state.generation,
    half_open_in_flight: state.activeProbeTokens.size,
  });
}

export function createCircuitBreaker({
  now = () => Date.now(),
  cooldowns = DEFAULT_COOLDOWNS,
  maxCooldownMs = 24 * 60 * 60_000,
  halfOpenMaxProbes = 1,
  initialState = null,
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("circuit clock must be a function");
  }
  if (
    !Number.isSafeInteger(maxCooldownMs) ||
    maxCooldownMs < 1 ||
    maxCooldownMs > MAX_ALLOWED_COOLDOWN_MS
  ) {
    throw new Error("maxCooldownMs is invalid");
  }
  const policy = normalizeCooldownPolicy(cooldowns, maxCooldownMs);
  if (!Number.isSafeInteger(halfOpenMaxProbes) || halfOpenMaxProbes < 1 || halfOpenMaxProbes > 16) {
    throw new Error("halfOpenMaxProbes must be an integer from 1 through 16");
  }

  const states = new Map();
  let probeSequence = 0;

  function importAccount(account) {
    states.set(account.account_id, {
      accountId: account.account_id,
      phase: account.phase,
      lastFailureKind: account.last_failure_kind,
      openedAt: account.opened_at,
      cooldownUntil: account.cooldown_until,
      consecutiveFailures: account.consecutive_failures,
      lastFailureAt: account.last_failure_at,
      lastSuccessAt: account.last_success_at,
      generation: account.generation,
      activeProbeTokens: new Set(),
    });
  }

  if (initialState !== null && initialState !== undefined) {
    const normalized = normalizeCircuitStateDocument(initialState);
    for (const account of normalized.accounts) {
      importAccount(account);
    }
  }

  function getState(accountId) {
    assertAccountId(accountId);
    let state = states.get(accountId);
    if (!state) {
      if (states.size >= MAX_ACCOUNTS) {
        throw new Error("circuit account limit reached");
      }
      state = {
        accountId,
        phase: "closed",
        lastFailureKind: null,
        openedAt: null,
        cooldownUntil: null,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        generation: 0,
        activeProbeTokens: new Set(),
      };
      states.set(accountId, state);
    }
    return state;
  }

  function invalidateProbes(state) {
    state.activeProbeTokens.clear();
    state.generation = incrementCounter(state.generation);
  }

  function requireProbe(state, probeToken) {
    if (
      typeof probeToken !== "string" ||
      state.phase !== "half_open" ||
      !state.activeProbeTokens.has(probeToken)
    ) {
      throw new Error("probe token is invalid or stale");
    }
    state.activeProbeTokens.delete(probeToken);
  }

  function issueProbe(state) {
    if (state.activeProbeTokens.size >= halfOpenMaxProbes) {
      return Object.freeze({
        allowed: false,
        probe: false,
        probe_token: null,
        phase: "half_open",
        reason: "half_open_limit",
        cooldown_until: state.cooldownUntil,
      });
    }
    probeSequence = incrementCounter(probeSequence);
    const token = `${state.accountId}.${state.generation}.${probeSequence}`;
    state.activeProbeTokens.add(token);
    return Object.freeze({
      allowed: true,
      probe: true,
      probe_token: token,
      phase: "half_open",
      reason: "half_open_probe",
      cooldown_until: state.cooldownUntil,
    });
  }

  const breaker = {
    tryAcquire(accountId) {
      const state = getState(accountId);
      if (state.phase === "closed") {
        return Object.freeze({
          allowed: true,
          probe: false,
          probe_token: null,
          phase: "closed",
          reason: "closed",
          cooldown_until: null,
        });
      }
      const current = readClock(now);
      if (state.phase === "open") {
        if (current.milliseconds < parseTimestamp(state.cooldownUntil, "cooldown_until")) {
          return Object.freeze({
            allowed: false,
            probe: false,
            probe_token: null,
            phase: "open",
            reason: "cooldown",
            cooldown_until: state.cooldownUntil,
          });
        }
        state.phase = "half_open";
        state.activeProbeTokens.clear();
      } else if (current.milliseconds < parseTimestamp(state.cooldownUntil, "cooldown_until")) {
        state.phase = "open";
        state.activeProbeTokens.clear();
        return Object.freeze({
          allowed: false,
          probe: false,
          probe_token: null,
          phase: "open",
          reason: "cooldown",
          cooldown_until: state.cooldownUntil,
        });
      }
      return issueProbe(state);
    },
    recordFailure(accountId, options = {}) {
      if (!isPlainObject(options)) {
        throw new Error("failure options must be a plain object");
      }
      assertOnlyFields(options, FAILURE_OPTION_FIELDS, "failure options");
      const { kind, retryAfterMs = null, probeToken = null } = options;
      if (!FAILURE_KIND_SET.has(kind)) {
        throw new Error("circuit failure kind is invalid");
      }
      if (retryAfterMs !== null) {
        if (
          (kind !== "rate_limited" && kind !== "quota_exhausted") ||
          !Number.isSafeInteger(retryAfterMs) ||
          retryAfterMs < 0
        ) {
          throw new Error(
            "retryAfterMs is valid only for rate_limited or quota_exhausted failures",
          );
        }
      }
      const state = getState(accountId);
      if (probeToken !== null) {
        requireProbe(state, probeToken);
      } else if (state.phase === "half_open") {
        throw new Error("half-open failure requires a probe token");
      }
      const current = readClock(now);
      const retryDuration =
        retryAfterMs === null ? 0 : Math.min(retryAfterMs, maxCooldownMs);
      const duration = Math.max(policy[kind], retryDuration);
      const cooldownMilliseconds = current.milliseconds + duration;
      const cooldownDate = new Date(cooldownMilliseconds);
      if (!Number.isSafeInteger(cooldownMilliseconds) || Number.isNaN(cooldownDate.getTime())) {
        throw new Error("circuit cooldown timestamp is out of range");
      }
      invalidateProbes(state);
      state.phase = "open";
      state.lastFailureKind = kind;
      state.openedAt = current.iso;
      state.cooldownUntil = cooldownDate.toISOString();
      state.consecutiveFailures = incrementCounter(state.consecutiveFailures);
      state.lastFailureAt = current.iso;
      return publicSnapshot(state);
    },
    recordSuccess(accountId, options = {}) {
      if (!isPlainObject(options)) {
        throw new Error("success options must be a plain object");
      }
      assertOnlyFields(options, SUCCESS_OPTION_FIELDS, "success options");
      const probeToken = options.probeToken ?? null;
      const state = getState(accountId);
      if (probeToken !== null) {
        requireProbe(state, probeToken);
      } else if (state.phase !== "closed") {
        throw new Error("open circuit success requires a half-open probe token");
      }
      const current = readClock(now);
      invalidateProbes(state);
      state.phase = "closed";
      state.openedAt = null;
      state.cooldownUntil = null;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = current.iso;
      return publicSnapshot(state);
    },
    releaseProbe(accountId, probeToken) {
      const state = getState(accountId);
      requireProbe(state, probeToken);
      return true;
    },
    snapshot(accountId) {
      return publicSnapshot(getState(accountId));
    },
    listSnapshots() {
      return Object.freeze(
        [...states.values()]
          .sort((left, right) =>
            left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0)
          .map(publicSnapshot),
      );
    },
    exportState() {
      const current = readClock(now);
      return normalizeCircuitStateDocument({
        version: 1,
        saved_at: current.iso,
        accounts: [...states.values()].map(persistedState),
      });
    },
    toString() {
      return "[CircuitBreaker]";
    },
    toJSON() {
      return "[CircuitBreaker]";
    },
    [inspect.custom]() {
      return "[CircuitBreaker]";
    },
  };
  return Object.freeze(breaker);
}

export { DEFAULT_COOLDOWNS, FAILURE_KINDS };
