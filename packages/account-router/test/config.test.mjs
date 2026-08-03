import assert from "node:assert/strict";
import test from "node:test";
import { assertLoopbackHost, defaults, loadRuntimeConfig, parsePort } from "../src/config.mjs";

test("uses a literal IPv4 loopback listener by default", () => {
  assert.deepEqual(loadRuntimeConfig({}), defaults);
  assert.equal(defaults.adminHost, "127.0.0.1");
  assert.equal(defaults.adminPort, 18_318);
  assert.equal(defaults.modelHost, "127.0.0.1");
  assert.equal(defaults.modelPort, 18_317);
  assert.deepEqual(defaults.failoverOptions, {
    maxAttempts: 16,
    totalDeadlineMs: 120_000,
    baseBackoffMs: 100,
    maxBackoffMs: 2_000,
  });
});

test("accepts loopback listener and bounded failover overrides", () => {
  assert.deepEqual(
    loadRuntimeConfig({
      CODEX_ROUTER_ADMIN_HOST: "::1",
      CODEX_ROUTER_ADMIN_PORT: "0",
      CODEX_ROUTER_MODEL_HOST: "127.0.0.1",
      CODEX_ROUTER_MODEL_PORT: "18317",
      CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS: "2",
      CODEX_ROUTER_FAILOVER_TOTAL_DEADLINE_MS: "1000",
      CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS: "20",
      CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS: "200",
    }),
    {
      adminHost: "::1",
      adminPort: 0,
      modelHost: "127.0.0.1",
      modelPort: 18_317,
      failoverOptions: {
        maxAttempts: 2,
        totalDeadlineMs: 1_000,
        baseBackoffMs: 20,
        maxBackoffMs: 200,
      },
    },
  );
  assert.equal(assertLoopbackHost("127.0.0.1"), "127.0.0.1");
});

test("rejects public, wildcard, hostname, and malformed bind addresses", () => {
  for (const host of ["0.0.0.0", "::", "localhost", "192.0.2.1", "", null]) {
    assert.throws(() => assertLoopbackHost(host), /literal loopback address/);
  }
});

test("validates the complete TCP port range", () => {
  for (const value of [0, "0", 1, "18318", 65_535]) {
    assert.equal(parsePort(value), Number(value));
  }
  for (const value of [-1, "-1", "01", "65536", "1.5", "", undefined]) {
    assert.throws(() => parsePort(value), /integer from 0 through 65535/);
  }
});

test("rejects malformed, out-of-range, and inverted failover bounds", () => {
  for (const [name, value] of [
    ["CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS", "0"],
    ["CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS", "17"],
    ["CODEX_ROUTER_FAILOVER_TOTAL_DEADLINE_MS", "3600001"],
    ["CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS", "01"],
    ["CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS", "60001"],
  ]) {
    assert.throws(() => loadRuntimeConfig({ [name]: value }), new RegExp(name));
  }
  assert.throws(
    () => loadRuntimeConfig({
      CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS: "201",
      CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS: "200",
    }),
    /BASE_BACKOFF_MS must not exceed CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS/,
  );
});
