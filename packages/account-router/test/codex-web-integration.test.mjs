import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const wrapperPath = path.join(packageDirectory, "bin", "codex-router-cli.mjs");
const harnessPath = path.join(packageDirectory, "scripts", "run-codex-web-integration.mjs");

async function fixtureCli(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-wrapper-test-"));
  const executable = path.join(directory, "fixture-codex.mjs");
  const argumentLog = path.join(directory, "argv.json");
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.FIXTURE_ARGV_LOG, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 },
  );
  await fs.chmod(executable, 0o700);
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { executable, argumentLog };
}

function runWrapper(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrapperPath, args, {
      cwd: packageDirectory,
      env: {
        PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
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

function runHarness(environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath], {
      cwd: packageDirectory,
      env: {
        PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
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

test("injects only the fixed loopback router base URL into codex app-server", async (context) => {
  const fixture = await fixtureCli(context);
  const result = await runWrapper(["-c", "features.example=true", "app-server", "--stdio"], {
    CODEX_REAL_CLI_PATH: fixture.executable,
    CODEX_ROUTER_MODEL_BASE_URL: "http://127.0.0.1:18317/backend-api/codex",
    FIXTURE_ARGV_LOG: fixture.argumentLog,
  });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.argumentLog, "utf8")), [
    "-c",
    'openai_base_url="http://127.0.0.1:18317/backend-api/codex"',
    "-c",
    "features.example=true",
    "app-server",
    "--stdio",
  ]);
});

test("passes the codex version probe through without router arguments", async (context) => {
  const fixture = await fixtureCli(context);
  const result = await runWrapper(["--version"], {
    CODEX_REAL_CLI_PATH: fixture.executable,
    CODEX_ROUTER_MODEL_BASE_URL: "http://[::1]:18317/backend-api/codex",
    FIXTURE_ARGV_LOG: fixture.argumentLog,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.argumentLog, "utf8")), ["--version"]);
});

test("fails closed for public origins, malformed invocations, and missing configuration", async (context) => {
  const fixture = await fixtureCli(context);
  const cases = [
    {
      args: ["app-server"],
      env: { CODEX_REAL_CLI_PATH: fixture.executable },
    },
    {
      args: ["app-server"],
      env: {
        CODEX_REAL_CLI_PATH: fixture.executable,
        CODEX_ROUTER_MODEL_BASE_URL: "https://example.test/backend-api/codex",
      },
    },
    {
      args: ["exec", "fixture"],
      env: {
        CODEX_REAL_CLI_PATH: fixture.executable,
        CODEX_ROUTER_MODEL_BASE_URL: "http://127.0.0.1:18317/backend-api/codex",
      },
    },
  ];
  for (const candidate of cases) {
    const result = await runWrapper(candidate.args, {
      ...candidate.env,
      FIXTURE_ARGV_LOG: fixture.argumentLog,
    });
    assert.equal(result.code, 64);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /codex router wrapper configuration is invalid/);
    assert.doesNotMatch(result.stderr, /example\.test|18317|fixture-codex/);
  }
  await assert.rejects(fs.access(fixture.argumentLog));
});

test("integration harness validates all paths and bounds before reading account state", async () => {
  const missing = await runHarness();
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /M4_1_CODEX_WEB_ROOT/);
  assert.doesNotMatch(missing.stderr, /auth|token|cookie|authorization/i);

  const unbounded = await runHarness({
    M4_1_CODEX_WEB_ROOT: "/not-used",
    M4_1_EVIDENCE_DIR: "/not-used",
    M4_1_SUMMARY_LOG: "/not-used/summary.jsonl",
    M4_1_TIMEOUT_MS: "9999999",
  });
  assert.equal(unbounded.code, 2);
  assert.equal(unbounded.stdout, "");
  assert.match(unbounded.stderr, /bounded M4_1_TIMEOUT_MS/);
});
