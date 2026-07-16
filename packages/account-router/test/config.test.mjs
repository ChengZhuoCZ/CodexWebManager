import assert from "node:assert/strict";
import test from "node:test";
import { assertLoopbackHost, defaults, loadRuntimeConfig, parsePort } from "../src/config.mjs";

test("uses a literal IPv4 loopback listener by default", () => {
  assert.deepEqual(loadRuntimeConfig({}), defaults);
  assert.equal(defaults.adminHost, "127.0.0.1");
  assert.equal(defaults.adminPort, 18_318);
  assert.equal(defaults.modelHost, "127.0.0.1");
  assert.equal(defaults.modelPort, 18_317);
});

test("accepts literal IPv4 and IPv6 loopback overrides", () => {
  assert.deepEqual(
    loadRuntimeConfig({
      CODEX_ROUTER_ADMIN_HOST: "::1",
      CODEX_ROUTER_ADMIN_PORT: "0",
      CODEX_ROUTER_MODEL_HOST: "127.0.0.1",
      CODEX_ROUTER_MODEL_PORT: "18317",
    }),
    { adminHost: "::1", adminPort: 0, modelHost: "127.0.0.1", modelPort: 18_317 },
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
