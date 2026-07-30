import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildLinuxRelease,
  readLinuxReleaseArchive,
} from "../scripts/build-linux-release.mjs";

const packageDirectory = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-linux-release-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("builds a byte-reproducible x64 Linux archive without desktop dependencies", async (context) => {
  const temporaryRoot = await temporaryDirectory(context);
  const first = await buildLinuxRelease({
    architecture: "x64",
    outputDirectory: path.join(temporaryRoot, "first"),
    sourceDateEpoch: 0,
  });
  const second = await buildLinuxRelease({
    architecture: "x64",
    outputDirectory: path.join(temporaryRoot, "second"),
    sourceDateEpoch: 0,
  });

  const firstArchive = await fs.readFile(first.artifactPath);
  const secondArchive = await fs.readFile(second.artifactPath);
  assert.deepEqual(firstArchive, secondArchive);
  assert.equal(first.sha256, sha256(firstArchive));
  assert.equal(second.sha256, first.sha256);
  assert.equal(
    await fs.readFile(first.checksumPath, "utf8"),
    `${first.sha256}  ${path.basename(first.artifactPath)}\n`,
  );

  const entries = readLinuxReleaseArchive(firstArchive);
  const files = new Map(
    entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]),
  );
  const root = first.releaseName;
  const manifestEntry = files.get(`${root}/manifest.json`);
  assert.ok(manifestEntry);

  const manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  assert.equal(manifest.version, "0.2.29");
  assert.equal(first.releaseName, "codex-account-router-0.2.29-linux-x64");
  assert.deepEqual(manifest.target, { os: "linux", architecture: "x64" });
  assert.equal(manifest.runtime.node, ">=22");
  assert.equal(manifest.runtime.electron_required, false);
  assert.equal(manifest.runtime.display_server_required, false);
  assert.equal(manifest.reproducibility.source_date_epoch, 0);
  assert.deepEqual(manifest.schemas, { accounts: 1, circuit_state: 1 });

  const archivedPaths = entries.map((entry) => entry.path);
  assert.ok(archivedPaths.includes(`${root}/bin/codex-account-router`));
  assert.ok(archivedPaths.includes(`${root}/bin/codex-router-account`));
  assert.ok(archivedPaths.includes(`${root}/bin/codex-router-cli`));
  assert.ok(archivedPaths.includes(`${root}/bin/codex-stack-deploy`));
  assert.ok(archivedPaths.includes(`${root}/install.sh`));
  assert.ok(archivedPaths.includes(`${root}/lib/account-router/src/main.mjs`));
  assert.ok(archivedPaths.includes(`${root}/lib/account-router/src/weekly-quota-tracker.mjs`));
  assert.ok(archivedPaths.includes(`${root}/lib/account-router/package.json`));
  assert.equal(archivedPaths.some((entryPath) => entryPath.includes("node_modules")), false);
  assert.equal(archivedPaths.some((entryPath) => /electron/i.test(entryPath)), false);

  for (const executablePath of [
    `${root}/bin/codex-account-router`,
    `${root}/bin/codex-router-account`,
    `${root}/bin/codex-router-cli`,
    `${root}/bin/codex-stack-deploy`,
    `${root}/install.sh`,
  ]) {
    assert.equal(files.get(executablePath)?.mode, 0o755);
  }
  assert.match(
    files.get(`${root}/install.sh`).content.toString("utf8"),
    /mv -Tf -- "\$temporary_link" "\$prefix\/current"/,
  );
  assert.match(
    files.get(`${root}/lib/account-router/src/runtime-composition.mjs`).content.toString("utf8"),
    /runtime-weekly-events/,
  );

  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const payloadPaths = [...files.keys()]
    .filter((entryPath) => entryPath !== `${root}/manifest.json`)
    .map((entryPath) => entryPath.slice(root.length + 1));
  assert.deepEqual([...manifestPaths].sort(), payloadPaths.sort());
  for (const file of manifest.files) {
    const entry = files.get(`${root}/${file.path}`);
    assert.ok(entry, file.path);
    assert.equal(file.sha256, sha256(entry.content), file.path);
    assert.equal(file.size, entry.content.length, file.path);
    assert.equal(file.mode, entry.mode.toString(8).padStart(4, "0"), file.path);
  }
});

test("rejects unsupported Linux architectures before writing an artifact", async (context) => {
  const outputDirectory = await temporaryDirectory(context);
  await assert.rejects(
    buildLinuxRelease({ architecture: "ia32", outputDirectory }),
    /architecture must be x64 or arm64/i,
  );
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test("installed release verifies stalled startup stop signals", async (context) => {
  const temporaryRoot = await temporaryDirectory(context);
  const release = await buildLinuxRelease({
    architecture: "x64",
    outputDirectory: path.join(temporaryRoot, "release"),
    sourceDateEpoch: 0,
  });
  const summaryPath = path.join(temporaryRoot, "verify-summary.json");
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("CODEX_ROUTER_")) delete environment[name];
  }
  delete environment.CREDENTIALS_DIRECTORY;
  const result = spawnSync(
    process.execPath,
    [
      "scripts/verify-linux-release.mjs",
      "--arch",
      "x64",
      "--artifact",
      release.artifactPath,
      "--summary",
      summaryPath,
    ],
    {
      cwd: packageDirectory,
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
    },
  );

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  assert.deepEqual(summary.runtime.startup_interruption, {
    signal: "SIGTERM",
    stalled_before_runtime_creation: true,
    exit_code: 0,
    exit_signal: null,
    router_stopping_emitted: true,
    router_started_emitted: false,
    router_start_failed_emitted: false,
    stderr_bytes: 0,
  });
  assert.deepEqual(
    summary.runtime.startup_interruptions,
    ["SIGTERM", "SIGINT"].map((signal) => ({
      signal,
      stalled_before_runtime_creation: true,
      exit_code: 0,
      exit_signal: null,
      router_stopping_emitted: true,
      router_started_emitted: false,
      router_start_failed_emitted: false,
      stderr_bytes: 0,
    })),
  );
  assert.deepEqual(summary.runtime.listener_start_interruption, {
    signal: "SIGTERM",
    stalled_during_listener_start: true,
    runtime_created_before_stall: true,
    exit_code: 0,
    exit_signal: null,
    router_stopping_emitted: true,
    router_started_emitted: false,
    router_start_failed_emitted: false,
    stderr_bytes: 0,
  });
  assert.deepEqual(
    summary.runtime.listener_start_interruptions,
    ["SIGTERM", "SIGINT"].map((signal) => ({
      signal,
      stalled_during_listener_start: true,
      runtime_created_before_stall: true,
      exit_code: 0,
      exit_signal: null,
      router_stopping_emitted: true,
      router_started_emitted: false,
      router_start_failed_emitted: false,
      stderr_bytes: 0,
    })),
  );
  assert.deepEqual(summary.runtime.synthetic_two_binding_restart, {
    configured_bindings: 2,
    process_starts: 2,
    restart_count: 1,
    state_checkpoint_files_after_first_stop: 2,
    readiness_statuses: [200, 200],
    usable_accounts: [2, 2],
    sigterm_exit_codes: [0, 0],
    synthetic_credential_acquisition_tested: false,
    real_credentials_present: false,
    model_request_sent: false,
    account_switch_tested: false,
  });
  assert.deepEqual(summary.runtime.synthetic_weekly_quota_restart, {
    configured_bindings: 2,
    process_starts: 2,
    restart_count: 1,
    readiness_statuses: [200, 200],
    usable_accounts: [2, 1],
    synthetic_model_response_statuses: [200, 200],
    completed_sse_responses: 2,
    synthetic_upstream_role_sequence: ["primary", "secondary"],
    weekly_zero_persisted: true,
    weekly_reset_persisted: true,
    cooldown_persisted: true,
    next_new_request_route_changed: true,
    current_route_continuity: [
      "new_backend_session",
      "new_backend_session",
    ],
    synthetic_credential_acquisition_tested: true,
    local_fixture_upstream_only: true,
    synthetic_model_requests_sent: 2,
    manual_switch_tested: false,
    real_credentials_present: false,
    real_model_request_sent: false,
    real_account_switch_tested: false,
    in_flight_resume_tested: false,
  });
  assert.deepEqual(summary.runtime.synthetic_http_sse_safety_boundaries, {
    scenarios: 2,
    process_starts: 2,
    readiness_statuses: [200, 200],
    initial_requests: 2,
    pre_semantic: {
      downstream_status: 200,
      failure_kind: "quota_exhausted",
      upstream_role_sequence: ["primary", "secondary"],
      upstream_attempts: 2,
      secondary_semantic_marker_received: true,
      retry_bound_observed: true,
    },
    post_semantic: {
      downstream_status: 200,
      upstream_role_sequence: ["primary"],
      upstream_attempts: 1,
      primary_semantic_marker_received: true,
      unsafe_to_replay_exposed: true,
      semantic_output: true,
      secondary_contacted: false,
    },
    local_fixture_upstream_only: true,
    synthetic_credential_acquisition_tested: true,
    synthetic_model_requests_sent: 2,
    synthetic_upstream_attempts: 3,
    manual_switch_tested: false,
    real_credentials_present: false,
    real_model_request_sent: false,
    real_account_switch_tested: false,
    in_flight_resume_tested: false,
  });
  assert.deepEqual(summary.runtime.synthetic_websocket_safety_boundaries, {
    scenarios: 2,
    process_starts: 2,
    readiness_statuses: [200, 200],
    downstream_upgrade_statuses: [101, 101],
    initial_requests: 2,
    pre_semantic: {
      failure_kind: "quota_exhausted",
      upstream_role_sequence: ["primary", "secondary"],
      upstream_attempts: 2,
      primary_preflight_discarded: true,
      secondary_semantic_marker_received: true,
      completed: true,
      retry_bound_observed: true,
    },
    post_semantic: {
      upstream_role_sequence: ["primary"],
      upstream_attempts: 1,
      primary_semantic_marker_received: true,
      unsafe_to_replay_exposed: true,
      semantic_output: true,
      secondary_contacted: false,
    },
    local_fixture_upstream_only: true,
    synthetic_credential_acquisition_tested: true,
    synthetic_websocket_requests_sent: 2,
    synthetic_upstream_attempts: 3,
    manual_switch_tested: false,
    real_credentials_present: false,
    real_model_request_sent: false,
    real_account_switch_tested: false,
    in_flight_resume_tested: false,
  });
  assert.deepEqual(
    summary.runtime.synthetic_websocket_pre_semantic_failure_classifications,
    {
      configured_bindings: 2,
      scenarios: 4,
      process_starts: 4,
      readiness_statuses: [200, 200, 200, 200],
      downstream_upgrade_statuses: [101, 101, 101, 101],
      initial_requests: 4,
      classifications: {
        rate_limited: {
          primary_failure_injection: "upgrade_http_429",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          downstream_error_exposed: false,
          third_upstream_attempt_observed: false,
        },
        auth_expired: {
          primary_failure_injection: "upgrade_http_401",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          downstream_error_exposed: false,
          third_upstream_attempt_observed: false,
        },
        network_error: {
          primary_failure_injection:
            "connection_closed_before_upgrade_headers",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          downstream_error_exposed: false,
          third_upstream_attempt_observed: false,
        },
        upstream_5xx: {
          primary_failure_injection: "upgrade_http_503",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          downstream_error_exposed: false,
          third_upstream_attempt_observed: false,
        },
      },
      max_upstream_attempts_per_request: 2,
      third_upstream_attempts_observed: 0,
      local_fixture_upstream_only: true,
      synthetic_credential_acquisition_tested: true,
      synthetic_websocket_requests_sent: 4,
      synthetic_upstream_attempts: 8,
      manual_switch_tested: false,
      real_credentials_present: false,
      real_model_request_sent: false,
      real_account_switch_tested: false,
      in_flight_resume_tested: false,
    },
  );
  assert.deepEqual(summary.runtime.synthetic_manual_switch_safety_boundary, {
    configured_bindings: 2,
    process_starts: 2,
    restart_count: 1,
    readiness_statuses: [200, 200],
    active_semantic_stream: {
      downstream_upgrade_status: 101,
      upstream_role_sequence: ["primary"],
      primary_semantic_marker_received: true,
      active_streams_before_denied_switch: 1,
      denied_switch_status: 409,
      denied_switch_error: "active_semantic_stream",
      current_route_role_before: "primary",
      current_route_role_after: "primary",
      durable_route_unchanged: true,
      completed_before_acceptance: true,
    },
    safe_boundary: {
      active_streams_at_acceptance: 0,
      accepted_switch_status: 200,
      accepted: true,
      target_role: "secondary",
      continuity: "new_backend_session",
      next_new_request_role_sequence: ["secondary"],
      next_new_request_completed: true,
      durable_preference_persisted: true,
    },
    restart: {
      readiness_status: 200,
      current_route_role: "secondary",
      continuity: "new_backend_session",
      next_new_request_role_sequence: ["secondary"],
      next_new_request_completed: true,
    },
    local_fixture_upstream_only: true,
    synthetic_credential_acquisition_tested: true,
    synthetic_manual_switch_tested: true,
    synthetic_model_requests_sent: 3,
    real_credentials_present: false,
    real_model_request_sent: false,
    real_account_switch_tested: false,
    in_flight_resume_tested: false,
  });
  assert.deepEqual(summary.runtime.synthetic_all_pool_unavailable, {
    configured_bindings: 2,
    process_starts: 1,
    readiness_before_status: 200,
    initial_requests: 1,
    downstream_status: 503,
    downstream_error: {
      type: "all_accounts_unavailable",
      reason: "no_eligible_account",
      attempts: 2,
      semantic_output: false,
    },
    upstream_role_sequence: ["primary", "secondary"],
    upstream_failure_sequence: ["rate_limited", "upstream_5xx"],
    retry_bound_observed: true,
    third_upstream_attempt_observed: false,
    readiness_after_status: 503,
    usable_accounts_after: 0,
    sanitized_error_exact: true,
    local_fixture_upstream_only: true,
    synthetic_credential_acquisition_tested: true,
    synthetic_model_requests_sent: 1,
    synthetic_upstream_attempts: 2,
    manual_switch_tested: false,
    real_credentials_present: false,
    real_model_request_sent: false,
    real_account_switch_tested: false,
    in_flight_resume_tested: false,
  });
  assert.deepEqual(
    summary.runtime.synthetic_pre_semantic_failure_classifications,
    {
      configured_bindings: 2,
      scenarios: 4,
      process_starts: 4,
      readiness_statuses: [200, 200, 200, 200],
      initial_requests: 4,
      downstream_statuses: [200, 200, 200, 200],
      classifications: {
        rate_limited: {
          primary_failure_injection: "http_429",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          third_upstream_attempt_observed: false,
        },
        auth_expired: {
          primary_failure_injection: "http_401",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          third_upstream_attempt_observed: false,
        },
        network_error: {
          primary_failure_injection: "connection_closed_before_headers",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          third_upstream_attempt_observed: false,
        },
        upstream_5xx: {
          primary_failure_injection: "http_503",
          upstream_role_sequence: ["primary", "secondary"],
          upstream_attempts: 2,
          secondary_semantic_marker_received: true,
          completed: true,
          third_upstream_attempt_observed: false,
        },
      },
      max_upstream_attempts_per_request: 2,
      third_upstream_attempts_observed: 0,
      local_fixture_upstream_only: true,
      synthetic_credential_acquisition_tested: true,
      synthetic_model_requests_sent: 4,
      synthetic_upstream_attempts: 8,
      manual_switch_tested: false,
      real_credentials_present: false,
      real_model_request_sent: false,
      real_account_switch_tested: false,
      in_flight_resume_tested: false,
    },
  );
});
