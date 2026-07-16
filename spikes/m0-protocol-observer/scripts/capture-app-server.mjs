import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createObserver } from "../src/observer.mjs";

const codexPath = process.env.CODEX_PATH ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const observationLog = process.env.OBSERVATION_LOG;
const upstreamOrigin = process.env.UPSTREAM_ORIGIN ?? "https://chatgpt.com";
const timeoutMs = Number.parseInt(process.env.CAPTURE_TIMEOUT_MS ?? "180000", 10);

if (!observationLog || !Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
  process.stderr.write("OBSERVATION_LOG and a valid CAPTURE_TIMEOUT_MS are required\n");
  process.exit(2);
}

const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "m0-app-server-fixture-"));
await fs.writeFile(
  path.join(fixtureDirectory, "README.md"),
  "# Protocol fixture workspace\n\nThis workspace exists only for the M0.2 protocol-shape capture.\n",
  { mode: 0o600 },
);

const observer = await createObserver({
  upstreamOrigin,
  logPath: observationLog,
  port: 0,
});

const proxyBaseUrl = `http://127.0.0.1:${observer.address.port}/backend-api/codex`;
const child = spawn(
  codexPath,
  [
    "app-server",
    "--stdio",
    "-c",
    `openai_base_url=${JSON.stringify(proxyBaseUrl)}`,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'web_search="live"',
  ],
  {
    cwd: fixtureDirectory,
    env: {
      ...process.env,
      NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
      no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let nextId = 0;
let stderrLineCount = 0;
let settled = false;
const observedItemTypes = new Set();
const pendingRequests = new Map();
const notificationWaiters = new Map();

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrLineCount += chunk.split("\n").filter(Boolean).length;
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => {
    pendingRequests.set(id, { method, resolve, reject });
  });
  send({ method, id, params });
  return withTimeout(result, method);
}

function waitForNotification(method) {
  const result = new Promise((resolve) => {
    const waiters = notificationWaiters.get(method) ?? [];
    waiters.push(resolve);
    notificationWaiters.set(method, waiters);
  });
  return withTimeout(result, method);
}

function waitForAnyNotification(methods) {
  let waiter;
  const result = new Promise((resolve) => {
    waiter = { methods, resolve };
    for (const method of methods) {
      const waiters = notificationWaiters.get(method) ?? [];
      waiters.push(waiter);
      notificationWaiters.set(method, waiters);
    }
  });

  return withTimeout(result, methods.join(" or ")).finally(() => {
    for (const method of methods) {
      const waiters = notificationWaiters.get(method) ?? [];
      notificationWaiters.set(
        method,
        waiters.filter((candidate) => candidate !== waiter),
      );
    }
  });
}

function resolveNotification(method, message) {
  const waiters = notificationWaiters.get(method);
  if (!waiters?.length) {
    return;
  }
  const candidate = waiters.shift();
  if (typeof candidate === "function") {
    candidate(message);
  } else {
    for (const candidateMethod of candidate.methods) {
      const candidates = notificationWaiters.get(candidateMethod) ?? [];
      notificationWaiters.set(
        candidateMethod,
        candidates.filter((item) => item !== candidate),
      );
    }
    candidate.resolve({ method, message });
  }
}

function classifyErrorNotification(params) {
  const text = JSON.stringify(params ?? {}).toLowerCase();
  if (text.includes("api key") || text.includes("api_key")) {
    return "api_key";
  }
  if (text.includes("auth") || text.includes("login") || text.includes("credential")) {
    return "authentication";
  }
  if (text.includes("provider") || text.includes("config")) {
    return "provider_configuration";
  }
  if (text.includes("rate") || text.includes("quota") || text.includes("limit")) {
    return "rate_or_quota";
  }
  if (text.includes("connect") || text.includes("network") || text.includes("dns")) {
    return "network";
  }
  if (text.includes("model")) {
    return "model";
  }
  return "other";
}

function describeCodexError(params) {
  const info = params?.error?.codexErrorInfo;
  let codexErrorInfo = null;
  let httpStatusCode = null;

  if (typeof info === "string") {
    codexErrorInfo = info;
  } else if (info && typeof info === "object") {
    const variant = Object.keys(info)[0];
    if (typeof variant === "string") {
      codexErrorInfo = variant;
      const status = info[variant]?.httpStatusCode;
      if (Number.isInteger(status)) {
        httpStatusCode = status;
      }
    }
  }

  return {
    error_category: classifyErrorNotification(params),
    codex_error_info: codexErrorInfo,
    http_status_code: httpStatusCode,
    will_retry: params?.willRetry === true,
  };
}

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    emit({ kind: "app_server_non_json_line", redacted: true });
    return;
  }

  if (message.id !== undefined) {
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      emit({ kind: "app_server_response", method: "unknown", status: "unmatched" });
      return;
    }
    pendingRequests.delete(message.id);
    if (message.error) {
      emit({ kind: "app_server_response", method: pending.method, status: "error" });
      pending.reject(new Error(`${pending.method} returned an app-server error`));
    } else {
      emit({ kind: "app_server_response", method: pending.method, status: "ok" });
      pending.resolve(message.result);
    }
    return;
  }

  if (typeof message.method === "string") {
    const itemType = message.params?.item?.type;
    if (typeof itemType === "string" && /^[A-Za-z0-9._/-]{1,64}$/.test(itemType)) {
      observedItemTypes.add(itemType);
    }
    emit({
      kind: "app_server_notification",
      method: message.method,
      ...(typeof itemType === "string" && /^[A-Za-z0-9._/-]{1,64}$/.test(itemType)
        ? { item_type: itemType }
        : {}),
      ...(message.method === "error"
        ? describeCodexError(message.params)
        : {}),
    });
    resolveNotification(message.method, message);
  }
});

const childExit = new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    if (!settled) {
      for (const pending of pendingRequests.values()) {
        pending.reject(new Error("app-server exited before completing the capture"));
      }
    }
    resolve({ code, signal });
  });
});

try {
  await request("initialize", {
    clientInfo: {
      name: "m0_protocol_observer",
      title: "M0 Protocol Observer",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });

  const modelList = await request("model/list", { limit: 20, includeHidden: false });
  const selectedModel = modelList?.data?.find((entry) => entry?.isDefault) ?? modelList?.data?.[0];
  if (typeof selectedModel?.model !== "string" && typeof selectedModel?.id !== "string") {
    throw new Error("model/list did not return a usable model");
  }
  const threadStart = await request("thread/start", {
    cwd: fixtureDirectory,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    baseInstructions:
      "This is a protocol fixture. Reply only with protocol-fixture-ok and do not use tools.",
    developerInstructions: "Do not inspect files, call tools, or include environment information.",
    model: selectedModel.model ?? selectedModel.id,
  });

  const threadId = threadStart?.thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("thread/start did not return a thread id");
  }

  const firstTurnCompleted = waitForNotification("turn/completed");
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply exactly: protocol-fixture-ok" }],
  });
  await firstTurnCompleted;

  const compacted = waitForAnyNotification(["thread/compacted", "turn/completed"]);
  await request("thread/compact/start", { threadId });
  await compacted;

  const searchThreadStart = await request("thread/start", {
    cwd: fixtureDirectory,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    baseInstructions:
      "This is a protocol fixture. Use only the built-in web search tool when explicitly requested; do not inspect local files or use shell tools.",
    developerInstructions: "Return only the requested public page title and no other content.",
    model: selectedModel.model ?? selectedModel.id,
    config: { web_search: "live" },
  });
  const searchThreadId = searchThreadStart?.thread?.id;
  if (typeof searchThreadId !== "string") {
    throw new Error("search thread/start did not return a thread id");
  }
  const searchTurnCompleted = waitForNotification("turn/completed");
  await request("turn/start", {
    threadId: searchThreadId,
    input: [
      {
        type: "text",
        text: "Use web search to find the current title of https://openai.com and reply with the title only.",
      },
    ],
  });
  await searchTurnCompleted;

  await observer.flush();
  const records = (await fs.readFile(observationLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const protocolRequests = records.filter((record) =>
    new Set(["request_shape", "websocket_upgrade_request"]).has(record.kind),
  );
  const requestPaths = [...new Set(protocolRequests.map((record) => record.path))].sort();
  const eventTypes = [
    ...new Set(
      records
        .filter((record) => new Set(["sse_event", "websocket_event"]).has(record.kind))
        .map((record) => record.event_type),
    ),
  ].sort();
  const websocketMessages = records.filter((record) => record.kind === "websocket_message_shape");

  if (!requestPaths.some((requestPath) => requestPath.endsWith("/responses"))) {
    throw new Error("capture did not observe a Responses request");
  }

  emit({
    kind: "capture_summary",
    request_count: protocolRequests.length,
    request_paths: requestPaths,
    protocol_event_types: eventTypes,
    app_server_item_types: [...observedItemTypes].sort(),
    previous_response_id_field_observed: websocketMessages.some((record) =>
      record.body?.fields?.some((field) => field.path === "$.previous_response_id"),
    ),
    websocket_response_create_count: websocketMessages.filter(
      (record) => record.message_type === "response.create",
    ).length,
    app_server_stderr_line_count: stderrLineCount,
  });
  settled = true;
} catch (error) {
  emit({ kind: "capture_failed", error: error instanceof Error ? error.message : "unknown" });
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await Promise.race([
    childExit,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await childExit;
  }
  await observer.close();
  await fs.rm(fixtureDirectory, { recursive: true, force: true });
}
