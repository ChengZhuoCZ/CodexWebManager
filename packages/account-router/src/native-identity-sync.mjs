const SWITCH_REASONS = new Set([
  "manual",
  "startup",
  "quota_exhausted",
  "rate_limited",
  "auth_expired",
  "network_error",
  "upstream_5xx",
]);

function requiredCallback(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} callback is required`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedDuration(value, label, minimum, maximum) {
  return boundedInteger(value, label, minimum, maximum);
}

function errorChainIncludes(error, fragment) {
  const visited = new Set();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current.message.includes(fragment)) return true;
    current = current.cause;
  }
  return false;
}

function failureStage(error) {
  if (
    errorChainIncludes(error, "router is not idle") ||
    errorChainIncludes(error, "account route changed concurrently") ||
    errorChainIncludes(error, ".account-enrollment.lock")
  ) return "router_busy";
  if (errorChainIncludes(error, "systemctl operation failed")) return "service_control_failed";
  if (errorChainIncludes(error, "App Server readiness failed")) return "app_server_not_ready";
  return "rebind_failed";
}

function elapsedMilliseconds(now, startedAt) {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, now() - startedAt));
}

function sanitizeEventTrigger(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    !SWITCH_REASONS.has(value.reason) ||
    !Number.isSafeInteger(value.routeAttempts) || value.routeAttempts < 1 || value.routeAttempts > 16 ||
    typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))
  ) throw new Error("native identity sync trigger is invalid");
  return Object.freeze({
    trigger: "router_switch_event",
    reason: value.reason,
    routeAttempts: value.routeAttempts,
    timestamp: value.timestamp,
  });
}

function fallbackTrigger(now) {
  return Object.freeze({
    trigger: "poll_fallback",
    reason: null,
    routeAttempts: 0,
    timestamp: new Date(now).toISOString(),
  });
}

function telemetryRecord({ trigger, stage, reason, routeAttempts, syncAttempts, elapsedMs }) {
  return Object.freeze({
    event: "native_identity_sync",
    trigger,
    stage,
    switch_reason: reason,
    route_attempts: routeAttempts,
    sync_attempts: syncAttempts,
    elapsed_ms: elapsedMs,
    credentials_exposed: false,
  });
}

export function createNativeIdentitySyncController({
  reconcile,
  restartWeb,
  emitTelemetry,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  fallbackIntervalMs = 3_000,
  retryDeadlineMs = 120_000,
  initialBackoffMs = 50,
  maximumBackoffMs = 1_000,
} = {}) {
  const reconcileIdentity = requiredCallback(reconcile, "native identity reconcile");
  const restart = requiredCallback(restartWeb, "Web restart");
  const emit = requiredCallback(emitTelemetry, "native identity telemetry");
  const clock = requiredCallback(now, "native identity clock");
  const wait = requiredCallback(sleep, "native identity sleep");
  const scheduleInterval = requiredCallback(setIntervalImpl, "native identity interval");
  const cancelInterval = requiredCallback(clearIntervalImpl, "native identity interval cancellation");
  const fallbackInterval = boundedDuration(fallbackIntervalMs, "fallback interval", 100, 60_000);
  const retryDeadline = boundedDuration(retryDeadlineMs, "retry deadline", 100, 300_000);
  const initialBackoff = boundedDuration(initialBackoffMs, "initial backoff", 10, 10_000);
  const maximumBackoff = boundedDuration(maximumBackoffMs, "maximum backoff", initialBackoff, 30_000);
  let interval = null;
  let running = null;
  let pendingEvent = null;
  let stopped = false;

  async function execute(trigger) {
    const startedAt = clock();
    const deadline = startedAt + retryDeadline;
    let syncAttempts = 0;
    let backoff = initialBackoff;
    while (!stopped) {
      syncAttempts += 1;
      try {
        const result = await reconcileIdentity();
        if (result?.rebound === true) await restart();
        if (trigger.trigger === "router_switch_event" || result?.rebound === true) {
          emit(telemetryRecord({
            ...trigger,
            stage: "completed",
            syncAttempts,
            elapsedMs: elapsedMilliseconds(clock, startedAt),
          }));
        }
        return result;
      } catch (error) {
        const stage = failureStage(error);
        if (trigger.trigger === "router_switch_event" && clock() + backoff <= deadline) {
          await wait(backoff);
          backoff = Math.min(backoff * 2, maximumBackoff);
          continue;
        }
        emit(telemetryRecord({
          ...trigger,
          stage,
          syncAttempts,
          elapsedMs: elapsedMilliseconds(clock, startedAt),
        }));
        return null;
      }
    }
    return null;
  }

  function drain(trigger) {
    if (running !== null) {
      if (trigger.trigger === "router_switch_event") pendingEvent = trigger;
      return running;
    }
    running = (async () => {
      let current = trigger;
      while (current !== null && !stopped) {
        pendingEvent = null;
        await execute(current);
        current = pendingEvent;
      }
    })().finally(() => { running = null; });
    return running;
  }

  function triggerEvent(value) {
    if (stopped) return Promise.resolve();
    return drain(sanitizeEventTrigger(value));
  }

  function triggerFallback() {
    if (stopped || running !== null) return running ?? Promise.resolve();
    return drain(fallbackTrigger(clock()));
  }

  function start() {
    if (stopped || interval !== null) return;
    interval = scheduleInterval(() => { void triggerFallback(); }, fallbackInterval);
    interval?.unref?.();
    void triggerFallback();
  }

  async function stop() {
    stopped = true;
    if (interval !== null) {
      cancelInterval(interval);
      interval = null;
    }
    await running;
  }

  return Object.freeze({ start, stop, triggerEvent, triggerFallback });
}

export function createSanitizedIdentitySyncLogger(write = (line) => process.stdout.write(line)) {
  const output = requiredCallback(write, "native identity telemetry output");
  return (record) => {
    if (
      record === null || typeof record !== "object" || Array.isArray(record) ||
      record.event !== "native_identity_sync" ||
      !new Set(["router_switch_event", "poll_fallback", "event_stream"]).has(record.trigger) ||
      !new Set([
        "completed", "router_busy", "service_control_failed", "app_server_not_ready",
        "rebind_failed", "event_stream_unavailable",
      ]).has(record.stage) ||
      !(record.switch_reason === null || SWITCH_REASONS.has(record.switch_reason)) ||
      !Number.isSafeInteger(record.route_attempts) || record.route_attempts < 0 || record.route_attempts > 16 ||
      !Number.isSafeInteger(record.sync_attempts) || record.sync_attempts < 1 || record.sync_attempts > 1_000_000 ||
      !Number.isSafeInteger(record.elapsed_ms) || record.elapsed_ms < 0 ||
      record.credentials_exposed !== false || Object.keys(record).length !== 8
    ) throw new Error("native identity telemetry is invalid");
    output(`${JSON.stringify(record)}\n`);
  };
}

export function sanitizedEventStreamFailure({ attempts, elapsedMs }) {
  return telemetryRecord({
    trigger: "event_stream",
    stage: "event_stream_unavailable",
    reason: null,
    routeAttempts: 0,
    syncAttempts: boundedInteger(attempts, "event stream attempts", 1, 1_000_000),
    elapsedMs: boundedInteger(elapsedMs, "event stream elapsed", 0, Number.MAX_SAFE_INTEGER),
  });
}
