#!/usr/bin/env node

import { fork } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOAK_ACCEPTANCE_DURATION_MS = 24 * 60 * 60_000;
const MAX_WORKER_RSS_BYTES = 256 * 1024 * 1024;
const MAX_WORKER_RSS_GROWTH_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_FDS = 256;
const MAX_WORKER_FD_GROWTH = 16;
const MAX_ATTEMPTS = 3;
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(packageDirectory, "fixtures", "soak", "router-worker.mjs");

function integer(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? "")) throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

export function parseSoakArguments(argv) {
  let mode = null;
  let summaryPath = null;
  let checkpointsPath = null;
  let durationOverride = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--mode" && value !== undefined) {
      mode = value;
      index += 1;
    } else if (option === "--summary" && value !== undefined) {
      summaryPath = value;
      index += 1;
    } else if (option === "--checkpoints" && value !== undefined) {
      checkpointsPath = value;
      index += 1;
    } else if (option === "--duration-ms" && value !== undefined) {
      durationOverride = integer(value, "smoke duration", 3_000, 10 * 60_000);
      index += 1;
    } else {
      throw new Error("unsupported soak option");
    }
  }
  if (
    typeof summaryPath !== "string" ||
    !path.isAbsolute(summaryPath) ||
    typeof checkpointsPath !== "string" ||
    !path.isAbsolute(checkpointsPath)
  ) {
    throw new Error("absolute --summary and --checkpoints paths are required");
  }
  if (path.normalize(summaryPath) === path.normalize(checkpointsPath)) {
    throw new Error("summary and checkpoints paths must differ");
  }
  if (!new Set(["acceptance", "smoke"]).has(mode)) {
    throw new Error("--mode must be acceptance or smoke");
  }
  if (mode === "acceptance" && durationOverride !== null) {
    throw new Error("acceptance duration override is forbidden");
  }
  if (mode === "smoke" && durationOverride === null) {
    throw new Error("smoke mode requires --duration-ms");
  }
  return Object.freeze({
    mode,
    summaryPath,
    checkpointsPath,
    durationMs: mode === "acceptance" ? SOAK_ACCEPTANCE_DURATION_MS : durationOverride,
    sampleIntervalMs: mode === "acceptance" ? 60_000 : 500,
    requestIntervalMs: mode === "acceptance" ? 1_000 : 100,
    configuredConcurrency: 4,
    restartOffsetsMs: mode === "acceptance"
      ? [60 * 60_000, 12 * 60 * 60_000, 23 * 60 * 60_000]
      : [
          Math.floor(durationOverride / 3),
          Math.floor((durationOverride * 2) / 3),
        ],
  });
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateSoakSummary(summary) {
  const requiredDrills = summary.mode === "acceptance" ? 3 : 2;
  const checks = Object.freeze({
    linux_acceptance:
      summary.mode !== "acceptance" || (summary.platform ?? "linux") === "linux",
    full_wall_clock:
      summary.mode !== "acceptance" || summary.elapsed_ms >= SOAK_ACCEPTANCE_DURATION_MS,
    sample_coverage:
      finiteInteger(summary.samples) &&
      finiteInteger(summary.minimum_samples) &&
      summary.samples >= summary.minimum_samples,
    traffic_volume:
      finiteInteger(summary.client_requests) &&
      summary.client_requests >= (summary.minimum_client_requests ?? 1),
    no_unexpected_worker_exit: summary.unexpected_worker_exits === 0,
    no_request_error: summary.request_errors === 0,
    retry_bound:
      finiteInteger(summary.upstream_attempts) &&
      finiteInteger(summary.client_requests) &&
      summary.max_attempts === MAX_ATTEMPTS &&
      summary.upstream_attempts <= summary.client_requests * summary.max_attempts,
    client_concurrency_bound:
      summary.maximum_client_concurrency <= summary.configured_concurrency,
    worker_concurrency_bound:
      summary.maximum_worker_active_requests <= summary.configured_concurrency,
    upstream_concurrency_bound:
      summary.maximum_upstream_active_requests <= summary.configured_concurrency,
    worker_rss_bound: summary.maximum_worker_rss_bytes <= MAX_WORKER_RSS_BYTES,
    worker_rss_growth_bound:
      Math.abs(summary.worker_rss_growth_bytes) <= MAX_WORKER_RSS_GROWTH_BYTES,
    worker_fd_bound: summary.maximum_worker_fd_count <= MAX_WORKER_FDS,
    worker_fd_growth_bound: Math.abs(summary.worker_fd_growth) <= MAX_WORKER_FD_GROWTH,
    restart_drills:
      Array.isArray(summary.restart_drills) &&
      summary.restart_drills.length >= requiredDrills &&
      summary.restart_drills.every((drill) =>
        drill?.recovered === true && drill.active_requests_at_stop === 0),
  });
  const healthy = Object.values(checks).every(Boolean);
  return Object.freeze({
    checks,
    healthy,
    qualified: summary.mode === "acceptance" && healthy,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await delay(20);
  }
}

async function privateOutputPath(filePath) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("evidence directory must be a real directory");
  }
}

async function writePrivateJson(filePath, value) {
  await privateOutputPath(filePath);
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function createFixtureUpstream() {
  const faults = {
    success: 0,
    quota: 0,
    http_429: 0,
    auth: 0,
    network: 0,
    upstream_5xx: 0,
    malformed_sse: 0,
    after_semantic_disconnect: 0,
  };
  let attempts = 0;
  let active = 0;
  let maximumActive = 0;
  let forceSuccess = false;

  function complete(response, marker = "soak") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
    response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: marker,
    })}\n\n`);
    response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
  }

  const slots = new Map([
    [7, "quota"],
    [19, "http_429"],
    [31, "auth"],
    [43, "network"],
    [59, "upstream_5xx"],
    [71, "malformed_sse"],
    [83, "after_semantic_disconnect"],
  ]);
  const server = http.createServer((request, response) => {
    request.resume();
    attempts += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    let finished = false;
    const leave = () => {
      if (finished) return;
      finished = true;
      active -= 1;
    };
    response.once("finish", leave);
    response.once("close", leave);
    const fault = forceSuccess ? "success" : slots.get(attempts % 101) ?? "success";
    faults[fault] += 1;
    if (fault === "quota") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":{"type":"quota_exhausted"}}');
    } else if (fault === "http_429") {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "999999999",
      });
      response.end('{"error":{"type":"rate_limit"}}');
    } else if (fault === "auth") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"type":"invalid_auth"}}');
    } else if (fault === "network") {
      request.socket.destroy();
    } else if (fault === "upstream_5xx") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":{"type":"fixture_unavailable"}}');
    } else if (fault === "malformed_sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
      response.end("data: {\"type\":\"response.output_text.delta\"");
    } else if (fault === "after_semantic_disconnect") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
      response.write(
        "event: response.output_text.delta\ndata: " +
        "{\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
      );
      setImmediate(() => response.destroy());
    } else {
      complete(response);
    }
  });

  return {
    server,
    setForceSuccess(value) { forceSuccess = value; },
    snapshot() {
      return {
        attempts,
        active,
        maximum_active: maximumActive,
        fault_counts: { ...faults },
      };
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function linuxFdCount(pid) {
  if (process.platform !== "linux") return 0;
  try {
    return (await fs.readdir(`/proc/${pid}/fd`)).length;
  } catch {
    return MAX_WORKER_FDS + 1;
  }
}

function startRouterWorker(origin, generation, counters) {
  const child = fork(workerPath, [], {
    cwd: packageDirectory,
    env: {
      PATH: process.env.PATH,
      SOAK_UPSTREAM_ORIGIN: origin,
    },
    silent: true,
  });
  let expectedExit = false;
  let port = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pendingMetrics = new Map();
  let metricsId = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    counters.worker_stdout_lines += chunk.split("\n").filter(Boolean).length;
  });
  child.stderr.on("data", (chunk) => {
    counters.worker_stderr_lines += chunk.split("\n").filter(Boolean).length;
  });
  child.on("message", (message) => {
    if (message?.type === "ready" && Number.isSafeInteger(message.port)) {
      port = message.port;
      readyResolve();
    } else if (message?.type === "metrics") {
      const pending = pendingMetrics.get(message.request_id);
      if (pending) {
        pendingMetrics.delete(message.request_id);
        pending.resolve(message);
      }
    } else if (message?.type === "fatal") {
      counters.worker_fatal_messages += 1;
    }
  });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      if (!expectedExit) counters.unexpected_worker_exits += 1;
      if (port === null) readyReject(new Error("soak worker exited before readiness"));
      for (const pending of pendingMetrics.values()) {
        pending.reject(new Error("soak worker exited before metrics"));
      }
      pendingMetrics.clear();
      resolve({ code, signal });
    });
  });
  const readyTimeout = setTimeout(
    () => readyReject(new Error("soak worker readiness timed out")),
    10_000,
  );
  const readyBounded = ready.finally(() => clearTimeout(readyTimeout));

  return {
    child,
    exit,
    generation,
    get origin() { return port === null ? null : `http://127.0.0.1:${port}`; },
    async ready() { await readyBounded; },
    async metrics() {
      if (!child.connected) throw new Error("soak worker IPC unavailable");
      const requestId = ++metricsId;
      let timer;
      const response = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          pendingMetrics.delete(requestId);
          reject(new Error("soak worker metrics timed out"));
        }, 5_000);
        pendingMetrics.set(requestId, { resolve, reject });
      });
      child.send({ type: "metrics", request_id: requestId });
      return response.finally(() => clearTimeout(timer));
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      expectedExit = true;
      child.send({ type: "shutdown" });
      await Promise.race([exit, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
    },
  };
}

function resourceAggregate(samples) {
  const rss = samples.map(({ worker }) => worker.rss_bytes);
  const fds = samples.map(({ worker }) => worker.fd_count);
  return {
    maximum_worker_rss_bytes: Math.max(0, ...rss),
    worker_rss_growth_bytes: rss.length < 2 ? 0 : rss.at(-1) - rss[0],
    maximum_worker_fd_count: Math.max(0, ...fds),
    worker_fd_growth: fds.length < 2 ? 0 : fds.at(-1) - fds[0],
    maximum_worker_active_requests: Math.max(
      0,
      ...samples.map(({ worker }) => worker.maximum_active_requests),
    ),
  };
}

async function runSoak(options) {
  if (options.mode === "acceptance" && process.platform !== "linux") {
    throw new Error("acceptance soak requires Linux");
  }
  await Promise.all([
    privateOutputPath(options.summaryPath),
    privateOutputPath(options.checkpointsPath),
  ]);
  const checkpointHandle = await fs.open(options.checkpointsPath, "w", 0o600);
  await fs.chmod(options.checkpointsPath, 0o600);
  const fixture = createFixtureUpstream();
  const fixtureOrigin = await listen(fixture.server);
  const counters = {
    client_requests: 0,
    successful_responses: 0,
    expected_unsafe_to_replay: 0,
    bounded_error_responses: 0,
    request_errors: 0,
    active_client_requests: 0,
    maximum_client_concurrency: 0,
    unexpected_worker_exits: 0,
    worker_fatal_messages: 0,
    worker_stdout_lines: 0,
    worker_stderr_lines: 0,
  };
  const samples = [];
  const restartDrills = [];
  let workerGeneration = 1;
  let worker = startRouterWorker(fixtureOrigin, workerGeneration, counters);
  await worker.ready();
  let paused = false;
  let stopRequested = false;
  let completed = false;
  const onSignal = () => {
    stopRequested = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const startedAt = Date.now();
  const deadline = startedAt + options.durationMs;

  async function performRequest() {
    if (worker.origin === null) {
      counters.request_errors += 1;
      return false;
    }
    counters.client_requests += 1;
    counters.active_client_requests += 1;
    counters.maximum_client_concurrency = Math.max(
      counters.maximum_client_concurrency,
      counters.active_client_requests,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${worker.origin}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"input":"soak-fixture"}',
        signal: controller.signal,
      });
      const body = await response.text();
      if (response.status === 200 && body.includes("response.completed")) {
        counters.successful_responses += 1;
        return true;
      }
      if (response.status === 200 && body.includes("unsafe_to_replay")) {
        counters.expected_unsafe_to_replay += 1;
        return true;
      }
      if (new Set([409, 502, 503, 504]).has(response.status)) {
        counters.bounded_error_responses += 1;
        return true;
      }
      counters.request_errors += 1;
      return false;
    } catch {
      counters.request_errors += 1;
      return false;
    } finally {
      clearTimeout(timer);
      counters.active_client_requests -= 1;
    }
  }

  const trafficTimer = setInterval(() => {
    if (paused || stopRequested) return;
    while (counters.active_client_requests < options.configuredConcurrency) {
      void performRequest();
    }
  }, options.requestIntervalMs);

  async function sample() {
    const metrics = await worker.metrics();
    const fixtureSnapshot = fixture.snapshot();
    const checkpoint = {
      schema_version: 1,
      task: "M6.2",
      event: "checkpoint",
      observed_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      worker: {
        generation: worker.generation,
        rss_bytes: metrics.memory.rss_bytes,
        heap_used_bytes: metrics.memory.heap_used_bytes,
        fd_count: await linuxFdCount(worker.child.pid),
        active_requests: metrics.active_requests,
        maximum_active_requests: metrics.maximum_active_requests,
      },
      traffic: {
        client_requests: counters.client_requests,
        successful_responses: counters.successful_responses,
        expected_unsafe_to_replay: counters.expected_unsafe_to_replay,
        bounded_error_responses: counters.bounded_error_responses,
        request_errors: counters.request_errors,
        active_client_requests: counters.active_client_requests,
        maximum_client_concurrency: counters.maximum_client_concurrency,
        upstream_attempts: fixtureSnapshot.attempts,
        upstream_active_requests: fixtureSnapshot.active,
        maximum_upstream_active_requests: fixtureSnapshot.maximum_active,
      },
      unexpected_worker_exits: counters.unexpected_worker_exits,
      real_account_configured: false,
      account_switch_tested: false,
    };
    samples.push(checkpoint);
    await checkpointHandle.appendFile(`${JSON.stringify(checkpoint)}\n`);
    await checkpointHandle.sync();
  }

  async function restartDrill(offsetMs) {
    paused = true;
    const drillStarted = Date.now();
    await waitFor(() => counters.active_client_requests === 0, 10_000, "traffic drain");
    const activeAtStop = counters.active_client_requests;
    fixture.setForceSuccess(true);
    await worker.stop();
    workerGeneration += 1;
    worker = startRouterWorker(fixtureOrigin, workerGeneration, counters);
    await worker.ready();
    const recovered = await performRequest();
    fixture.setForceSuccess(false);
    restartDrills.push({
      sequence: restartDrills.length + 1,
      scheduled_elapsed_ms: offsetMs,
      completed_elapsed_ms: Date.now() - startedAt,
      downtime_ms: Date.now() - drillStarted,
      process_changed: true,
      active_requests_at_stop: activeAtStop,
      recovered,
      recovery_scope: "new_fixture_request",
      in_flight_computation_resume_claimed: false,
    });
    paused = false;
  }

  let nextSampleAt = startedAt;
  let drillIndex = 0;
  let runError = null;
  try {
    while (!stopRequested && Date.now() < deadline) {
      const elapsed = Date.now() - startedAt;
      if (
        drillIndex < options.restartOffsetsMs.length &&
        elapsed >= options.restartOffsetsMs[drillIndex]
      ) {
        await restartDrill(options.restartOffsetsMs[drillIndex]);
        drillIndex += 1;
      }
      if (Date.now() >= nextSampleAt) {
        await sample();
        nextSampleAt += options.sampleIntervalMs;
        if (nextSampleAt < Date.now() - options.sampleIntervalMs) {
          nextSampleAt = Date.now() + options.sampleIntervalMs;
        }
      }
      if (counters.unexpected_worker_exits > 0 || counters.worker_fatal_messages > 0) {
        throw new Error("soak worker exited unexpectedly");
      }
      await delay(20);
    }
    completed = !stopRequested && Date.now() >= deadline;
  } catch (error) {
    runError = error;
  } finally {
    clearInterval(trafficTimer);
    paused = true;
    await waitFor(() => counters.active_client_requests === 0, 10_000, "final traffic drain")
      .catch(() => undefined);
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      await sample().catch(() => undefined);
      await worker.stop();
    }
    await closeServer(fixture.server);
    await checkpointHandle.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const endedAt = Date.now();
  const fixtureSnapshot = fixture.snapshot();
  const resources = resourceAggregate(samples);
  const minimumSamples = options.mode === "acceptance"
    ? Math.floor((options.durationMs / options.sampleIntervalMs) * 0.95)
    : Math.max(2, Math.floor((options.durationMs / options.sampleIntervalMs) * 0.6));
  const minimumClientRequests = Math.max(
    1,
    Math.floor((options.durationMs / options.requestIntervalMs) * 0.5),
  );
  const evaluationInput = {
    mode: options.mode,
    platform: process.platform,
    elapsed_ms: endedAt - startedAt,
    samples: samples.length,
    minimum_samples: minimumSamples,
    client_requests: counters.client_requests,
    minimum_client_requests: minimumClientRequests,
    upstream_attempts: fixtureSnapshot.attempts,
    max_attempts: MAX_ATTEMPTS,
    unexpected_worker_exits: counters.unexpected_worker_exits,
    request_errors: counters.request_errors,
    maximum_client_concurrency: counters.maximum_client_concurrency,
    configured_concurrency: options.configuredConcurrency,
    maximum_worker_active_requests: resources.maximum_worker_active_requests,
    maximum_upstream_active_requests: fixtureSnapshot.maximum_active,
    ...resources,
    restart_drills: restartDrills,
  };
  const evaluation = evaluateSoakSummary(evaluationInput);
  const summary = {
    schema_version: 1,
    task: "M6.2",
    mode: options.mode,
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    elapsed_ms: endedAt - startedAt,
    required_duration_ms: SOAK_ACCEPTANCE_DURATION_MS,
    completed,
    qualified_24_hour_soak: completed && evaluation.qualified,
    checks: evaluation.checks,
    sampling: {
      samples: samples.length,
      minimum_samples: minimumSamples,
      interval_ms: options.sampleIntervalMs,
    },
    traffic: {
      client_requests: counters.client_requests,
      minimum_client_requests: minimumClientRequests,
      successful_responses: counters.successful_responses,
      expected_unsafe_to_replay: counters.expected_unsafe_to_replay,
      bounded_error_responses: counters.bounded_error_responses,
      request_errors: counters.request_errors,
      maximum_client_concurrency: counters.maximum_client_concurrency,
      configured_concurrency: options.configuredConcurrency,
      upstream_attempts: fixtureSnapshot.attempts,
      maximum_upstream_active_requests: fixtureSnapshot.maximum_active,
      max_attempts: MAX_ATTEMPTS,
      fault_counts: fixtureSnapshot.fault_counts,
    },
    resources: {
      ...resources,
      rss_limit_bytes: MAX_WORKER_RSS_BYTES,
      rss_growth_limit_bytes: MAX_WORKER_RSS_GROWTH_BYTES,
      fd_limit: MAX_WORKER_FDS,
      fd_growth_limit: MAX_WORKER_FD_GROWTH,
    },
    restart_drills: restartDrills,
    process_health: {
      unexpected_worker_exits: counters.unexpected_worker_exits,
      worker_fatal_messages: counters.worker_fatal_messages,
      worker_stdout_lines: counters.worker_stdout_lines,
      worker_stderr_lines: counters.worker_stderr_lines,
    },
    termination: runError ? "error" : stopRequested ? "signal" : "deadline",
    error_category: runError ? "soak_runtime_error" : null,
    architecture_mode: "LIMITED_MODE",
    real_account_configured: false,
    account_switch_tested: false,
    in_flight_computation_resume_claimed: false,
    seamless_account_continuity_claimed: false,
  };
  await writePrivateJson(options.summaryPath, summary);
  if (runError) throw runError;
  return summary;
}

async function main() {
  let options;
  try {
    options = parseSoakArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const summary = await runSoak(options);
    process.stdout.write(`${JSON.stringify({
      event: "soak_finished",
      mode: summary.mode,
      elapsed_ms: summary.elapsed_ms,
      completed: summary.completed,
      qualified_24_hour_soak: summary.qualified_24_hour_soak,
      client_requests: summary.traffic.client_requests,
      request_errors: summary.traffic.request_errors,
      restart_drills: summary.restart_drills.length,
      real_account_configured: false,
      account_switch_tested: false,
    })}\n`);
    if (!summary.completed || !Object.values(summary.checks).every(Boolean)) {
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write("soak test failed\n");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
