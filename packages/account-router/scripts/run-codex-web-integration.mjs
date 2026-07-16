import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const EXPECTED_CODEX_WEB_REVISION = "888692f7d885118c6a92bbaf60cf2121f5947adf";
const DEFAULT_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const routerMain = path.join(packageDirectory, "src", "main.mjs");
const wrapperPath = path.join(packageDirectory, "bin", "codex-router-cli.mjs");
const codexWebRoot = process.env.M4_1_CODEX_WEB_ROOT;
const evidenceDirectory = process.env.M4_1_EVIDENCE_DIR;
const summaryLog = process.env.M4_1_SUMMARY_LOG;
const mode = process.env.M4_1_MODE ?? "smoke";
const timeoutMs = Number.parseInt(process.env.M4_1_TIMEOUT_MS ?? "180000", 10);
const sourceHome = path.resolve(process.env.CODEX_HOME_A ?? path.join(os.homedir(), ".codex"));
const codexPath = process.env.CODEX_REAL_CLI_PATH ?? DEFAULT_CODEX_PATH;
const upstreamOrigin = process.env.UPSTREAM_ORIGIN ?? "https://chatgpt.com";

if (
  typeof codexWebRoot !== "string" ||
  !path.isAbsolute(codexWebRoot) ||
  !evidenceDirectory ||
  !path.isAbsolute(evidenceDirectory) ||
  !summaryLog ||
  !path.isAbsolute(summaryLog) ||
  !new Set(["smoke", "serve"]).has(mode) ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 10_000 ||
  timeoutMs > 600_000
) {
  process.stderr.write(
    "M4_1_CODEX_WEB_ROOT, M4_1_EVIDENCE_DIR, M4_1_SUMMARY_LOG, M4_1_MODE and a bounded M4_1_TIMEOUT_MS are required\n",
  );
  process.exit(2);
}

await fs.mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await fs.chmod(evidenceDirectory, 0o700);
await fs.writeFile(summaryLog, "", { mode: 0o600 });
await fs.chmod(summaryLog, 0o600);
let summaryPending = Promise.resolve();

function emit(record) {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`;
  process.stdout.write(line);
  summaryPending = summaryPending.then(() => fs.appendFile(summaryLog, line, { mode: 0o600 }));
  return summaryPending;
}

function safeErrorCategory(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.endsWith(" timed out")) return "timeout";
  if (message.includes("pinned checkout")) return "codex_web_revision_mismatch";
  if (message.includes("tracked changes")) return "codex_web_tracked_changes";
  if (message.includes("auth.json")) return "account_auth_slot_unavailable";
  if (message.includes("fetch failed")) return "codex_web_root_unreachable";
  if (message.includes("router")) return "router_start_failed";
  if (message.includes("codex-web")) return "codex_web_start_failed";
  return "integration_error";
}

function withTimeout(promise, label, duration = timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), duration);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function git(args) {
  return spawnSync("git", ["-C", codexWebRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function assertPinnedCodexWebCheckout() {
  const revision = git(["rev-parse", "HEAD"]);
  if (revision.status !== 0 || revision.stdout.trim() !== EXPECTED_CODEX_WEB_REVISION) {
    throw new Error("codex-web pinned checkout is unavailable");
  }
  const trackedDiff = git(["diff", "--quiet", "--exit-code"]);
  if (trackedDiff.status !== 0) throw new Error("codex-web tracked changes are not allowed");
  for (const relativePath of ["src/server/main.js", "scratch/asar/package.json", "scratch/asar/webview/index.html"]) {
    const stat = await fs.stat(path.join(codexWebRoot, relativePath));
    if (!stat.isFile()) throw new Error("codex-web prepared asset is unavailable");
  }
}

async function createIsolatedHome(source, root) {
  const realSource = await fs.realpath(source);
  const sourceAuth = path.join(realSource, "auth.json");
  const sourceStat = await fs.lstat(sourceAuth);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("account auth.json must be a regular file");
  }
  const destination = path.join(root, "isolated-account-a");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, 0o700);
  await fs.copyFile(sourceAuth, path.join(destination, "auth.json"));
  await fs.chmod(path.join(destination, "auth.json"), 0o600);
  return destination;
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback port allocation failed");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function observeChild(child) {
  let stdoutLineCount = 0;
  let stderrLineCount = 0;
  const safeErrorCategories = new Set();
  const stdoutLines = readline.createInterface({ input: child.stdout });
  const stderrLines = readline.createInterface({ input: child.stderr });
  stdoutLines.on("line", () => { stdoutLineCount += 1; });
  stderrLines.on("line", (line) => {
    stderrLineCount += 1;
    if (/codex router wrapper configuration is invalid/.test(line)) {
      safeErrorCategories.add("router_wrapper_configuration");
    } else if (/MODULE_NOT_FOUND|Cannot find module/.test(line)) {
      safeErrorCategories.add("module_not_found");
    } else if (/better_sqlite3/i.test(line)) {
      safeErrorCategories.add("native_sqlite_module");
    } else if (/EADDRINUSE/.test(line)) {
      safeErrorCategories.add("address_in_use");
    } else if (/ENOENT/.test(line)) {
      safeErrorCategories.add("file_not_found");
    } else if (/\b(?:TypeError|Error):/.test(line)) {
      safeErrorCategories.add("generic_error_line");
    }
  });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return {
    exit,
    stdoutLines,
    stderrLines,
    counts: () => Object.freeze({
      stdoutLineCount,
      stderrLineCount,
      safeErrorCategories: [...safeErrorCategories].sort(),
    }),
  };
}

function waitForLine(observation, predicate, label) {
  const result = new Promise((resolve, reject) => {
    const onLine = (line) => {
      let value;
      try {
        value = predicate(line);
      } catch {
        value = null;
      }
      if (value !== null && value !== false && value !== undefined) {
        cleanup();
        resolve(value);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`${label} exited before readiness`));
    };
    const cleanup = () => {
      observation.stdoutLines.off("line", onLine);
      observation.exit.then(() => undefined);
    };
    observation.stdoutLines.on("line", onLine);
    observation.exit.then(onExit);
  });
  return withTimeout(result, label);
}

async function stopChild(child, observation) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    observation.exit,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await observation.exit;
  }
}

function loopbackNoProxy() {
  return [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
    .filter(Boolean)
    .join(",");
}

function awaitStopSignal(childObservation) {
  return new Promise((resolve, reject) => {
    const stop = (signal) => {
      cleanup();
      resolve(signal);
    };
    const exited = () => {
      cleanup();
      reject(new Error("codex-web exited before browser verification completed"));
    };
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    childObservation.exit.then(exited);
  });
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m4-1-codex-web-"));
await fs.chmod(temporaryRoot, 0o700);
let routerChild;
let routerObservation;
let codexWebChild;
let codexWebObservation;
let exitCode = 0;
let activeStage = "initialization";
try {
  await assertPinnedCodexWebCheckout();
  const isolatedHome = await createIsolatedHome(sourceHome, temporaryRoot);
  const accountsFile = path.join(temporaryRoot, "accounts.json");
  await fs.writeFile(
    accountsFile,
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "account-a",
          alias: "Account A",
          enabled: true,
          priority: 0,
          max_concurrency: 1,
          provider: "openai-codex",
          secret_provider: "codex-auth",
          credential_ref: "auth.json",
        },
      ],
    }),
    { mode: 0o600 },
  );
  const fixtureDirectory = path.join(temporaryRoot, "workspace");
  await fs.mkdir(fixtureDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(fixtureDirectory, "README.md"), "# M4.1 browser fixture\n", {
    mode: 0o600,
  });
  const processHome = path.join(temporaryRoot, "process-home");
  const xdgConfigHome = path.join(processHome, ".config");
  await fs.mkdir(xdgConfigHome, { recursive: true, mode: 0o700 });

  await emit({
    kind: "run_started",
    mode,
    implementation_mode: "clean-room",
    codex_web_revision: EXPECTED_CODEX_WEB_REVISION,
    codex_web_tracked_source_modified: false,
    account_alias_count: 1,
    account_switch_scenario_executed: false,
    credentials_persisted_to_evidence: false,
  });

  activeStage = "router_start";
  routerChild = spawn(process.execPath, [routerMain], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      CODEX_ROUTER_ACCOUNTS_FILE: accountsFile,
      CODEX_ROUTER_CREDENTIAL_ROOT: isolatedHome,
      CODEX_ROUTER_ADMIN_HOST: "127.0.0.1",
      CODEX_ROUTER_ADMIN_PORT: "0",
      CODEX_ROUTER_MODEL_HOST: "127.0.0.1",
      CODEX_ROUTER_MODEL_PORT: "0",
      CODEX_ROUTER_UPSTREAM_ORIGIN: upstreamOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  routerObservation = observeChild(routerChild);
  const routerAddresses = await waitForLine(
    routerObservation,
    (line) => {
      const record = JSON.parse(line);
      return record.event === "router_started"
        ? { adminPort: record.bind_port, modelPort: record.model_bind_port }
        : null;
    },
    "router readiness",
  );
  if (!Number.isInteger(routerAddresses.adminPort) || !Number.isInteger(routerAddresses.modelPort)) {
    throw new Error("router readiness payload is invalid");
  }

  activeStage = "codex_web_start";
  const webPort = await availableLoopbackPort();
  const noProxy = loopbackNoProxy();
  codexWebChild = spawn(
    process.execPath,
    [path.join(codexWebRoot, "src", "server", "main.js"), "--host", "127.0.0.1", "--port", String(webPort)],
    {
      cwd: codexWebRoot,
      env: {
        ...process.env,
        HOME: processHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        CODEX_HOME: isolatedHome,
        CODEX_CLI_PATH: wrapperPath,
        CODEX_REAL_CLI_PATH: codexPath,
        CODEX_ROUTER_MODEL_BASE_URL:
          `http://127.0.0.1:${routerAddresses.modelPort}/backend-api/codex`,
        INIT_CWD: fixtureDirectory,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  codexWebObservation = observeChild(codexWebChild);
  await waitForLine(
    codexWebObservation,
    (line) => line.includes(`IPC bridge listening at ws://127.0.0.1:${webPort}`),
    "codex-web readiness",
  );

  activeStage = "http_smoke";
  const url = `http://127.0.0.1:${webPort}/`;
  const response = await withTimeout(fetch(url), "codex-web root fetch", 10_000);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0] ?? null;
  const body = await response.text();
  const rootUsable = response.status === 200 && mediaType === "text/html" && /<!doctype html>/i.test(body);
  if (!rootUsable) {
    await emit({
      kind: "http_smoke_failed",
      status: response.status,
      media_type: mediaType,
      body_byte_length: Buffer.byteLength(body),
      body_has_doctype: /<!doctype html>/i.test(body),
    });
    throw new Error("codex-web root response is invalid");
  }
  await emit({
    kind: "service_ready",
    browser_url: url,
    web_root_status: response.status,
    web_root_media_type: mediaType,
    web_root_usable: true,
    browser_verification_required: mode === "serve",
  });

  if (mode === "serve") {
    activeStage = "browser_verification";
    const signal = await awaitStopSignal(codexWebObservation);
    await emit({ kind: "serve_stopped", signal, browser_verification_recorded_externally: true });
  }

  await emit({
    kind: "scenario_deferred",
    scenario: "same-browser-page-approved-account-switch",
    reason: "second_authorized_account_unavailable",
    release_claim_permitted: false,
  });
} catch (error) {
  exitCode = 1;
  await emit({ kind: "run_failed", stage: activeStage, error_category: safeErrorCategory(error) });
} finally {
  await stopChild(codexWebChild, codexWebObservation);
  await stopChild(routerChild, routerObservation);
  const routerCounts = routerObservation?.counts() ?? {
    stdoutLineCount: 0,
    stderrLineCount: 0,
    safeErrorCategories: [],
  };
  const codexWebCounts = codexWebObservation?.counts() ?? {
    stdoutLineCount: 0,
    stderrLineCount: 0,
    safeErrorCategories: [],
  };
  await emit({
    kind: "run_completed",
    exit_code: exitCode,
    router_stdout_line_count: routerCounts.stdoutLineCount,
    router_stderr_line_count: routerCounts.stderrLineCount,
    router_safe_error_categories: routerCounts.safeErrorCategories,
    router_exit_code: routerChild?.exitCode ?? null,
    router_signal: routerChild?.signalCode ?? null,
    codex_web_stdout_line_count: codexWebCounts.stdoutLineCount,
    codex_web_stderr_line_count: codexWebCounts.stderrLineCount,
    codex_web_safe_error_categories: codexWebCounts.safeErrorCategories,
    codex_web_exit_code: codexWebChild?.exitCode ?? null,
    codex_web_signal: codexWebChild?.signalCode ?? null,
  });
  await summaryPending;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;
