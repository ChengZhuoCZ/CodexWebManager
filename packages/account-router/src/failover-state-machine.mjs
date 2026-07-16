import { classifyResponseEvent } from "./semantic-events.mjs";

const RETRYABLE_FAILURE_KINDS = new Set([
  "auth_expired",
  "network_error",
  "quota_exhausted",
  "rate_limited",
  "upstream_5xx",
]);
const ATTEMPT_FAILURE_KINDS = new Set([
  ...RETRYABLE_FAILURE_KINDS,
  "client_cancelled",
  "protocol_error",
]);
const RESULT_CODES = new Set([
  ...ATTEMPT_FAILURE_KINDS,
  "all_accounts_unavailable",
  "unsafe_to_replay",
]);
const REPLAY_POLICIES = new Set(["initial_request", "continuation_request", "never"]);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ATTEMPTS = 16;
const MAX_TOTAL_DEADLINE_MS = 60 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;

class DeadlineReachedError extends Error {
  constructor() {
    super("failover total deadline reached");
    this.name = "DeadlineReachedError";
  }
}

class ClientCancelledError extends Error {
  constructor() {
    super("client cancelled failover operation");
    this.name = "ClientCancelledError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function integerOption(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function readClock(now) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(milliseconds)) {
    throw new Error("failover clock must return integer epoch milliseconds");
  }
  if (Number.isNaN(new Date(milliseconds).getTime())) {
    throw new Error("failover clock returned an out-of-range timestamp");
  }
  return milliseconds;
}

function assertAccountId(value) {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error("selected account id is invalid");
  }
  return value;
}

function resultStatusCode(code) {
  if (code === "unsafe_to_replay") return 409;
  if (code === "all_accounts_unavailable") return 503;
  if (code === "client_cancelled") return 499;
  return 502;
}

function defaultSleep(milliseconds, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new ClientCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new ClientCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function remainingTime(now, deadlineAt) {
  return deadlineAt - readClock(now);
}

async function beforeDeadline({ invoke, now, deadlineAt, externalSignal }) {
  if (externalSignal?.aborted) throw new ClientCancelledError();
  const remaining = remainingTime(now, deadlineAt);
  if (remaining <= 0) throw new DeadlineReachedError();

  const controller = new AbortController();
  let rejectBoundary;
  const boundary = new Promise((_, reject) => { rejectBoundary = reject; });
  const onExternalAbort = () => {
    const error = new ClientCancelledError();
    controller.abort(error);
    rejectBoundary(error);
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new DeadlineReachedError();
    controller.abort(error);
    rejectBoundary(error);
  }, remaining);

  try {
    const operation = Promise.resolve().then(() => invoke(controller.signal));
    return await Promise.race([operation, boundary]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function reasonForFailure(error) {
  if (error instanceof DeadlineReachedError) return "total_deadline_exceeded";
  if (error instanceof ClientCancelledError) return "client_cancelled";
  return "non_retryable_failure";
}

function normalizeAttemptError(error) {
  if (error instanceof FailoverAttemptError) return error;
  if (error instanceof ClientCancelledError) return new FailoverAttemptError("client_cancelled");
  return new FailoverAttemptError("protocol_error");
}

function resultError(code, reason, attempts, semanticOutput) {
  return new FailoverResultError(code, { reason, attempts, semanticOutput });
}

function selectionReleaser(selection) {
  if (selection.release !== undefined && typeof selection.release !== "function") {
    throw new Error("selection release must be a function");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      selection.release?.();
    } catch {
      // Selection cleanup is best-effort and never changes replay safety.
    }
  };
}

export class FailoverAttemptError extends Error {
  constructor(kind, { retryAfterMs = null } = {}) {
    if (!ATTEMPT_FAILURE_KINDS.has(kind)) {
      throw new Error("failover attempt failure kind is invalid");
    }
    if (
      retryAfterMs !== null &&
      (kind !== "rate_limited" ||
        !Number.isSafeInteger(retryAfterMs) ||
        retryAfterMs < 0 ||
        retryAfterMs > MAX_RETRY_AFTER_MS)
    ) {
      throw new Error("retryAfterMs is invalid for this failover failure");
    }
    super(`failover attempt failed: ${kind}`);
    this.name = "FailoverAttemptError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    Object.freeze(this);
  }
}

export class FailoverResultError extends Error {
  constructor(code, { reason, attempts, semanticOutput }) {
    if (!RESULT_CODES.has(code)) throw new Error("failover result code is invalid");
    if (typeof reason !== "string" || !REASON_PATTERN.test(reason)) {
      throw new Error("failover result reason is invalid");
    }
    if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > MAX_ATTEMPTS) {
      throw new Error("failover result attempts is invalid");
    }
    if (typeof semanticOutput !== "boolean") {
      throw new Error("failover result semanticOutput is invalid");
    }
    super(`failover stopped: ${code}`);
    this.name = "FailoverResultError";
    this.code = code;
    this.reason = reason;
    this.attempts = attempts;
    this.semanticOutput = semanticOutput;
    this.statusCode = resultStatusCode(code);
    Object.freeze(this);
  }
}

export function failoverErrorBody(error) {
  if (!(error instanceof FailoverResultError)) {
    throw new TypeError("failover result error is required");
  }
  return Object.freeze({
    error: Object.freeze({
      type: error.code,
      reason: error.reason,
      attempts: error.attempts,
      semantic_output: error.semanticOutput,
    }),
  });
}

export function createFailoverStateMachine({
  now = () => Date.now(),
  sleep = defaultSleep,
  maxAttempts = 3,
  totalDeadlineMs = 120_000,
  baseBackoffMs = 100,
  maxBackoffMs = 2_000,
} = {}) {
  if (typeof now !== "function") throw new TypeError("failover clock must be a function");
  if (typeof sleep !== "function") throw new TypeError("failover sleep must be a function");
  integerOption(maxAttempts, "maxAttempts", 1, MAX_ATTEMPTS);
  integerOption(totalDeadlineMs, "totalDeadlineMs", 1, MAX_TOTAL_DEADLINE_MS);
  integerOption(baseBackoffMs, "baseBackoffMs", 1, MAX_BACKOFF_MS);
  integerOption(maxBackoffMs, "maxBackoffMs", 1, MAX_BACKOFF_MS);
  if (baseBackoffMs > maxBackoffMs) {
    throw new Error("baseBackoffMs must not exceed maxBackoffMs");
  }

  return Object.freeze({
    async execute({
      replayPolicy,
      selectAccount,
      attempt,
      onAttemptFailure = async () => undefined,
      signal = null,
    } = {}) {
      if (!REPLAY_POLICIES.has(replayPolicy)) {
        throw new Error("replayPolicy must be initial_request, continuation_request, or never");
      }
      if (typeof selectAccount !== "function") {
        throw new TypeError("selectAccount must be a function");
      }
      if (typeof attempt !== "function") throw new TypeError("attempt must be a function");
      if (typeof onAttemptFailure !== "function") {
        throw new TypeError("onAttemptFailure must be a function");
      }
      if (signal !== null && !(signal instanceof AbortSignal)) {
        throw new TypeError("signal must be an AbortSignal or null");
      }

      const startedAt = readClock(now);
      const deadlineAt = startedAt + totalDeadlineMs;
      if (!Number.isSafeInteger(deadlineAt) || Number.isNaN(new Date(deadlineAt).getTime())) {
        throw new Error("failover deadline is out of range");
      }
      const excluded = new Set();
      let attempts = 0;
      let semanticOutput = false;

      for (;;) {
        let selection;
        try {
          selection = await beforeDeadline({
            now,
            deadlineAt,
            externalSignal: signal,
            invoke: (attemptSignal) => selectAccount(Object.freeze({
              attempt: attempts + 1,
              excludeAccountIds: Object.freeze([...excluded]),
              remainingMs: Math.max(0, remainingTime(now, deadlineAt)),
              signal: attemptSignal,
            })),
          });
        } catch (error) {
          if (error instanceof ClientCancelledError) {
            throw resultError("client_cancelled", "client_cancelled", attempts, semanticOutput);
          }
          if (error instanceof DeadlineReachedError) {
            throw resultError(
              "all_accounts_unavailable",
              "total_deadline_exceeded",
              attempts,
              semanticOutput,
            );
          }
          throw resultError("protocol_error", "selector_failed", attempts, semanticOutput);
        }

        if (selection === null) {
          throw resultError(
            "all_accounts_unavailable",
            "no_eligible_account",
            attempts,
            semanticOutput,
          );
        }
        if (!isPlainObject(selection)) {
          throw resultError("protocol_error", "selector_result_invalid", attempts, semanticOutput);
        }
        let releaseSelection;
        try {
          releaseSelection = selectionReleaser(selection);
        } catch {
          throw resultError("protocol_error", "selector_result_invalid", attempts, semanticOutput);
        }
        let accountId;
        try {
          accountId = assertAccountId(selection.accountId);
        } catch {
          releaseSelection();
          throw resultError("protocol_error", "selector_result_invalid", attempts, semanticOutput);
        }
        if (excluded.has(accountId)) {
          releaseSelection();
          throw resultError(
            "all_accounts_unavailable",
            "selector_violated_exclusion",
            attempts,
            semanticOutput,
          );
        }

        attempts += 1;
        let activeAttempt = true;
        const observeEvent = (eventType) => {
          if (!activeAttempt) throw new Error("response event observed outside active attempt");
          const classification = classifyResponseEvent(eventType);
          if (classification !== "preflight") semanticOutput = true;
          return classification;
        };

        try {
          const value = await beforeDeadline({
            now,
            deadlineAt,
            externalSignal: signal,
            invoke: (attemptSignal) => attempt(Object.freeze({
              accountId,
              attempt: attempts,
              observeEvent,
              remainingMs: Math.max(0, remainingTime(now, deadlineAt)),
              selection,
              signal: attemptSignal,
            })),
          });
          activeAttempt = false;
          releaseSelection();
          return Object.freeze({
            status: "completed",
            attempts,
            semantic_output: semanticOutput,
            value,
          });
        } catch (rawError) {
          activeAttempt = false;
          if (rawError instanceof DeadlineReachedError) {
            releaseSelection();
            throw resultError(
              "all_accounts_unavailable",
              "total_deadline_exceeded",
              attempts,
              semanticOutput,
            );
          }
          if (rawError instanceof ClientCancelledError || signal?.aborted) {
            releaseSelection();
            throw resultError("client_cancelled", "client_cancelled", attempts, semanticOutput);
          }
          const failure = normalizeAttemptError(rawError);
          let failureCallbackFailed = false;
          try {
            if (RETRYABLE_FAILURE_KINDS.has(failure.kind)) {
              try {
                await beforeDeadline({
                  now,
                  deadlineAt,
                  externalSignal: signal,
                  invoke: () => onAttemptFailure(Object.freeze({
                    accountId,
                    attempt: attempts,
                    kind: failure.kind,
                    retryAfterMs: failure.retryAfterMs,
                    semanticOutput,
                  })),
                });
              } catch (error) {
                if (error instanceof DeadlineReachedError) {
                  throw resultError(
                    "all_accounts_unavailable",
                    "total_deadline_exceeded",
                    attempts,
                    semanticOutput,
                  );
                }
                if (error instanceof ClientCancelledError) {
                  throw resultError("client_cancelled", "client_cancelled", attempts, semanticOutput);
                }
                failureCallbackFailed = true;
              }
            }
          } finally {
            releaseSelection();
          }

          if (semanticOutput) {
            throw resultError(
              "unsafe_to_replay",
              "semantic_output_committed",
              attempts,
              true,
            );
          }
          if (replayPolicy !== "initial_request") {
            throw resultError(
              "unsafe_to_replay",
              replayPolicy === "continuation_request"
                ? "continuation_connection_not_portable"
                : "request_not_replayable",
              attempts,
              false,
            );
          }
          if (failureCallbackFailed) {
            throw resultError("protocol_error", "failure_callback_failed", attempts, false);
          }
          if (!RETRYABLE_FAILURE_KINDS.has(failure.kind)) {
            throw resultError(failure.kind, reasonForFailure(failure), attempts, false);
          }

          excluded.add(accountId);
          if (attempts >= maxAttempts) {
            throw resultError(
              "all_accounts_unavailable",
              "max_attempts_exhausted",
              attempts,
              false,
            );
          }
          const exponential = Math.min(
            maxBackoffMs,
            baseBackoffMs * (2 ** Math.min(attempts - 1, 30)),
          );
          const delay = Math.min(
            maxBackoffMs,
            Math.max(exponential, failure.retryAfterMs ?? 0),
          );
          const remaining = remainingTime(now, deadlineAt);
          if (remaining <= delay) {
            throw resultError(
              "all_accounts_unavailable",
              "total_deadline_exceeded",
              attempts,
              false,
            );
          }
          try {
            await beforeDeadline({
              now,
              deadlineAt,
              externalSignal: signal,
              invoke: (sleepSignal) => sleep(delay, { signal: sleepSignal }),
            });
          } catch (error) {
            if (error instanceof ClientCancelledError) {
              throw resultError("client_cancelled", "client_cancelled", attempts, false);
            }
            if (error instanceof DeadlineReachedError) {
              throw resultError(
                "all_accounts_unavailable",
                "total_deadline_exceeded",
                attempts,
                false,
              );
            }
            throw resultError("protocol_error", "backoff_failed", attempts, false);
          }
        }
      }
    },
  });
}

export const failoverPolicy = Object.freeze({
  retryable_failure_kinds: Object.freeze([...RETRYABLE_FAILURE_KINDS].sort()),
  max_attempts: MAX_ATTEMPTS,
  max_total_deadline_ms: MAX_TOTAL_DEADLINE_MS,
  max_backoff_ms: MAX_BACKOFF_MS,
});
