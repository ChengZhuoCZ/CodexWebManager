import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const defaultMatrixPath = path.join(packageDirectory, "test-matrix.json");
const suiteIds = ["unit", "integration", "e2e"];
const failureIds = [
  "quota",
  "http_429",
  "auth",
  "network",
  "upstream_5xx",
  "malformed_sse",
];
const boundaryIds = ["before_semantic_output", "after_semantic_output"];
const e2eScenarioIds = [
  ["codex_web_ui_active", "active"],
  ["codex_web_ui_exhausted", "exhausted"],
  ["codex_web_ui_disabled", "disabled"],
];
const testPathPattern = /^test\/[a-z0-9-]+\.test\.mjs$/;
const safeNamePattern = /^[A-Za-z0-9 :._-]{1,160}$/;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(`${label} ids must be exactly ${expected.join(", ")}`);
  }
}

function validateReference(reference, label) {
  if (
    !plainObject(reference) ||
    Object.keys(reference).length !== 2 ||
    !testPathPattern.test(reference.test_file) ||
    typeof reference.test_name !== "string" ||
    !safeNamePattern.test(reference.test_name)
  ) {
    throw new Error(`${label} test reference is invalid`);
  }
}

export function validateTestMatrix(matrix) {
  if (
    !plainObject(matrix) ||
    matrix.schema_version !== 1 ||
    matrix.task !== "M6.1" ||
    !Array.isArray(matrix.suites)
  ) {
    throw new Error("test matrix envelope is invalid");
  }
  if (JSON.stringify(matrix.suites.map(({ id }) => id)) !== JSON.stringify(suiteIds)) {
    throw new Error(`suite ids must be exactly ${suiteIds.join(", ")}`);
  }
  const seen = new Set();
  for (const suite of matrix.suites) {
    if (
      !plainObject(suite) ||
      Object.keys(suite).length !== 2 ||
      !suiteIds.includes(suite.id) ||
      !Array.isArray(suite.test_files) ||
      suite.test_files.length < 1
    ) {
      throw new Error("test suite definition is invalid");
    }
    for (const testFile of suite.test_files) {
      if (!testPathPattern.test(testFile) || seen.has(testFile)) {
        throw new Error("every test file must belong to exactly one suite");
      }
      seen.add(testFile);
    }
  }
  if (
    !Array.isArray(matrix.e2e_smoke_scenarios) ||
    JSON.stringify(matrix.e2e_smoke_scenarios.map(({ id, scenario }) => [id, scenario])) !==
      JSON.stringify(e2eScenarioIds) ||
    matrix.e2e_smoke_scenarios.some((entry) =>
      !plainObject(entry) || Object.keys(entry).length !== 2)
  ) {
    throw new Error("E2E smoke scenarios are invalid");
  }
  exactKeys(matrix.failure_injections, failureIds, "failure injection");
  for (const [fault, reference] of Object.entries(matrix.failure_injections)) {
    validateReference(reference, fault);
  }
  exactKeys(matrix.sse_safety_boundaries, boundaryIds, "SSE safety boundary");
  for (const [boundary, reference] of Object.entries(matrix.sse_safety_boundaries)) {
    validateReference(reference, boundary);
  }
  return matrix;
}

export async function loadTestMatrix(matrixPath = defaultMatrixPath) {
  if (typeof matrixPath !== "string" || !path.isAbsolute(matrixPath)) {
    throw new Error("test matrix path must be absolute");
  }
  let text;
  try {
    text = await fs.readFile(matrixPath, "utf8");
  } catch {
    throw new Error("test matrix is unavailable");
  }
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("test matrix is too large");
  let matrix;
  try {
    matrix = JSON.parse(text);
  } catch {
    throw new Error("test matrix JSON is invalid");
  }
  return validateTestMatrix(matrix);
}

function parseArguments(argv) {
  let summaryPath = null;
  let selectedSuite = "all";
  let matrixPath = defaultMatrixPath;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--summary" && value !== undefined) {
      summaryPath = value;
      index += 1;
      continue;
    }
    if (option === "--suite" && value !== undefined) {
      selectedSuite = value;
      index += 1;
      continue;
    }
    if (option === "--matrix" && value !== undefined) {
      matrixPath = value;
      index += 1;
      continue;
    }
    throw new Error("unsupported test matrix option");
  }
  if (typeof summaryPath !== "string" || !path.isAbsolute(summaryPath)) {
    throw new Error("an absolute --summary path is required");
  }
  if (![...suiteIds, "all"].includes(selectedSuite)) {
    throw new Error("--suite must be unit, integration, e2e, or all");
  }
  if (typeof matrixPath !== "string" || !path.isAbsolute(matrixPath)) {
    throw new Error("--matrix must be an absolute path");
  }
  return { matrixPath, selectedSuite, summaryPath };
}

function tapCount(output, name) {
  const match = new RegExp(`^# ${name} ([0-9]+)$`, "m").exec(output);
  if (!match) throw new Error("test reporter summary is unavailable");
  return Number(match[1]);
}

function runSuite(suite) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...suite.test_files],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60_000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${suite.id} suite timed out`);
  if (result.status !== 0) throw new Error(`${suite.id} suite failed`);
  const output = result.stdout ?? "";
  const summary = {
    id: suite.id,
    test_files: suite.test_files.length,
    tests: tapCount(output, "tests"),
    passed: tapCount(output, "pass"),
    failed: tapCount(output, "fail"),
    skipped: tapCount(output, "skipped"),
    duration_ms: Date.now() - startedAt,
  };
  if (summary.failed !== 0 || summary.passed + summary.skipped !== summary.tests) {
    throw new Error(`${suite.id} suite returned inconsistent totals`);
  }
  if (summary.skipped !== 0) throw new Error(`${suite.id} suite contains skipped release-gate tests`);
  return Object.freeze(summary);
}

async function runE2eSmokes(matrix) {
  const codexWebRoot = process.env.M4_3_CODEX_WEB_ROOT;
  if (typeof codexWebRoot !== "string" || !path.isAbsolute(codexWebRoot)) {
    throw new Error("E2E smoke requires an absolute M4_3_CODEX_WEB_ROOT");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m6-1-e2e-smoke-"));
  await fs.chmod(root, 0o700);
  try {
    const results = [];
    for (const entry of matrix.e2e_smoke_scenarios) {
      const evidenceDirectory = path.join(root, entry.id);
      const summaryLog = path.join(root, `${entry.id}.jsonl`);
      const result = spawnSync(
        process.execPath,
        ["scripts/run-codex-web-account-ui.mjs"],
        {
          cwd: packageDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            M4_3_CODEX_WEB_ROOT: codexWebRoot,
            M4_3_EVIDENCE_DIR: evidenceDirectory,
            M4_3_SUMMARY_LOG: summaryLog,
            M4_3_SCENARIO: entry.scenario,
            M4_3_MODE: "smoke",
            M4_3_TIMEOUT_MS: "120000",
          },
          maxBuffer: 2 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 3 * 60_000,
        },
      );
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      if (result.error?.code === "ETIMEDOUT") throw new Error(`${entry.id} timed out`);
      if (result.status !== 0) throw new Error(`${entry.id} failed`);
      const records = (await fs.readFile(summaryLog, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (
        records.length !== 2 ||
        records[0].event !== "fixture_started" ||
        records[1].event !== "fixture_finished" ||
        records.some(({ account_switch_scenario_executed: switched }) => switched !== false)
      ) {
        throw new Error(`${entry.id} returned invalid evidence`);
      }
      results.push(Object.freeze({
        id: entry.id,
        scenario: entry.scenario,
        passed: true,
        account_switch_scenario_executed: false,
      }));
    }
    return Object.freeze(results);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writePrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("summary directory must be a real directory");
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const matrixText = await fs.readFile(options.matrixPath);
    const matrix = await loadTestMatrix(options.matrixPath);
    const selected = options.selectedSuite === "all"
      ? matrix.suites
      : matrix.suites.filter(({ id }) => id === options.selectedSuite);
    const suites = selected.map(runSuite);
    const suiteNames = new Set(suites.map(({ id }) => id));
    const e2eSmokeScenarios = suiteNames.has("e2e")
      ? await runE2eSmokes(matrix)
      : [];
    const failureInjections = Object.fromEntries(
      Object.entries(matrix.failure_injections).map(([id, reference]) => [
        id,
        {
          test_file: reference.test_file,
          test_name: reference.test_name,
          passed: suiteNames.has("integration"),
        },
      ]),
    );
    const sseSafetyBoundaries = Object.fromEntries(
      Object.entries(matrix.sse_safety_boundaries).map(([id, reference]) => {
        const owner = matrix.suites.find(({ test_files: files }) =>
          files.includes(reference.test_file))?.id;
        return [
          id,
          {
            test_file: reference.test_file,
            test_name: reference.test_name,
            passed: owner !== undefined && suiteNames.has(owner),
          },
        ];
      }),
    );
    const summary = {
      schema_version: 1,
      task: "M6.1",
      generated_at: new Date().toISOString(),
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        node_version: process.version,
      },
      matrix_sha256: createHash("sha256").update(matrixText).digest("hex"),
      selected_suite: options.selectedSuite,
      suites,
      totals: {
        tests: suites.reduce((total, suite) => total + suite.tests, 0),
        passed: suites.reduce((total, suite) => total + suite.passed, 0),
        failed: suites.reduce((total, suite) => total + suite.failed, 0),
        skipped: suites.reduce((total, suite) => total + suite.skipped, 0),
      },
      e2e_smoke_scenarios: e2eSmokeScenarios,
      failure_injections: failureInjections,
      sse_safety_boundaries: sseSafetyBoundaries,
      architecture_mode: "LIMITED_MODE",
      real_account_configured: false,
      account_switch_tested: false,
      in_flight_computation_resume_claimed: false,
      seamless_account_continuity_claimed: false,
    };
    await writePrivateJson(options.summaryPath, summary);
  } catch (error) {
    process.stderr.write(`test matrix failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
