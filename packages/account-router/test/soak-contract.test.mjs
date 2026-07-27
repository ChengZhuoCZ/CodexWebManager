import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  evaluateSoakSummary,
  parseSoakArguments,
  SOAK_ACCEPTANCE_DURATION_MS,
} from "../scripts/run-soak.mjs";

function runHarness(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-soak.mjs", ...args], {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

test("acceptance mode is fixed to a real 24-hour wall-clock duration", () => {
  assert.equal(SOAK_ACCEPTANCE_DURATION_MS, 24 * 60 * 60_000);
  const parsed = parseSoakArguments([
    "--mode", "acceptance",
    "--summary", "/tmp/summary.json",
    "--checkpoints", "/tmp/checkpoints.jsonl",
  ]);
  assert.equal(parsed.durationMs, SOAK_ACCEPTANCE_DURATION_MS);
  assert.throws(
    () => parseSoakArguments([
      "--mode", "acceptance",
      "--duration-ms", "5000",
      "--summary", "/tmp/summary.json",
      "--checkpoints", "/tmp/checkpoints.jsonl",
    ]),
    /duration override/,
  );
});

test("acceptance evaluation rejects short runs, crashes, leaks, retry overflow, and missing drills", () => {
  const healthy = {
    mode: "acceptance",
    elapsed_ms: SOAK_ACCEPTANCE_DURATION_MS,
    samples: 1_440,
    minimum_samples: 1_368,
    client_requests: 100_000,
    upstream_attempts: 105_000,
    max_attempts: 3,
    unexpected_worker_exits: 0,
    request_errors: 0,
    maximum_client_concurrency: 4,
    configured_concurrency: 4,
    maximum_worker_active_requests: 4,
    maximum_upstream_active_requests: 4,
    maximum_worker_rss_bytes: 128 * 1024 * 1024,
    worker_rss_growth_bytes: 8 * 1024 * 1024,
    maximum_worker_fd_count: 64,
    worker_fd_growth: 2,
    restart_drills: [
      { recovered: true, active_requests_at_stop: 0 },
      { recovered: true, active_requests_at_stop: 0 },
      { recovered: true, active_requests_at_stop: 0 },
    ],
  };
  assert.equal(evaluateSoakSummary(healthy).qualified, true);
  for (const mutation of [
    { elapsed_ms: SOAK_ACCEPTANCE_DURATION_MS - 1 },
    { unexpected_worker_exits: 1 },
    { request_errors: 1 },
    { upstream_attempts: 300_001 },
    { maximum_client_concurrency: 5 },
    { maximum_worker_rss_bytes: 257 * 1024 * 1024 },
    { worker_rss_growth_bytes: 65 * 1024 * 1024 },
    { maximum_worker_fd_count: 257 },
    { worker_fd_growth: 17 },
    { restart_drills: healthy.restart_drills.slice(0, 2) },
  ]) {
    assert.equal(evaluateSoakSummary({ ...healthy, ...mutation }).qualified, false);
  }
});

test("short smoke exercises bounded traffic and restart recovery without claiming 24 hours", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "m6-2-soak-contract-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const summary = path.join(directory, "summary.json");
  const checkpoints = path.join(directory, "checkpoints.jsonl");
  const result = await runHarness([
    "--mode", "smoke",
    "--duration-ms", "5000",
    "--summary", summary,
    "--checkpoints", checkpoints,
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  const evidence = JSON.parse(await fs.readFile(summary, "utf8"));
  assert.equal(evidence.task, "M6.2");
  assert.equal(evidence.mode, "smoke");
  assert.equal(evidence.qualified_24_hour_soak, false);
  assert.ok(evidence.traffic.client_requests > 0);
  assert.equal(evidence.traffic.request_errors, 0);
  assert.ok(evidence.restart_drills.length >= 2);
  assert.equal(evidence.restart_drills.every(({ recovered }) => recovered), true);
  assert.equal(evidence.real_account_configured, false);
  assert.equal(evidence.account_switch_tested, false);
  assert.equal(evidence.in_flight_computation_resume_claimed, false);
  const checkpointLines = (await fs.readFile(checkpoints, "utf8")).trim().split(/\r?\n/);
  assert.ok(checkpointLines.length >= 2);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /token|cookie|authorization/i);
});

test("harness fails closed before starting when evidence paths are absent", async () => {
  const result = await runHarness([]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /absolute --summary and --checkpoints paths/);
});
