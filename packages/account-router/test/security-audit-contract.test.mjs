import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadSecurityAuditPolicy,
  scanTextForSecrets,
  validateSecurityAuditPolicy,
} from "../scripts/run-security-audit.mjs";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, "../..");
const policyPath = path.join(packageDirectory, "security-audit.json");
const serviceNames = [
  "codex-account-router.service",
  "codex-app-server.service",
  "codex-web.service",
];

test("security policy maps every M6.3 acceptance boundary to executable evidence", async () => {
  const policy = await loadSecurityAuditPolicy(policyPath);
  assert.deepEqual(Object.keys(policy.controls), [
    "logs",
    "crash_dumps",
    "api_responses",
    "ui",
    "admin_authorization",
    "path_and_open_proxy",
    "ssrf_boundary",
  ]);
  for (const control of Object.values(policy.controls)) {
    assert.ok(control.test_files.length > 0);
    for (const relativePath of control.test_files) {
      await fs.access(path.join(packageDirectory, relativePath));
    }
  }
});

test("security policy rejects omitted controls and unsafe test references", async () => {
  const policy = await loadSecurityAuditPolicy(policyPath);
  const incomplete = structuredClone(policy);
  delete incomplete.controls.ui;
  assert.throws(() => validateSecurityAuditPolicy(incomplete), /control ids/);
  const unsafe = structuredClone(policy);
  unsafe.controls.logs.test_files = ["../outside.test.mjs"];
  assert.throws(() => validateSecurityAuditPolicy(unsafe), /test reference/);
});

test("secret scanner detects credential shapes without embedding a live-shaped fixture", () => {
  const policy = {
    ignored_paths: [],
    synthetic_markers: ["fixture-", "[REDACTED]"],
  };
  const token = `gh${"p"}_${"A".repeat(24)}`;
  const privateKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  assert.deepEqual(
    scanTextForSecrets("src/example.mjs", `const value = "${token}";`, policy)
      .map(({ rule }) => rule),
    ["known_token"],
  );
  assert.deepEqual(
    scanTextForSecrets("src/example.mjs", privateKey, policy)
      .map(({ rule }) => rule),
    ["private_key"],
  );
  assert.deepEqual(
    scanTextForSecrets(
      "test/example.test.mjs",
      'const authorization = "Bearer fixture-synthetic-only";',
      policy,
    ),
    [],
  );
});

test("systemd services disable core dumps before loading any credential", async () => {
  for (const name of serviceNames) {
    const content = await fs.readFile(path.join(repositoryRoot, "systemd", name), "utf8");
    assert.match(content, /^LimitCORE=0$/m, name);
    assert.ok(
      content.indexOf("LimitCORE=0") < content.search(/^LoadCredential=/m),
      `${name}: LimitCORE must precede credential loading`,
    );
  }
});

test("security audit CLI fails closed without a private absolute summary path", () => {
  const result = spawnSync(process.execPath, ["scripts/run-security-audit.mjs"], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /absolute --summary path/);
  assert.doesNotMatch(result.stderr, /Bearer|cookie|authorization|credential value/i);
});
