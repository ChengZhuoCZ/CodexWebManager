import {
  failoverDefaults,
  failoverPolicy,
} from "./failover-state-machine.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const DEFAULT_MODEL_HOST = "127.0.0.1";
const DEFAULT_MODEL_PORT = 18_317;
const DEFAULT_ADMIN_HOST = "127.0.0.1";
const DEFAULT_ADMIN_PORT = 18_318;

export function assertLoopbackHost(host) {
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new Error("admin host must be the literal loopback address 127.0.0.1 or ::1");
  }
  return host;
}

export function parsePort(value, name = "admin port") {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]{0,4})$/.test(text)) {
    throw new Error(`${name} must be an integer from 0 through 65535`);
  }
  const port = Number.parseInt(text, 10);
  if (port < 0 || port > 65_535) {
    throw new Error(`${name} must be an integer from 0 through 65535`);
  }
  return port;
}

function parseBoundedInteger(value, name, maximum) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

export function loadRuntimeConfig(environment = process.env) {
  const adminHost = assertLoopbackHost(
    environment.CODEX_ROUTER_ADMIN_HOST ?? DEFAULT_ADMIN_HOST,
  );
  const adminPort = parsePort(
    environment.CODEX_ROUTER_ADMIN_PORT ?? String(DEFAULT_ADMIN_PORT),
    "CODEX_ROUTER_ADMIN_PORT",
  );
  const modelHost = assertLoopbackHost(
    environment.CODEX_ROUTER_MODEL_HOST ?? DEFAULT_MODEL_HOST,
  );
  const modelPort = parsePort(
    environment.CODEX_ROUTER_MODEL_PORT ?? String(DEFAULT_MODEL_PORT),
    "CODEX_ROUTER_MODEL_PORT",
  );
  const failoverOptions = Object.freeze({
    maxAttempts: parseBoundedInteger(
      environment.CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS ??
        failoverDefaults.maxAttempts,
      "CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS",
      failoverPolicy.max_attempts,
    ),
    totalDeadlineMs: parseBoundedInteger(
      environment.CODEX_ROUTER_FAILOVER_TOTAL_DEADLINE_MS ??
        failoverDefaults.totalDeadlineMs,
      "CODEX_ROUTER_FAILOVER_TOTAL_DEADLINE_MS",
      failoverPolicy.max_total_deadline_ms,
    ),
    baseBackoffMs: parseBoundedInteger(
      environment.CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS ??
        failoverDefaults.baseBackoffMs,
      "CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS",
      failoverPolicy.max_backoff_ms,
    ),
    maxBackoffMs: parseBoundedInteger(
      environment.CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS ??
        failoverDefaults.maxBackoffMs,
      "CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS",
      failoverPolicy.max_backoff_ms,
    ),
  });
  if (failoverOptions.baseBackoffMs > failoverOptions.maxBackoffMs) {
    throw new Error(
      "CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS must not exceed " +
        "CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS",
    );
  }
  return Object.freeze({
    adminHost,
    adminPort,
    modelHost,
    modelPort,
    failoverOptions,
  });
}

export const defaults = Object.freeze({
  adminHost: DEFAULT_ADMIN_HOST,
  adminPort: DEFAULT_ADMIN_PORT,
  modelHost: DEFAULT_MODEL_HOST,
  modelPort: DEFAULT_MODEL_PORT,
  failoverOptions: failoverDefaults,
});
