import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createContinuityRelay } from "../src/continuity-relay.mjs";

const codexPath = process.env.CODEX_PATH ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const upstreamOrigin = process.env.UPSTREAM_ORIGIN ?? "https://chatgpt.com";
const mode = process.env.M0_3_MODE ?? "control";
const evidenceDirectory = process.env.M0_3_EVIDENCE_DIR;
const summaryLog = process.env.M0_3_SUMMARY_LOG;
const timeoutMs = Number.parseInt(process.env.M0_3_TIMEOUT_MS ?? "180000", 10);
const sourceHomeA = path.resolve(process.env.CODEX_HOME_A ?? path.join(os.homedir(), ".codex"));
const sourceHomeB = process.env.CODEX_HOME_B ? path.resolve(process.env.CODEX_HOME_B) : null;
const scenarioGroups = new Set(
  (process.env.M0_3_SCENARIOS ?? "all")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const allowedScenarioGroups = new Set(["all", "continuity", "restart", "boundaries"]);

if (
  !new Set(["control", "cross"]).has(mode) ||
  !evidenceDirectory ||
  !summaryLog ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 10_000 ||
  scenarioGroups.size === 0 ||
  [...scenarioGroups].some((value) => !allowedScenarioGroups.has(value)) ||
  (mode === "cross" && scenarioGroups.has("restart"))
) {
  process.stderr.write(
    "M0_3_MODE, M0_3_EVIDENCE_DIR, M0_3_SUMMARY_LOG, M0_3_SCENARIOS and a valid M0_3_TIMEOUT_MS are required\n",
  );
  process.exit(2);
}
if (mode === "cross" && !sourceHomeB) {
  process.stderr.write("CODEX_HOME_B is required for cross mode\n");
  process.exit(2);
}

await fs.mkdir(evidenceDirectory, { recursive: true });
await fs.writeFile(summaryLog, "", { mode: 0o600 });
let summaryPending = Promise.resolve();
let activeStage = "initialization";

function shouldRun(group) {
  return scenarioGroups.has("all") || scenarioGroups.has(group);
}

function safeErrorCategory(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.endsWith(" timed out")) {
    return "timeout";
  }
  if (message.includes("app-server exited")) {
    return "app_server_exit";
  }
  if (message.includes("returned an app-server error")) {
    return "app_server_rpc_error";
  }
  if (message.includes("distinct authorized identity")) {
    return "account_identity_not_distinct";
  }
  if (message.includes("auth.json")) {
    return "account_auth_slot_unavailable";
  }
  if (message.includes("WebSocket") || message.includes("upstream route")) {
    return "relay_or_upstream_error";
  }
  return "experiment_error";
}

function emit(record) {
  const safeRecord = { timestamp: new Date().toISOString(), ...record };
  const line = `${JSON.stringify(safeRecord)}\n`;
  process.stdout.write(line);
  summaryPending = summaryPending.then(() => fs.appendFile(summaryLog, line, { mode: 0o600 }));
  return summaryPending;
}

function withTimeout(promise, label, duration = timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), duration);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function createIsolatedHome(sourceHome, root, alias) {
  const sourceAuth = path.join(sourceHome, "auth.json");
  const sourceStat = await fs.lstat(sourceAuth);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`${alias} auth.json must be a regular file`);
  }
  const destination = path.join(root, alias);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, 0o700);
  await fs.copyFile(sourceAuth, path.join(destination, "auth.json"));
  await fs.chmod(path.join(destination, "auth.json"), 0o600);
  return destination;
}

class AppServerClient {
  constructor({ codexHome, fixtureDirectory, proxyBaseUrl, alias }) {
    this.codexHome = codexHome;
    this.fixtureDirectory = fixtureDirectory;
    this.proxyBaseUrl = proxyBaseUrl;
    this.alias = alias;
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
        `openai_base_url=${JSON.stringify(this.proxyBaseUrl)}`,
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
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
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
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: {
        name: "m0_continuity_experiment",
        title: "M0 Continuity Experiment",
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
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method} returned an app-server error`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      const text = message.params.item.text;
      if (typeof text === "string") {
        this.agentMessages.push(text);
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
    return withTimeout(response, `${this.alias}:${method}`);
  }

  waitFor(methods, predicate = () => true, duration = timeoutMs) {
    let waiter;
    const result = new Promise((resolve) => {
      waiter = { methods: new Set(methods), predicate, resolve };
      this.notificationWaiters.add(waiter);
    });
    return withTimeout(result, `${this.alias}:${methods.join("|")}`, duration).finally(() => {
      this.notificationWaiters.delete(waiter);
    });
  }

  async selectModel() {
    const list = await this.request("model/list", { limit: 20, includeHidden: false });
    const selected = list?.data?.find((entry) => entry?.isDefault) ?? list?.data?.[0];
    const model = selected?.model ?? selected?.id;
    if (typeof model !== "string") {
      throw new Error("model/list did not return a usable model");
    }
    this.model = model;
    return model;
  }

  async startThread({ ephemeral = true } = {}) {
    const result = await this.request("thread/start", {
      cwd: this.fixtureDirectory,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral,
      baseInstructions:
        "This is a controlled protocol-continuity fixture. Never use tools. Follow the fixture response format exactly.",
      developerInstructions:
        "Do not inspect files, call tools, browse, expose environment data, or add commentary.",
      model: this.model,
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string") {
      throw new Error("thread/start did not return a thread id");
    }
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
      throw new Error("thread/resume returned an unexpected thread id");
    }
  }

  async runTurn(threadId, input, { expectedText = null, terminalTimeoutMs = timeoutMs } = {}) {
    this.agentMessages = [];
    const terminal = this.waitFor(
      ["turn/completed", "error"],
      (message) => {
        const candidate = message.params?.threadId ?? message.params?.turn?.threadId;
        return candidate === undefined || candidate === threadId;
      },
      terminalTimeoutMs,
    );
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
    });
    const notification = await terminal;
    const status =
      notification.method === "turn/completed"
        ? notification.params?.turn?.status ?? "completed_unknown"
        : "error_notification";
    const fixtureAssertion =
      expectedText === null
        ? null
        : this.agentMessages.some((message) => message.trim() === expectedText);
    this.agentMessages = [];
    return { terminal_method: notification.method, status, fixture_assertion: fixtureAssertion };
  }

  async stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.lines?.close();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await Promise.race([
      this.exit,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await this.exit;
    }
  }
}

function fixtureToken() {
  return `M0FIX-${randomBytes(8).toString("hex").toUpperCase()}`;
}

function firstTurnPrompt(token) {
  return `Remember the fixture token in this message. Reply exactly READY. The fixture token is ${token}.`;
}

function recallPrompt() {
  return "Reply only with the exact fixture token from the immediately preceding turn.";
}

async function readRelayRecords(logPath) {
  return (await fs.readFile(logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function proxyBaseUrl(relay, alias) {
  return `http://127.0.0.1:${relay.address.port}/${alias}/backend-api/codex`;
}

async function startClient({ home, fixtureDirectory, relay, alias }) {
  const client = new AppServerClient({
    codexHome: home,
    fixtureDirectory,
    proxyBaseUrl: proxyBaseUrl(relay, alias),
    alias,
  });
  await client.start();
  await client.selectModel();
  return client;
}

async function primeSecondAccount({ homeB, fixtureDirectory, relay }) {
  const client = await startClient({
    home: homeB,
    fixtureDirectory,
    relay,
    alias: "account-b",
  });
  await client.stop();
  const identity = relay.identityStatus();
  if (!identity.account_b_captured || identity.distinct !== true) {
    throw new Error("account B was not captured as a distinct authorized identity");
  }
  return client.stderrLineCount;
}

async function runTwoTurnScenario({
  name,
  routePlan,
  homeA,
  homeB,
  fixtureDirectory,
  requireDistinctAccounts,
}) {
  const relayLog = path.join(evidenceDirectory, `${name}-relay.jsonl`);
  const relay = await createContinuityRelay({ upstreamOrigin, logPath: relayLog, routePlan });
  let clientA;
  let clientBStderrLines = 0;
  try {
    clientA = await startClient({
      home: homeA,
      fixtureDirectory,
      relay,
      alias: "account-a",
    });
    if (requireDistinctAccounts) {
      clientBStderrLines = await primeSecondAccount({ homeB, fixtureDirectory, relay });
    }
    const token = fixtureToken();
    const threadId = await clientA.startThread({ ephemeral: true });
    const first = await clientA.runTurn(threadId, firstTurnPrompt(token), { expectedText: "READY" });
    const second = await clientA.runTurn(threadId, recallPrompt(), { expectedText: token });
    await relay.flush();
    const records = await readRelayRecords(relayLog);
    const routeRecords = records.filter((record) => record.kind === "response_create_route");
    const secondTurnRoute = routeRecords.at(-1);
    const outcome =
      second.fixture_assertion === true
        ? "continuity_preserved"
        : second.terminal_method !== "turn/completed" || second.status !== "completed"
          ? "explicit_failure"
          : "continuity_not_preserved";
    const result = {
      kind: "scenario_result",
      scenario: name,
      account_identity_distinct: requireDistinctAccounts ? relay.identityStatus().distinct : null,
      first_turn_terminal: first.terminal_method,
      first_turn_status: first.status,
      first_turn_fixture_assertion: first.fixture_assertion,
      second_turn_terminal: second.terminal_method,
      second_turn_status: second.status,
      second_turn_fixture_assertion: second.fixture_assertion,
      response_create_count: routeRecords.length,
      previous_response_id_present_before:
        secondTurnRoute?.previous_response_id_present_before ?? null,
      previous_response_id_present_after:
        secondTurnRoute?.previous_response_id_present_after ?? null,
      outcome,
      app_server_a_stderr_line_count: clientA.stderrLineCount,
      app_server_b_stderr_line_count: clientBStderrLines,
    };
    await emit(result);
    return result;
  } finally {
    await clientA?.stop();
    await relay.close();
  }
}

async function runRestartResumeScenario({ homeA, fixtureDirectory }) {
  const beforeLog = path.join(evidenceDirectory, "restart-resume-before-relay.jsonl");
  const afterLog = path.join(evidenceDirectory, "restart-resume-after-relay.jsonl");
  let relay;
  let client;
  try {
    relay = await createContinuityRelay({
      upstreamOrigin,
      logPath: beforeLog,
      routePlan: [{ accountAlias: "account-a" }, { accountAlias: "account-a" }],
    });
    const relayPort = relay.address.port;
    client = await startClient({ home: homeA, fixtureDirectory, relay, alias: "account-a" });
    const token = fixtureToken();
    const threadId = await client.startThread({ ephemeral: false });
    const first = await client.runTurn(threadId, firstTurnPrompt(token), { expectedText: "READY" });
    const firstStderrLines = client.stderrLineCount;
    await client.stop();
    client = null;
    await relay.close();
    relay = null;

    relay = await createContinuityRelay({
      upstreamOrigin,
      logPath: afterLog,
      routePlan: [{ accountAlias: "account-a" }, { accountAlias: "account-a" }],
      port: relayPort,
    });
    client = await startClient({ home: homeA, fixtureDirectory, relay, alias: "account-a" });
    await client.resumeThread(threadId);
    const second = await client.runTurn(threadId, recallPrompt(), { expectedText: token });
    await relay.flush();
    const records = await readRelayRecords(afterLog);
    const routeRecords = records.filter((record) => record.kind === "response_create_route");
    const routeRecord = routeRecords.at(-1);
    const result = {
      kind: "scenario_result",
      scenario: "router-and-app-server-restart-resume",
      first_turn_terminal: first.terminal_method,
      first_turn_status: first.status,
      first_turn_fixture_assertion: first.fixture_assertion,
      resumed_turn_terminal: second.terminal_method,
      resumed_turn_status: second.status,
      resumed_turn_fixture_assertion: second.fixture_assertion,
      previous_response_id_present_after_resume:
        routeRecord?.previous_response_id_present_before ?? null,
      response_create_count_after_resume: routeRecords.length,
      outcome:
        second.fixture_assertion === true
          ? "thread_resumed_with_continuity"
          : "thread_resume_continuity_not_preserved",
      app_server_before_stderr_line_count: firstStderrLines,
      app_server_after_stderr_line_count: client.stderrLineCount,
    };
    await emit(result);
    return result;
  } finally {
    try {
      await client?.stop();
    } finally {
      await relay?.close();
    }
  }
}

async function runFailureBoundaryScenarios({ homeA, homeB, fixtureDirectory, crossFallback }) {
  const beforeLog = path.join(
    evidenceDirectory,
    `${crossFallback ? "cross-" : ""}failure-before-initial-relay.jsonl`,
  );
  const fallbackAlias = crossFallback ? "account-b" : "account-a";
  const beforeRelay = await createContinuityRelay({
    upstreamOrigin,
    logPath: beforeLog,
    routePlan: [
      {
        accountAlias: "account-a",
        injectFailureBeforeSemantic: true,
        fallbackAlias,
      },
      { accountAlias: fallbackAlias },
    ],
  });
  let beforeClient;
  let boundaryResults;
  try {
    beforeClient = await startClient({
      home: homeA,
      fixtureDirectory,
      relay: beforeRelay,
      alias: "account-a",
    });
    if (crossFallback) {
      await primeSecondAccount({ homeB, fixtureDirectory, relay: beforeRelay });
    }
    const expected = fixtureToken();
    const threadId = await beforeClient.startThread({ ephemeral: true });
    const turn = await beforeClient.runTurn(
      threadId,
      `Reply only with this fixture token: ${expected}`,
      { expectedText: expected },
    );
    await beforeRelay.flush();
    const records = await readRelayRecords(beforeLog);
    const injectedRecord = records.find(
      (record) =>
        record.kind === "failure_injected" &&
        record.boundary === "before_first_semantic_event" &&
        record.replay_allowed === true,
    );
    const injectedRoute = records.find(
      (record) =>
        record.kind === "response_create_route" &&
        record.message_sequence === injectedRecord?.message_sequence,
    );
    const injected = Boolean(injectedRecord);
    const previousPresentAtInjection =
      injectedRoute?.previous_response_id_present_after ?? null;
    const beforeResult = {
      kind: "scenario_result",
      scenario: crossFallback
        ? "cross-failure-before-initial-semantic"
        : "failure-before-initial-semantic",
      fallback_account_alias: fallbackAlias,
      account_identity_distinct: crossFallback ? beforeRelay.identityStatus().distinct : null,
      terminal_method: turn.terminal_method,
      turn_status: turn.status,
      fixture_assertion: turn.fixture_assertion,
      failure_injected: injected,
      failure_message_sequence: injectedRecord?.message_sequence ?? null,
      previous_response_id_present_at_injection: previousPresentAtInjection,
      outcome:
        injected && previousPresentAtInjection === false && turn.fixture_assertion === true
          ? "bounded_replay_succeeded"
          : "bounded_replay_failed",
      app_server_stderr_line_count: beforeClient.stderrLineCount,
    };
    await emit(beforeResult);
    boundaryResults = { before: beforeResult, after: null };
  } finally {
    await beforeClient?.stop();
    await beforeRelay.close();
  }

  if (crossFallback) {
    return boundaryResults;
  }

  const afterLog = path.join(evidenceDirectory, "failure-after-relay.jsonl");
  const afterRelay = await createContinuityRelay({
    upstreamOrigin,
    logPath: afterLog,
    routePlan: [
      { accountAlias: "account-a" },
      { accountAlias: "account-a", cutAfterSemantic: true },
    ],
  });
  let afterClient;
  let terminal = null;
  try {
    afterClient = await startClient({
      home: homeA,
      fixtureDirectory,
      relay: afterRelay,
      alias: "account-a",
    });
    const threadId = await afterClient.startThread({ ephemeral: true });
    try {
      terminal = await afterClient.runTurn(
        threadId,
        "Reply with a short fixture response and do not use tools.",
        { terminalTimeoutMs: Math.min(timeoutMs, 60_000) },
      );
    } catch (error) {
      terminal = {
        terminal_method: "timeout_or_disconnect",
        status: error instanceof Error && error.message.includes("timed out") ? "timed_out" : "disconnected",
      };
    }
    await afterRelay.flush();
    const records = await readRelayRecords(afterLog);
    const injected = records.some(
      (record) =>
        record.kind === "failure_injected" &&
        record.boundary === "after_first_semantic_event" &&
        record.replay_allowed === false,
    );
    const routeAttempts = records.filter((record) => record.kind === "upstream_route_attempt");
    const replayBlocked = records.some((record) => record.kind === "replay_blocked");
    const transparentReplayPrevented = injected && routeAttempts.length === 1;
    const afterResult = {
      kind: "scenario_result",
      scenario: "failure-after-semantic",
      terminal_method: terminal.terminal_method,
      turn_status: terminal.status,
      failure_injected: injected,
      replay_blocked_event_observed: replayBlocked,
      upstream_route_attempt_count: routeAttempts.length,
      transparent_replay_prevented: transparentReplayPrevented,
      outcome: transparentReplayPrevented ? "unsafe_to_replay_enforced" : "unsafe_replay_detected",
      app_server_stderr_line_count: afterClient.stderrLineCount,
    };
    await emit(afterResult);
    boundaryResults.after = afterResult;
  } finally {
    await afterClient?.stop();
    await afterRelay.close();
  }
  return boundaryResults;
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m0-continuity-e2e-"));
const fixtureDirectory = path.join(temporaryRoot, "workspace");
await fs.mkdir(fixtureDirectory, { mode: 0o700 });
await fs.writeFile(
  path.join(fixtureDirectory, "README.md"),
  "# M0.3 protocol continuity fixture\n",
  { mode: 0o600 },
);

let exitCode = 0;
try {
  const realHomeA = await fs.realpath(sourceHomeA);
  const realHomeB = sourceHomeB ? await fs.realpath(sourceHomeB) : null;
  if (mode === "cross" && realHomeA === realHomeB) {
    throw new Error("CODEX_HOME_A and CODEX_HOME_B must be distinct directories");
  }

  const homeA = await createIsolatedHome(realHomeA, temporaryRoot, "isolated-account-a");
  const homeB = realHomeB
    ? await createIsolatedHome(realHomeB, temporaryRoot, "isolated-account-b")
    : null;

  await emit({
    kind: "run_started",
    mode,
    scenario_groups: [...scenarioGroups].sort(),
    implementation_mode: "clean-room",
    source_account_paths_distinct: mode === "cross" ? realHomeA !== realHomeB : null,
    credentials_persisted_to_evidence: false,
  });

  if (mode === "control") {
    if (shouldRun("continuity")) {
      activeStage = "control_continuity_with_previous";
      const standard = await runTwoTurnScenario({
        name: "control-a-to-a-with-previous",
        routePlan: [
          { accountAlias: "account-a" },
          { accountAlias: "account-a" },
          { accountAlias: "account-a" },
        ],
        homeA,
        homeB,
        fixtureDirectory,
        requireDistinctAccounts: false,
      });
      activeStage = "control_continuity_without_previous";
      const withoutPrevious = await runTwoTurnScenario({
        name: "control-a-to-a-without-previous",
        routePlan: [
          { accountAlias: "account-a" },
          { accountAlias: "account-a" },
          { accountAlias: "account-a", omitPreviousResponseId: true },
        ],
        homeA,
        homeB,
        fixtureDirectory,
        requireDistinctAccounts: false,
      });
      if (
        standard.first_turn_fixture_assertion !== true ||
        standard.second_turn_fixture_assertion !== true ||
        withoutPrevious.first_turn_fixture_assertion !== true ||
        withoutPrevious.second_turn_terminal !== "turn/completed" ||
        withoutPrevious.previous_response_id_present_after !== false
      ) {
        exitCode = 1;
      }
    }
    if (shouldRun("restart")) {
      activeStage = "control_restart_resume";
      const restart = await runRestartResumeScenario({ homeA, fixtureDirectory });
      if (restart.resumed_turn_fixture_assertion !== true) {
        exitCode = 1;
      }
    }
    if (shouldRun("boundaries")) {
      activeStage = "control_failure_boundaries";
      const boundaries = await runFailureBoundaryScenarios({
        homeA,
        homeB,
        fixtureDirectory,
        crossFallback: false,
      });
      if (
        boundaries.before.outcome !== "bounded_replay_succeeded" ||
        boundaries.after?.outcome !== "unsafe_to_replay_enforced"
      ) {
        exitCode = 1;
      }
    }
  } else {
    if (shouldRun("continuity")) {
      activeStage = "cross_continuity_with_previous";
      const withPrevious = await runTwoTurnScenario({
        name: "cross-a-to-b-with-previous",
        routePlan: [
          { accountAlias: "account-a" },
          { accountAlias: "account-a" },
          { accountAlias: "account-b" },
        ],
        homeA,
        homeB,
        fixtureDirectory,
        requireDistinctAccounts: true,
      });
      activeStage = "cross_continuity_without_previous";
      const withoutPrevious = await runTwoTurnScenario({
        name: "cross-a-to-b-without-previous",
        routePlan: [
          { accountAlias: "account-a" },
          { accountAlias: "account-a" },
          { accountAlias: "account-b", omitPreviousResponseId: true },
        ],
        homeA,
        homeB,
        fixtureDirectory,
        requireDistinctAccounts: true,
      });
      if (
        withPrevious.account_identity_distinct !== true ||
        withPrevious.first_turn_fixture_assertion !== true ||
        withPrevious.previous_response_id_present_after !== true ||
        withoutPrevious.account_identity_distinct !== true ||
        withoutPrevious.first_turn_fixture_assertion !== true ||
        withoutPrevious.previous_response_id_present_after !== false
      ) {
        exitCode = 1;
      }
    }
    if (shouldRun("boundaries")) {
      activeStage = "cross_failure_boundaries";
      const boundaries = await runFailureBoundaryScenarios({
        homeA,
        homeB,
        fixtureDirectory,
        crossFallback: true,
      });
      if (
        boundaries.before.account_identity_distinct !== true ||
        boundaries.before.outcome !== "bounded_replay_succeeded"
      ) {
        exitCode = 1;
      }
    }
  }

  activeStage = "complete";
  await emit({ kind: "run_completed", mode, result: exitCode === 0 ? "passed" : "failed" });
} catch (error) {
  exitCode = 1;
  await emit({
    kind: "run_failed",
    mode,
    stage: activeStage,
    category: safeErrorCategory(error),
  });
} finally {
  await summaryPending;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;
