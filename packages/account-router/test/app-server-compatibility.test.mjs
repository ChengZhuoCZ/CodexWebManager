import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function runHarness(environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-app-server-e2e.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("app-server E2E harness fails before reading credentials when evidence paths are absent", async () => {
  const result = await runHarness();
  assert.equal(result.code, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /M3_5_EVIDENCE_DIR/);
  assert.doesNotMatch(result.stderr, /auth|token|cookie|authorization/i);
});

test("app-server E2E harness enforces a bounded total turn timeout", async () => {
  const result = await runHarness({
    M3_5_EVIDENCE_DIR: "/not-used",
    M3_5_SUMMARY_LOG: "/not-used/summary.jsonl",
    M3_5_TIMEOUT_MS: "9999999",
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /bounded M3_5_TIMEOUT_MS/);
});
