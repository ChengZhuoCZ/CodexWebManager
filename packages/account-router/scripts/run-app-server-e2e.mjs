import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  createCodexAuthSecretProvider,
  createRuntimeComposition,
  SecretProviderRegistry,
} from "../src/index.mjs";

const DEFAULT_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const codexPath = process.env.CODEX_PATH ?? DEFAULT_CODEX_PATH;
const upstreamOrigin = process.env.UPSTREAM_ORIGIN ?? "https://chatgpt.com";
const sourceHome = path.resolve(process.env.CODEX_HOME_A ?? path.join(os.homedir(), ".codex"));
const evidenceDirectory = process.env.M3_5_EVIDENCE_DIR;
const summaryLog = process.env.M3_5_SUMMARY_LOG;
const timeoutMs = Number.parseInt(process.env.M3_5_TIMEOUT_MS ?? "180000", 10);

if (
  !evidenceDirectory ||
  !summaryLog ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 10_000 ||
  timeoutMs > 600_000
) {
  process.stderr.write(
    "M3_5_EVIDENCE_DIR, M3_5_SUMMARY_LOG and a bounded M3_5_TIMEOUT_MS are required\n",
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

function withTimeout(promise, label, duration = timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), duration);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function safeErrorCategory(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.endsWith(" timed out")) return "timeout";
  if (message.includes("app-server exited")) return "app_server_exit";
  if (message.includes("app-server error")) return "app_server_rpc_error";
  if (message.includes("auth.json")) return "account_auth_slot_unavailable";
  if (message.includes("model/list")) return "model_discovery_failed";
  if (message.includes("thread/resume")) return "historical_resume_failed";
  return "e2e_error";
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

class AppServerClient {
  constructor({ codexHome, fixtureDirectory, routerBaseUrl }) {
    this.codexHome = codexHome;
    this.fixtureDirectory = fixtureDirectory;
    this.routerBaseUrl = routerBaseUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.notificationWaiters = new Set();
    this.agentMessages = [];
    this.stderrLineCount = 0;
    this.stopped = false;
  }

  async start() {
    this.child = spawn(
      codexPath,
      [
        "app-server",
        "--stdio",
        "-c",
        `openai_base_url=${JSON.stringify(this.routerBaseUrl)}`,
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="read-only"',
      ],
      {
        cwd: this.fixtureDirectory,
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"]
            .filter(Boolean)
            .join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost"]
            .filter(Boolean)
            .join(","),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrLineCount += chunk.split("\n").filter(Boolean).length;
    });
    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("app-server exited before returning a response"));
        }
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    this.child.once("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "m3_5_router_compatibility",
        title: "M3.5 Router Compatibility",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method} returned an app-server error`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      if (typeof message.params.item.text === "string") {
        this.agentMessages.push(message.params.item.text);
      }
    }
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.methods.has(message.method) && waiter.predicate(message)) {
        this.notificationWaiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = ++this.nextId;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.send({ method, id, params });
    return withTimeout(response, method);
  }

  waitFor(methods, predicate = () => true) {
    let waiter;
    const result = new Promise((resolve) => {
      waiter = { methods: new Set(methods), predicate, resolve };
      this.notificationWaiters.add(waiter);
    });
    return withTimeout(result, methods.join("|")).finally(() => {
      this.notificationWaiters.delete(waiter);
    });
  }

  async selectModel() {
    const list = await this.request("model/list", { limit: 20, includeHidden: false });
    const selected = list?.data?.find((entry) => entry?.isDefault) ?? list?.data?.[0];
    const model = selected?.model ?? selected?.id;
    if (typeof model !== "string") throw new Error("model/list did not return a usable model");
    this.model = model;
  }

  async startThread() {
    const result = await this.request("thread/start", {
      cwd: this.fixtureDirectory,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      baseInstructions:
        "This is a controlled compatibility fixture. Never use tools. Follow the response format exactly.",
      developerInstructions:
        "Do not inspect files, call tools, browse, expose environment data, or add commentary.",
      model: this.model,
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned an invalid thread");
    return threadId;
  }

  async resumeThread(threadId) {
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.fixtureDirectory,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: this.model,
    });
    if (result?.thread?.id !== threadId) {
      throw new Error("thread/resume returned an unexpected thread");
    }
  }

  async runTurn(threadId, input, expectedText) {
    this.agentMessages = [];
    const terminal = this.waitFor(
      ["turn/completed", "error"],
      (message) => {
        const candidate = message.params?.threadId ?? message.params?.turn?.threadId;
        return candidate === undefined || candidate === threadId;
      },
    );
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
    });
    const notification = await terminal;
    const result = {
      terminal_method: notification.method,
      status:
        notification.method === "turn/completed"
          ? notification.params?.turn?.status ?? "completed_unknown"
          : "error_notification",
      fixture_assertion: this.agentMessages.some((message) => message.trim() === expectedText),
    };
    this.agentMessages = [];
    return result;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.lines?.close();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await Promise.race([this.exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await this.exit;
    }
  }
}

function createRuntime({ credentialRoot, modelPort = 0 }) {
  const registry = new SecretProviderRegistry().register(
    createCodexAuthSecretProvider({ rootDirectory: credentialRoot }),
  );
  return createRuntimeComposition({
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
    secretRegistry: registry,
    upstreamOrigin,
    adminHost: "127.0.0.1",
    adminPort: 0,
    modelHost: "127.0.0.1",
    modelPort,
  });
}

function routerBaseUrl(address) {
  return `http://127.0.0.1:${address.port}/backend-api/codex`;
}

function fixtureToken() {
  return `M35FIX-${randomBytes(8).toString("hex").toUpperCase()}`;
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m3-5-router-e2e-"));
await fs.chmod(temporaryRoot, 0o700);
const fixtureDirectory = path.join(temporaryRoot, "workspace");
await fs.mkdir(fixtureDirectory, { mode: 0o700 });
await fs.writeFile(path.join(fixtureDirectory, "README.md"), "# M3.5 compatibility fixture\n", {
  mode: 0o600,
});

let runtime;
let client;
let exitCode = 0;
let activeStage = "initialization";
try {
  const isolatedHome = await createIsolatedHome(sourceHome, temporaryRoot);
  await emit({
    kind: "run_started",
    implementation_mode: "clean-room",
    account_alias_count: 1,
    account_switch_scenario_executed: false,
    credentials_persisted_to_evidence: false,
  });

  activeStage = "multi_turn";
  runtime = createRuntime({ credentialRoot: isolatedHome });
  const firstAddresses = await runtime.start();
  const firstModelPort = firstAddresses.model.port;
  client = new AppServerClient({
    codexHome: isolatedHome,
    fixtureDirectory,
    routerBaseUrl: routerBaseUrl(firstAddresses.model),
  });
  await client.start();
  await client.selectModel();
  const token = fixtureToken();
  const threadId = await client.startThread();
  const first = await client.runTurn(
    threadId,
    `Remember the fixture token in this message. Reply exactly READY. The fixture token is ${token}.`,
    "READY",
  );
  const second = await client.runTurn(
    threadId,
    "Reply only with the exact fixture token from the first turn.",
    token,
  );
  const beforeStderrLines = client.stderrLineCount;
  await emit({
    kind: "scenario_result",
    scenario: "single-account-multi-turn-through-router",
    first_turn_terminal: first.terminal_method,
    first_turn_status: first.status,
    first_turn_fixture_assertion: first.fixture_assertion,
    second_turn_terminal: second.terminal_method,
    second_turn_status: second.status,
    second_turn_fixture_assertion: second.fixture_assertion,
    outcome:
      first.fixture_assertion === true && second.fixture_assertion === true
        ? "multi_turn_passed"
        : "multi_turn_failed",
    app_server_stderr_line_count: beforeStderrLines,
  });
  if (first.fixture_assertion !== true || second.fixture_assertion !== true) exitCode = 1;

  activeStage = "restart_and_resume";
  await client.stop();
  client = null;
  await runtime.stop();
  runtime = null;

  runtime = createRuntime({ credentialRoot: isolatedHome, modelPort: firstModelPort });
  const resumedAddresses = await runtime.start();
  client = new AppServerClient({
    codexHome: isolatedHome,
    fixtureDirectory,
    routerBaseUrl: routerBaseUrl(resumedAddresses.model),
  });
  await client.start();
  await client.selectModel();
  await client.resumeThread(threadId);
  const resumed = await client.runTurn(
    threadId,
    "Reply only with the exact fixture token established earlier in this thread.",
    token,
  );
  await emit({
    kind: "scenario_result",
    scenario: "router-and-app-server-restart-resume",
    resumed_turn_terminal: resumed.terminal_method,
    resumed_turn_status: resumed.status,
    resumed_turn_fixture_assertion: resumed.fixture_assertion,
    outcome:
      resumed.fixture_assertion === true
        ? "historical_thread_resume_passed"
        : "historical_thread_resume_failed",
    app_server_stderr_line_count: client.stderrLineCount,
  });
  if (resumed.fixture_assertion !== true) exitCode = 1;

  activeStage = "deferred_account_switch";
  await emit({
    kind: "scenario_deferred",
    scenario: "approved-account-switch",
    reason: "second_authorized_account_unavailable",
    release_claim_permitted: false,
  });
} catch (error) {
  exitCode = 1;
  await emit({
    kind: "run_failed",
    stage: activeStage,
    error_category: safeErrorCategory(error),
  });
} finally {
  try {
    await client?.stop();
  } finally {
    await runtime?.stop();
  }
  await emit({ kind: "run_completed", exit_code: exitCode });
  await summaryPending;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;
