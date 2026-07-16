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
import { createDeterministicScheduler } from "./scheduler.mjs";
import { createRouterService } from "./service.mjs";

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

function publicAddresses(admin, model) {
  return Object.freeze({ admin, model });
}

export function createRuntimeComposition({
  accounts,
  secretRegistry,
  upstreamOrigin,
  adminAuthenticator = null,
  adminHost = defaults.adminHost,
  adminPort = defaults.adminPort,
  modelHost = defaults.modelHost,
  modelPort = defaults.modelPort,
  failoverOptions = {},
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(accounts)) throw new TypeError("runtime accounts must be an array");
  if (typeof now !== "function") throw new TypeError("runtime clock must be a function");
  const registry = assertSecretRegistry(secretRegistry);
  const authenticator = assertAuthenticator(adminAuthenticator);
  const origin = validateOrigin(upstreamOrigin);
  const accountCatalog = createAccountCatalog(accounts);
  for (const account of accountCatalog.listPublic()) {
    const binding = accountCatalog.getCredentialBinding(account.id);
    if (!registry.has(binding.secretProvider)) {
      throw new Error("runtime account references an unregistered secret provider");
    }
  }

  const scheduler = createDeterministicScheduler({ now });
  const circuitBreaker = createCircuitBreaker({ now });
  const quotaAdapter = createQuotaSnapshotAdapter({
    name: "runtime-unavailable",
    now,
    observe: async () => null,
  });
  const eventBroker = createEventBroker({ now: () => new Date(now()).toISOString() });
  const adminState = createAdminState({ accountCatalog, eventBroker });
  const activeRequests = new Map(accountCatalog.listPublic().map(({ id }) => [id, 0]));
  const probeTokens = new Map();

  function circuitAllowsReadiness(account) {
    if (!account.enabled || activeRequests.get(account.id) >= account.max_concurrency) return false;
    const snapshot = circuitBreaker.snapshot(account.id);
    if (snapshot.phase === "closed") return true;
    if (snapshot.cooldown_until === null) return false;
    return Date.parse(snapshot.cooldown_until) <= now() && snapshot.half_open_in_flight === 0;
  }

  function usableAccountCount() {
    return accountCatalog.listPublic().filter(circuitAllowsReadiness).length;
  }

  async function candidates() {
    return await Promise.all(accountCatalog.listPublic().map(async (account) => {
      const circuit = circuitBreaker.snapshot(account.id);
      return Object.freeze({
        account,
        active_requests: activeRequests.get(account.id),
        cooldown_until: circuit.phase === "closed" ? null : circuit.cooldown_until,
        quota: await quotaAdapter.read({ accountId: account.id }),
      });
    }));
  }

  function updateFailureStatus(accountId, kind) {
    const circuit = circuitBreaker.snapshot(accountId);
    adminState.updateAccountStatus(accountId, {
      state: FAILURE_ADMIN_STATES[kind],
      cooldown_until: circuit.cooldown_until,
      last_switch_reason: kind,
    });
  }

  async function onAttemptFailure({ accountId, kind, retryAfterMs }) {
    const probeToken = probeTokens.get(accountId) ?? null;
    circuitBreaker.recordFailure(accountId, {
      kind,
      retryAfterMs,
      ...(probeToken === null ? {} : { probeToken }),
    });
    probeTokens.delete(accountId);
    updateFailureStatus(accountId, kind);
  }

  async function resolveUpstream(_route, selectionContext = {}) {
    const excluded = new Set(selectionContext.excludeAccountIds ?? []);
    for (;;) {
      const decision = scheduler.select(await candidates(), {
        excludeAccountIds: [...excluded],
      });
      if (decision.status !== "selected") return null;
      const accountId = decision.selected_account_id;
      const publicAccount = accountCatalog.getPublic(accountId);
      const circuitLease = circuitBreaker.tryAcquire(accountId);
      if (!circuitLease.allowed) {
        excluded.add(accountId);
        continue;
      }
      if (circuitLease.probe) probeTokens.set(accountId, circuitLease.probe_token);

      const binding = accountCatalog.getCredentialBinding(accountId);
      let secretLease;
      let credential;
      try {
        secretLease = await registry.acquire(binding.secretProvider, binding.credentialRef);
        credential = secretLease.use((value) => parseCodexCredentialBundle(value));
      } catch {
        secretLease?.dispose();
        circuitBreaker.recordFailure(accountId, {
          kind: "auth_expired",
          ...(circuitLease.probe ? { probeToken: circuitLease.probe_token } : {}),
        });
        probeTokens.delete(accountId);
        updateFailureStatus(accountId, "auth_expired");
        excluded.add(accountId);
        continue;
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
          }
          if (circuitBreaker.snapshot(accountId).phase === "closed") {
            adminState.updateAccountStatus(accountId, {
              state: "healthy",
              cooldown_until: null,
              last_switch_reason: null,
            });
          }
        },
      };
    }
  }

  const failoverStateMachine = createFailoverStateMachine(failoverOptions);
  const proxyHandler = createProxyHandler({
    resolveUpstream,
    failoverStateMachine,
    onAttemptFailure,
  });
  const adminHandler = createAdminHandler({
    authenticator,
    state: adminState,
    eventBroker,
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
        const admin = await adminService.start();
        let model;
        try {
          model = await modelService.start();
        } catch (error) {
          await adminService.stop();
          throw error;
        }
        addresses = publicAddresses(admin, model);
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
      if (state === RUNTIME_STATES.STOPPING) return;
      state = RUNTIME_STATES.STOPPING;
      await Promise.allSettled([modelService.stop(), adminService.stop()]);
      state = RUNTIME_STATES.STOPPED;
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
