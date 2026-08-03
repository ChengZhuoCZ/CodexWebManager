import { createEventBroker } from "./event-broker.mjs";

const ACCOUNT_STATES = new Set([
  "healthy",
  "cooling_down",
  "half_open",
  "auth_expired",
  "quota_exhausted",
  "disabled",
  "unknown",
]);
const SWITCH_REASONS = new Set([
  "manual",
  "startup",
  "quota_exhausted",
  "rate_limited",
  "auth_expired",
  "network_error",
  "upstream_5xx",
]);
const STATUS_FIELDS = new Set([
  "state",
  "five_hour_remaining_ratio",
  "weekly_remaining_ratio",
  "snapshot_observed_at",
  "cooldown_until",
  "last_switch_reason",
]);

function assertAccountCatalog(accountCatalog) {
  if (
    accountCatalog === null ||
    typeof accountCatalog !== "object" ||
    typeof accountCatalog.listPublic !== "function" ||
    typeof accountCatalog.getPublic !== "function"
  ) {
    throw new TypeError("accountCatalog is invalid");
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertRatio(value, field) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error(`${field} must be null or a number from 0 through 1`);
  }
  return value;
}

function assertTimestamp(value, field) {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error(`${field} must be null or an ISO timestamp`);
  }
  return value;
}

function freezeStatus(status) {
  return Object.freeze({
    alias: status.alias,
    state: status.state,
    enabled: status.enabled,
    five_hour_remaining_ratio: status.five_hour_remaining_ratio,
    weekly_remaining_ratio: status.weekly_remaining_ratio,
    snapshot_observed_at: status.snapshot_observed_at,
    cooldown_until: status.cooldown_until,
    last_switch_reason: status.last_switch_reason,
  });
}

export function createAdminState({
  accountCatalog,
  eventBroker = createEventBroker(),
  initialCurrentAccountId = null,
} = {}) {
  assertAccountCatalog(accountCatalog);
  if (eventBroker === null || typeof eventBroker.publish !== "function") {
    throw new TypeError("eventBroker is invalid");
  }
  const runtimeById = new Map();
  const idByAlias = new Map();
  for (const account of accountCatalog.listPublic()) {
    if (idByAlias.has(account.alias)) {
      throw new Error("public account aliases must be unique");
    }
    idByAlias.set(account.alias, account.id);
    runtimeById.set(account.id, {
      alias: account.alias,
      enabled: account.enabled,
      state: account.enabled ? "unknown" : "disabled",
      five_hour_remaining_ratio: null,
      weekly_remaining_ratio: null,
      snapshot_observed_at: null,
      cooldown_until: null,
      last_switch_reason: null,
    });
  }
  let activeStreams = 0;
  let activeRequests = 0;
  let currentRoute;
  if (initialCurrentAccountId === null) {
    currentRoute = null;
  } else {
    const initialAccount = accountCatalog.getPublic(initialCurrentAccountId);
    if (!initialAccount?.enabled) {
      throw new Error("initial current account is unknown or disabled");
    }
    currentRoute = Object.freeze({
      account_alias: initialAccount.alias,
      continuity: "new_backend_session",
    });
  }

  function requireAccount(accountId) {
    const account = accountCatalog.getPublic(accountId);
    if (!account) {
      throw new Error("unknown account");
    }
    return account;
  }

  function listAccounts() {
    return Object.freeze(
      accountCatalog.listPublic().map(({ id }) => freezeStatus(runtimeById.get(id))),
    );
  }

  return Object.freeze({
    get activeStreams() {
      return activeStreams;
    },
    get activeRequests() {
      return activeRequests;
    },
    listAccounts,
    snapshot() {
      const accounts = listAccounts();
      const status =
        accounts.length === 0
          ? "unavailable"
          : accounts.some((account) => account.state === "healthy")
            ? "ready"
            : "degraded";
      return Object.freeze({
        status,
        architecture_mode: "LIMITED_MODE",
        cross_account_e2e_verified: false,
        active_streams: activeStreams,
        active_requests: activeRequests,
        current_route: currentRoute,
        accounts,
      });
    },
    setActiveStreams(value) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
        throw new Error("active stream count must be an integer from 0 through 1000000");
      }
      activeStreams = value;
    },
    setActiveRequests(value) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
        throw new Error("active request count must be an integer from 0 through 1000000");
      }
      activeRequests = value;
    },
    updateAccountStatus(accountId, updates) {
      requireAccount(accountId);
      assertPlainObject(updates, "account status update");
      for (const field of Object.keys(updates)) {
        if (!STATUS_FIELDS.has(field)) {
          throw new Error(`unsupported account status field: ${field}`);
        }
      }
      const runtime = runtimeById.get(accountId);
      if (Object.hasOwn(updates, "state")) {
        if (!ACCOUNT_STATES.has(updates.state)) {
          throw new Error("account state is invalid");
        }
        runtime.state = updates.state;
      }
      for (const field of ["five_hour_remaining_ratio", "weekly_remaining_ratio"]) {
        if (Object.hasOwn(updates, field)) {
          runtime[field] = assertRatio(updates[field], field);
        }
      }
      for (const field of ["snapshot_observed_at", "cooldown_until"]) {
        if (Object.hasOwn(updates, field)) {
          runtime[field] = assertTimestamp(updates[field], field);
        }
      }
      if (Object.hasOwn(updates, "last_switch_reason")) {
        const reason = updates.last_switch_reason;
        if (reason !== null && !SWITCH_REASONS.has(reason)) {
          throw new Error("last_switch_reason is invalid");
        }
        runtime.last_switch_reason = reason;
      }
      return freezeStatus(runtime);
    },
    findAccountIdByAlias(alias) {
      return idByAlias.get(alias) ?? null;
    },
    recordSwitch({ fromAccountId, toAccountId, reason, attempts = 1 }) {
      const fromAccount = fromAccountId === null ? null : requireAccount(fromAccountId);
      const toAccount = requireAccount(toAccountId);
      if (!SWITCH_REASONS.has(reason)) {
        throw new Error("switch reason is invalid");
      }
      if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) {
        throw new Error("switch attempts is invalid");
      }
      currentRoute = Object.freeze({
        account_alias: toAccount.alias,
        continuity: "new_backend_session",
      });
      runtimeById.get(toAccountId).last_switch_reason = reason;
      return eventBroker.publish({
        type: "router.switch",
        data: {
          from_alias: fromAccount?.alias ?? null,
          to_alias: toAccount.alias,
          reason,
          attempts,
          stage: "route_committed",
          continuity: "new_backend_session",
          architecture_mode: "LIMITED_MODE",
        },
      });
    },
  });
}
