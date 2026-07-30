import { inspect } from "node:util";
import { createAccountCatalog } from "./accounts.mjs";
import { createAdminHandler } from "./admin-handler.mjs";
import { createAdminState } from "./admin-state.mjs";
import { parseCodexCredentialBundle } from "./codex-credentials.mjs";
import { createCircuitBreaker } from "./circuit-breaker.mjs";
import { defaults } from "./config.mjs";
import { createEventBroker } from "./event-broker.mjs";
import { createFailoverStateMachine } from "./failover-state-machine.mjs";
import { createModelProxyService } from "./model-service.mjs";
import { createProxyHandler } from "./proxy-handler.mjs";
import { createQuotaSnapshotAdapter } from "./quota-snapshot.mjs";
import {
  circuitStateFromRuntimeState,
  normalizeRuntimeStateDocument,
} from "./runtime-state.mjs";
import { createDeterministicScheduler } from "./scheduler.mjs";
import {
  assertListenerStartDeadline,
  createRouterService,
  DEFAULT_LISTENER_START_DEADLINE_MS,
} from "./service.mjs";
import { createWeeklyQuotaTracker } from "./weekly-quota-tracker.mjs";

const RUNTIME_STATES = Object.freeze({
  CREATED: "created",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
});
const FAILURE_ADMIN_STATES = Object.freeze({
  auth_expired: "auth_expired",
  quota_exhausted: "quota_exhausted",
  rate_limited: "cooling_down",
  network_error: "cooling_down",
  upstream_5xx: "cooling_down",
});
const DEFAULT_MANUAL_SWITCH_DEADLINE_MS = 5_000;
const MAX_MANUAL_SWITCH_DEADLINE_MS = 60_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
const MAX_SHUTDOWN_DEADLINE_MS = 60_000;

function validateOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("runtime upstream origin is invalid");
  }
  if (
    !new Set(["http:", "https:"]).has(origin.protocol) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("runtime upstream origin is invalid");
  }
  return origin.toString();
}

function assertSecretRegistry(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.acquire !== "function" ||
    typeof value.has !== "function"
  ) {
    throw new TypeError("runtime secretRegistry is invalid");
  }
  return value;
}

function assertAuthenticator(value) {
  if (value !== null && (typeof value !== "object" || typeof value.authenticate !== "function")) {
    throw new TypeError("runtime adminAuthenticator is invalid");
  }
  return value;
}

function assertCircuitStateStore(value) {
  if (
    value !== null &&
    (typeof value !== "object" ||
      typeof value.load !== "function" ||
      typeof value.save !== "function")
  ) {
    throw new TypeError("runtime circuitStateStore is invalid");
  }
  return value;
}

function publicAddresses(admin, model) {
  return Object.freeze({ admin, model });
}

function assertListenerService(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.start !== "function" ||
    typeof value.stop !== "function"
  ) {
    throw new TypeError(`${label} listener service is invalid`);
  }
  return value;
}

function startupAbortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("runtime listener start aborted");
}

function awaitStartupOperation(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, startupAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

export async function startRuntimeListeners({
  adminService,
  modelService,
  deadlineMs = DEFAULT_LISTENER_START_DEADLINE_MS,
} = {}) {
  const admin = assertListenerService(adminService, "admin");
  const model = assertListenerService(modelService, "model");
  assertListenerStartDeadline(deadlineMs);
  const controller = new AbortController();
  const signal = controller.signal;
  const deadlineError = new Error("runtime listener start deadline exceeded");
  const timer = setTimeout(() => controller.abort(deadlineError), deadlineMs);
  try {
    const adminAddress = await awaitStartupOperation(admin.start({ signal }), signal);
    const modelAddress = await awaitStartupOperation(model.start({ signal }), signal);
    return publicAddresses(adminAddress, modelAddress);
  } catch (error) {
    const cleanup = Promise.allSettled([
      Promise.resolve().then(() => model.stop()),
      Promise.resolve().then(() => admin.stop()),
    ]);
    try {
      await awaitStartupOperation(cleanup, signal);
    } catch {
      // Listener cleanup shares the same total startup deadline.
    }
    if (signal.aborted) throw startupAbortReason(signal);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createRuntimeComposition({
  accounts,
  secretRegistry,
  upstreamOrigin,
  adminAuthenticator = null,
  circuitStateStore = null,
  initialCircuitState = null,
  manualSwitchDeadlineMs = DEFAULT_MANUAL_SWITCH_DEADLINE_MS,
  listenerStartDeadlineMs = DEFAULT_LISTENER_START_DEADLINE_MS,
  shutdownDeadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
  routingStateStore = null,
  initialRoutingState = null,
  adminHost = defaults.adminHost,
  adminPort = defaults.adminPort,
  modelHost = defaults.modelHost,
  modelPort = defaults.modelPort,
  failoverOptions = {},
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(accounts)) throw new TypeError("runtime accounts must be an array");
  if (typeof now !== "function") throw new TypeError("runtime clock must be a function");
  if (
    !Number.isSafeInteger(manualSwitchDeadlineMs) ||
    manualSwitchDeadlineMs < 1 ||
    manualSwitchDeadlineMs > MAX_MANUAL_SWITCH_DEADLINE_MS
  ) {
    throw new Error("manual switch deadline must be an integer from 1 through 60000");
  }
  const runtimeListenerStartDeadlineMs =
    assertListenerStartDeadline(listenerStartDeadlineMs);
  if (
    !Number.isSafeInteger(shutdownDeadlineMs) ||
    shutdownDeadlineMs < 1 ||
    shutdownDeadlineMs > MAX_SHUTDOWN_DEADLINE_MS
  ) {
    throw new Error("shutdown deadline must be an integer from 1 through 60000");
  }
  const registry = assertSecretRegistry(secretRegistry);
  const authenticator = assertAuthenticator(adminAuthenticator);
  const stateStore = assertCircuitStateStore(circuitStateStore);
  const routeStateStore = assertCircuitStateStore(routingStateStore);
  const origin = validateOrigin(upstreamOrigin);
  const accountCatalog = createAccountCatalog(accounts);
  for (const account of accountCatalog.listPublic()) {
    const binding = accountCatalog.getCredentialBinding(account.id);
    if (!registry.has(binding.secretProvider)) {
      throw new Error("runtime account references an unregistered secret provider");
    }
  }

  const initialRuntimeState = initialCircuitState === null
    ? null
    : normalizeRuntimeStateDocument(initialCircuitState);
  const initialRouteRuntimeState = initialRoutingState === null
    ? null
    : normalizeRuntimeStateDocument(initialRoutingState);
  const scheduler = createDeterministicScheduler({ now });
  const circuitBreaker = createCircuitBreaker({
    now,
    initialState: circuitStateFromRuntimeState(initialRuntimeState),
  });
  const quotaTracker = createWeeklyQuotaTracker({
    accountIds: accountCatalog.listPublic().map(({ id }) => id),
    initialState: initialRuntimeState?.weekly_quota ?? [],
    now,
  });
  const quotaAdapter = createQuotaSnapshotAdapter({
    name: "runtime-weekly-events",
    now,
    observe: async ({ accountId } = {}) => quotaTracker.read(accountId),
  });
  const eventBroker = createEventBroker({ now: () => new Date(now()).toISOString() });
  const publicAccounts = accountCatalog.listPublic();
  const accountIds = Object.freeze(publicAccounts.map(({ id }) => id));
  function restoredRoutableAccountId(accountId) {
    if (accountId === null || accountId === undefined) return null;
    return accountCatalog.getPublic(accountId)?.enabled === true ? accountId : null;
  }
  let preferredAccountId = restoredRoutableAccountId(
    initialRouteRuntimeState?.routing?.preferred_account_id,
  );
  let currentAccountId = restoredRoutableAccountId(
    initialRouteRuntimeState?.routing?.current_account_id,
  );
  const adminState = createAdminState({
    accountCatalog,
    eventBroker,
    initialCurrentAccountId: currentAccountId,
  });
  const activeRequests = new Map(publicAccounts.map(({ id }) => [id, 0]));
  const lastUnavailableReason = new Map();
  const probeTokens = new Map();
  let activeSemanticStreams = 0;
  let pendingPersistence = Promise.resolve();
  let persistenceFailure = null;
  let pendingRoutingPersistence = Promise.resolve();
  let routingPersistenceFailure = null;
  let routingMutationTail = Promise.resolve();
  const shutdownController = new AbortController();

  function persistenceUnavailable() {
    return new Error("runtime state persistence is unavailable");
  }

  function abortReason(signal) {
    return signal?.reason instanceof Error
      ? signal.reason
      : new Error("runtime operation aborted");
  }

  function throwIfAborted(signal) {
    if (signal === null || signal === undefined) return;
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("runtime abort signal is invalid");
    }
    if (signal.aborted) throw abortReason(signal);
  }

  function awaitWithAbort(
    operation,
    signal,
    { onLateResolve = null, onLateReject = null } = {},
  ) {
    if (signal === null || signal === undefined) return operation;
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("runtime abort signal is invalid");
    }
    if (onLateResolve !== null && typeof onLateResolve !== "function") {
      throw new TypeError("runtime late-resolution handler is invalid");
    }
    if (onLateReject !== null && typeof onLateReject !== "function") {
      throw new TypeError("runtime late-rejection handler is invalid");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback(value);
        return true;
      };
      const onAbort = () => {
        finish(reject, abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(operation).then(
        (value) => {
          if (!finish(resolve, value) && onLateResolve !== null) {
            try {
              onLateResolve(value);
            } catch {
              // Late cleanup is best-effort after the caller's bounded operation ended.
            }
          }
        },
        (error) => {
          if (!finish(reject, error) && onLateReject !== null) {
            try {
              onLateReject(error);
            } catch {
              // Late cleanup is best-effort after the caller's bounded operation ended.
            }
          }
        },
      );
      if (signal.aborted) onAbort();
    });
  }

  function exportRuntimeState() {
    return Object.freeze({
      ...circuitBreaker.exportState(),
      weekly_quota: quotaTracker.exportState(),
    });
  }

  function exportRoutingState({
    current = currentAccountId,
    preferred = preferredAccountId,
  } = {}) {
    const circuitState = circuitBreaker.exportState();
    return Object.freeze({
      version: circuitState.version,
      saved_at: circuitState.saved_at,
      accounts: Object.freeze([]),
      routing: Object.freeze({
        current_account_id: current,
        preferred_account_id: preferred,
      }),
    });
  }

  function withRoutingMutation(operation, { signal = null } = {}) {
    if (signal !== null && signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError("runtime abort signal is invalid");
    }
    const invoke = () => {
      throwIfAborted(signal);
      return operation();
    };
    const result = routingMutationTail.then(invoke, invoke);
    routingMutationTail = result.catch(() => undefined);
    return awaitWithAbort(result, signal);
  }

  async function persistRuntimeState({ signal = null } = {}) {
    if (stateStore === null) return;
    if (persistenceFailure !== null) throw persistenceUnavailable();
    try {
      await awaitWithAbort(stateStore.save(exportRuntimeState(), { signal }), signal, {
        onLateReject(error) {
          persistenceFailure = error;
        },
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      persistenceFailure = error;
      throw persistenceUnavailable();
    }
  }

  function queueRuntimeStatePersistence() {
    if (stateStore === null) return;
    const signal = shutdownController.signal;
    const operation = pendingPersistence.then(() => {
      throwIfAborted(signal);
      return awaitWithAbort(stateStore.save(exportRuntimeState(), { signal }), signal, {
        onLateReject(error) {
          if (!signal.aborted) persistenceFailure = error;
        },
      });
    });
    pendingPersistence = operation.catch((error) => {
      if (!signal.aborted) persistenceFailure = error;
    });
  }

  async function persistRoutingState(
    document = exportRoutingState(),
    {
      signal = null,
      abortMakesUnavailable = true,
      beforeCommit = null,
      expectedFailure = null,
    } = {},
  ) {
    if (routeStateStore === null) return;
    if (routingPersistenceFailure !== null) throw persistenceUnavailable();
    try {
      await awaitWithAbort(routeStateStore.save(document, {
        signal,
        beforeCommit,
      }), signal, {
        onLateReject(error) {
          if (expectedFailure !== null && error === expectedFailure) return;
          if (signal?.aborted && error === abortReason(signal)) return;
          routingPersistenceFailure = error;
        },
      });
    } catch (error) {
      if (expectedFailure !== null && error === expectedFailure) throw error;
      if (signal?.aborted && !abortMakesUnavailable) {
        throw abortReason(signal);
      }
      routingPersistenceFailure = error;
      throw persistenceUnavailable();
    }
  }

  function queueRoutingStatePersistence() {
    if (routeStateStore === null) return;
    const signal = shutdownController.signal;
    const operation = pendingRoutingPersistence.then(() => {
      throwIfAborted(signal);
      return awaitWithAbort(routeStateStore.save(exportRoutingState(), { signal }), signal, {
        onLateReject(error) {
          if (!signal.aborted) routingPersistenceFailure = error;
        },
      });
    });
    pendingRoutingPersistence = operation.catch((error) => {
      if (!signal.aborted) routingPersistenceFailure = error;
    });
  }

  for (const account of accountCatalog.listPublic()) {
    if (!account.enabled) continue;
    const restored = circuitBreaker.snapshot(account.id);
    const quota = quotaTracker.read(account.id);
    const quotaStatus = quota === null
      ? {}
      : {
          five_hour_remaining_ratio: null,
          weekly_remaining_ratio: quota.weekly.remaining_ratio,
          snapshot_observed_at: quota.observed_at,
        };
    if (restored.phase === "closed" && restored.last_failure_kind === null) {
      if (quota !== null) {
        adminState.updateAccountStatus(account.id, quotaStatus);
      }
      continue;
    }
    adminState.updateAccountStatus(account.id, {
      ...quotaStatus,
      state: restored.phase === "half_open"
        ? "half_open"
        : restored.phase === "closed"
          ? "healthy"
          : FAILURE_ADMIN_STATES[restored.last_failure_kind],
      cooldown_until: restored.phase === "closed" ? null : restored.cooldown_until,
      last_switch_reason: restored.last_failure_kind,
    });
  }

  function circuitAllowsReadiness(account) {
    if (!account.enabled || activeRequests.get(account.id) >= account.max_concurrency) return false;
    const quota = quotaTracker.read(account.id);
    const quotaIsFresh = quota !== null &&
      Math.max(0, now() - Date.parse(quota.observed_at)) < 5 * 60_000;
    if (
      quotaIsFresh &&
      quota.weekly.remaining_ratio === 0 &&
      quota.weekly.status === "available"
    ) {
      return false;
    }
    const snapshot = circuitBreaker.snapshot(account.id);
    if (snapshot.phase === "closed") return true;
    if (snapshot.cooldown_until === null) return false;
    return Date.parse(snapshot.cooldown_until) <= now() && snapshot.half_open_in_flight === 0;
  }

  function usableAccountCount() {
    if (persistenceFailure !== null || routingPersistenceFailure !== null) return 0;
    return accountCatalog.listPublic().filter(circuitAllowsReadiness).length;
  }

  async function candidates() {
    return await Promise.all(publicAccounts.map(async (account) => {
      const circuit = circuitBreaker.snapshot(account.id);
      return Object.freeze({
        account,
        active_requests: activeRequests.get(account.id),
        cooldown_until: circuit.phase === "closed" ? null : circuit.cooldown_until,
        quota: await quotaAdapter.read({ accountId: account.id }),
      });
    }));
  }

  async function scheduledDecision(excluded, preferred = preferredAccountId) {
    const values = await candidates();
    if (preferred !== null && !excluded.has(preferred)) {
      const forcedExclusions = new Set(excluded);
      for (const accountId of accountIds) {
        if (accountId !== preferred) forcedExclusions.add(accountId);
      }
      const forced = scheduler.select(values, {
        excludeAccountIds: [...forcedExclusions],
      });
      if (forced.status === "selected") return forced;
    }
    return scheduler.select(values, {
      excludeAccountIds: [...excluded],
    });
  }

  function routeReasonFor(accountId) {
    if (currentAccountId === null) return "startup";
    if (currentAccountId === accountId) return null;
    return lastUnavailableReason.get(currentAccountId) ?? "startup";
  }

  async function recordSelectedRoute(accountId, { signal = null } = {}) {
    const reason = routeReasonFor(accountId);
    if (reason === null) {
      lastUnavailableReason.delete(accountId);
      return;
    }
    const fromAccountId = currentAccountId;
    await persistRoutingState(exportRoutingState({
      current: accountId,
      preferred: preferredAccountId,
    }), { signal });
    adminState.recordSwitch({
      fromAccountId,
      toAccountId: accountId,
      reason,
    });
    currentAccountId = accountId;
    lastUnavailableReason.delete(accountId);
  }

  function onSemanticStreamStart() {
    activeSemanticStreams += 1;
    adminState.setActiveStreams(activeSemanticStreams);
  }

  function onSemanticStreamEnd() {
    activeSemanticStreams = Math.max(0, activeSemanticStreams - 1);
    adminState.setActiveStreams(activeSemanticStreams);
  }

  function updateFailureStatus(accountId, kind) {
    const circuit = circuitBreaker.snapshot(accountId);
    adminState.updateAccountStatus(accountId, {
      state: FAILURE_ADMIN_STATES[kind],
      cooldown_until: circuit.cooldown_until,
      last_switch_reason: kind,
    });
  }

  function refreshAvailableStatus(accountId) {
    const circuit = circuitBreaker.snapshot(accountId);
    const quota = quotaTracker.read(accountId);
    const quotaIsFresh = quota !== null &&
      Math.max(0, now() - Date.parse(quota.observed_at)) < 5 * 60_000;
    const quotaExhausted = quotaIsFresh && quota.weekly.remaining_ratio === 0;
    let state;
    let reason;
    if (circuit.phase === "half_open") {
      state = "half_open";
      reason = circuit.last_failure_kind;
    } else if (circuit.phase !== "closed") {
      state = FAILURE_ADMIN_STATES[circuit.last_failure_kind];
      reason = circuit.last_failure_kind;
    } else if (quotaExhausted) {
      state = "quota_exhausted";
      reason = "quota_exhausted";
    } else {
      state = "healthy";
      reason = null;
    }
    adminState.updateAccountStatus(accountId, {
      state,
      five_hour_remaining_ratio: null,
      weekly_remaining_ratio: quota?.weekly.remaining_ratio ?? null,
      snapshot_observed_at: quota?.observed_at ?? null,
      cooldown_until: circuit.phase === "closed" ? null : circuit.cooldown_until,
      ...(reason === null ? {} : { last_switch_reason: reason }),
    });
  }

  function refreshExpiredWeeklyQuota() {
    const expiredAccountIds = quotaTracker.pruneExpired();
    if (expiredAccountIds.length === 0) return;
    for (const accountId of expiredAccountIds) {
      refreshAvailableStatus(accountId);
    }
    queueRuntimeStatePersistence();
  }

  function recordWeeklyQuotaObservation({ accountId, observation }) {
    quotaTracker.record(accountId, observation);
    if (
      observation.weekly.status === "available" &&
      observation.weekly.remaining_ratio === 0
    ) {
      const probeToken = probeTokens.get(accountId) ?? null;
      const resetDelayMs = observation.weekly.resets_at === null
        ? null
        : Math.max(0, Date.parse(observation.weekly.resets_at) - now());
      circuitBreaker.recordFailure(accountId, {
        kind: "quota_exhausted",
        ...(resetDelayMs === null ? {} : { retryAfterMs: resetDelayMs }),
        ...(probeToken === null ? {} : { probeToken }),
      });
      probeTokens.delete(accountId);
      lastUnavailableReason.set(accountId, "quota_exhausted");
      if (preferredAccountId === accountId) preferredAccountId = null;
    }
    queueRuntimeStatePersistence();
    queueRoutingStatePersistence();
    refreshAvailableStatus(accountId);
  }

  function onWeeklyQuotaObservation(payload) {
    return withRoutingMutation(() => recordWeeklyQuotaObservation(payload));
  }

  async function recordAttemptFailure({ accountId, kind, retryAfterMs, signal = null }) {
    throwIfAborted(signal);
    await awaitWithAbort(pendingPersistence, signal);
    throwIfAborted(signal);
    await awaitWithAbort(pendingRoutingPersistence, signal);
    throwIfAborted(signal);
    if (persistenceFailure !== null || routingPersistenceFailure !== null) {
      throw persistenceUnavailable();
    }
    const probeToken = probeTokens.get(accountId) ?? null;
    circuitBreaker.recordFailure(accountId, {
      kind,
      retryAfterMs,
      ...(probeToken === null ? {} : { probeToken }),
    });
    probeTokens.delete(accountId);
    lastUnavailableReason.set(accountId, kind);
    if (preferredAccountId === accountId) preferredAccountId = null;
    updateFailureStatus(accountId, kind);
    await persistRuntimeState({ signal });
    throwIfAborted(signal);
    await persistRoutingState(undefined, { signal });
  }

  function onAttemptFailure(payload) {
    return withRoutingMutation(() => recordAttemptFailure(payload), {
      signal: payload.signal ?? null,
    });
  }

  function releaseSelectionProbe(accountId, circuitLease) {
    if (!circuitLease.probe) return;
    if (probeTokens.get(accountId) !== circuitLease.probe_token) return;
    try {
      circuitBreaker.releaseProbe(accountId, circuitLease.probe_token);
    } finally {
      probeTokens.delete(accountId);
      refreshAvailableStatus(accountId);
    }
  }

  async function resolveUpstreamWithRoutingLock(_route, selectionContext = {}) {
    const selectionSignal = selectionContext.signal ?? null;
    throwIfAborted(selectionSignal);
    await pendingRoutingPersistence;
    if (persistenceFailure !== null || routingPersistenceFailure !== null) {
      throw persistenceUnavailable();
    }
    const excluded = new Set(selectionContext.excludeAccountIds ?? []);
    for (;;) {
      const decision = await scheduledDecision(excluded);
      if (decision.status !== "selected") return null;
      const accountId = decision.selected_account_id;
      const publicAccount = accountCatalog.getPublic(accountId);
      const circuitLease = circuitBreaker.tryAcquire(accountId);
      if (!circuitLease.allowed) {
        excluded.add(accountId);
        continue;
      }
      if (circuitLease.probe) {
        probeTokens.set(accountId, circuitLease.probe_token);
        try {
          await persistRuntimeState({ signal: selectionSignal });
          throwIfAborted(selectionSignal);
        } catch {
          releaseSelectionProbe(accountId, circuitLease);
          if (selectionSignal?.aborted) throw abortReason(selectionSignal);
          throw new Error("runtime circuit state is unavailable");
        }
      }

      const binding = accountCatalog.getCredentialBinding(accountId);
      let secretLease;
      let credential;
      try {
        throwIfAborted(selectionSignal);
        secretLease = await awaitWithAbort(
          registry.acquire(binding.secretProvider, binding.credentialRef),
          selectionSignal,
          {
            onLateResolve(lease) {
              lease.dispose();
            },
          },
        );
        throwIfAborted(selectionSignal);
        credential = secretLease.use((value) => parseCodexCredentialBundle(value));
      } catch (error) {
        secretLease?.dispose();
        if (selectionSignal?.aborted) {
          releaseSelectionProbe(accountId, circuitLease);
          throw abortReason(selectionSignal);
        }
        circuitBreaker.recordFailure(accountId, {
          kind: "auth_expired",
          ...(circuitLease.probe ? { probeToken: circuitLease.probe_token } : {}),
        });
        probeTokens.delete(accountId);
        lastUnavailableReason.set(accountId, "auth_expired");
        if (preferredAccountId === accountId) preferredAccountId = null;
        updateFailureStatus(accountId, "auth_expired");
        await persistRuntimeState({ signal: selectionSignal });
        await persistRoutingState(undefined, { signal: selectionSignal });
        excluded.add(accountId);
        continue;
      }

      try {
        throwIfAborted(selectionSignal);
        await recordSelectedRoute(accountId, {
          signal: selectionSignal,
        });
        throwIfAborted(selectionSignal);
      } catch {
        secretLease.dispose();
        releaseSelectionProbe(accountId, circuitLease);
        if (selectionSignal?.aborted) throw abortReason(selectionSignal);
        throw new Error("runtime route state is unavailable");
      }
      activeRequests.set(accountId, activeRequests.get(accountId) + 1);
      let released = false;
      return {
        accountId,
        origin,
        headers: {
          authorization: credential.authorization,
          "chatgpt-account-id": credential.accountId,
        },
        release() {
          if (released) return;
          released = true;
          secretLease.dispose();
          activeRequests.set(accountId, Math.max(0, activeRequests.get(accountId) - 1));
          const activeProbe = probeTokens.get(accountId);
          if (circuitLease.probe && activeProbe === circuitLease.probe_token) {
            circuitBreaker.recordSuccess(accountId, { probeToken: circuitLease.probe_token });
            probeTokens.delete(accountId);
            queueRuntimeStatePersistence();
          }
          if (circuitBreaker.snapshot(accountId).phase === "closed") {
            refreshAvailableStatus(accountId);
          }
        },
      };
    }
  }

  function resolveUpstream(route, selectionContext = {}) {
    return withRoutingMutation(() =>
      resolveUpstreamWithRoutingLock(route, selectionContext), {
        signal: selectionContext.signal ?? null,
      });
  }

  async function handleSwitchRequest({ accountAlias }, { signal = null } = {}) {
    if (activeSemanticStreams > 0) return Object.freeze({ accepted: false });
    const toAccountId = adminState.findAccountIdByAlias(accountAlias);
    if (toAccountId === null || toAccountId === currentAccountId) {
      return Object.freeze({ accepted: false });
    }
    throwIfAborted(signal);
    await awaitWithAbort(pendingRoutingPersistence, signal);
    throwIfAborted(signal);
    if (routingPersistenceFailure !== null) throw persistenceUnavailable();
    if (activeSemanticStreams > 0) return Object.freeze({ accepted: false });
    const decision = await scheduledDecision(
      new Set(),
      toAccountId,
    );
    throwIfAborted(signal);
    if (
      decision.status !== "selected" ||
      decision.selected_account_id !== toAccountId
    ) {
      return Object.freeze({ accepted: false });
    }
    if (activeSemanticStreams > 0) return Object.freeze({ accepted: false });
    const fromAccountId = currentAccountId;
    const semanticStreamRace = new Error("manual switch semantic stream race");
    try {
      await persistRoutingState(exportRoutingState({
        current: toAccountId,
        preferred: toAccountId,
      }), {
        signal,
        abortMakesUnavailable: false,
        beforeCommit() {
          if (activeSemanticStreams > 0) throw semanticStreamRace;
        },
        expectedFailure: semanticStreamRace,
      });
    } catch (error) {
      if (error === semanticStreamRace) {
        return Object.freeze({ accepted: false });
      }
      throw error;
    }
    if (activeSemanticStreams > 0) {
      await persistRoutingState(undefined, { signal });
      return Object.freeze({ accepted: false });
    }
    preferredAccountId = toAccountId;
    currentAccountId = toAccountId;
    return Object.freeze({
      accepted: true,
      fromAccountId,
      toAccountId,
      reason: "manual",
    });
  }

  function onSwitchRequest(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("manual switch deadline exceeded"));
    }, manualSwitchDeadlineMs);
    timer.unref?.();
    return withRoutingMutation(
      () => handleSwitchRequest(payload, { signal: controller.signal }),
      { signal: controller.signal },
    ).finally(() => clearTimeout(timer));
  }

  const failoverStateMachine = createFailoverStateMachine(failoverOptions);
  const proxyHandler = createProxyHandler({
    resolveUpstream,
    failoverStateMachine,
    onAttemptFailure,
    onSemanticStreamEnd,
    onSemanticStreamStart,
    onWeeklyQuotaObservation,
    quotaNow: now,
  });
  const adminHandler = createAdminHandler({
    authenticator,
    state: adminState,
    eventBroker,
    onStatusRequest: refreshExpiredWeeklyQuota,
    onSwitchRequest,
  });
  const adminService = createRouterService({
    adminHost,
    adminPort,
    getUsableAccountCount: usableAccountCount,
    adminHandler,
  });
  const modelService = createModelProxyService({ modelHost, modelPort, proxyHandler });
  let state = RUNTIME_STATES.CREATED;
  let addresses = null;
  let stopPromise = null;

  async function performStop() {
    const signal = shutdownController.signal;
    const deadlineError = new Error("runtime shutdown deadline exceeded");
    const deadline = setTimeout(() => {
      shutdownController.abort(deadlineError);
    }, shutdownDeadlineMs);
    try {
      await awaitWithAbort(
        Promise.allSettled([modelService.stop(), adminService.stop()]),
        signal,
      );
      await awaitWithAbort(routingMutationTail, signal);
      await awaitWithAbort(pendingPersistence, signal);
      await awaitWithAbort(pendingRoutingPersistence, signal);
      await persistRuntimeState({ signal });
      await persistRoutingState(undefined, { signal });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw error;
    } finally {
      clearTimeout(deadline);
      if (!signal.aborted) {
        shutdownController.abort(new Error("runtime stopped"));
      }
      state = RUNTIME_STATES.STOPPED;
    }
  }

  const runtime = {
    get state() {
      return state;
    },
    get addresses() {
      return addresses;
    },
    async start() {
      if (state !== RUNTIME_STATES.CREATED) {
        throw new Error(`cannot start runtime from ${state} state`);
      }
      state = RUNTIME_STATES.STARTING;
      try {
        addresses = await startRuntimeListeners({
          adminService,
          modelService,
          deadlineMs: runtimeListenerStartDeadlineMs,
        });
        state = RUNTIME_STATES.RUNNING;
        return addresses;
      } catch (error) {
        state = RUNTIME_STATES.STOPPED;
        throw error;
      }
    },
    async stop() {
      if (state === RUNTIME_STATES.STOPPED) return;
      if (state === RUNTIME_STATES.CREATED) {
        state = RUNTIME_STATES.STOPPED;
        return;
      }
      if (stopPromise !== null) return stopPromise;
      state = RUNTIME_STATES.STOPPING;
      stopPromise = performStop();
      return stopPromise;
    },
    toString() {
      return "[RuntimeComposition]";
    },
    toJSON() {
      return "[RuntimeComposition]";
    },
    [inspect.custom]() {
      return "[RuntimeComposition]";
    },
  };
  return Object.freeze(runtime);
}

export { RUNTIME_STATES };
