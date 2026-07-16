const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
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

export function loadRuntimeConfig(environment = process.env) {
  const adminHost = assertLoopbackHost(
    environment.CODEX_ROUTER_ADMIN_HOST ?? DEFAULT_ADMIN_HOST,
  );
  const adminPort = parsePort(
    environment.CODEX_ROUTER_ADMIN_PORT ?? String(DEFAULT_ADMIN_PORT),
    "CODEX_ROUTER_ADMIN_PORT",
  );
  return Object.freeze({ adminHost, adminPort });
}

export const defaults = Object.freeze({
  adminHost: DEFAULT_ADMIN_HOST,
  adminPort: DEFAULT_ADMIN_PORT,
});
