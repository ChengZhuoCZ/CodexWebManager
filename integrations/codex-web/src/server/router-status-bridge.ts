import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ACCOUNT_STATES = new Set([
  "healthy",
  "cooling_down",
  "half_open",
  "auth_expired",
  "quota_exhausted",
  "disabled",
  "unknown",
]);
const SWITCH_REASONS = new Set([
  "manual",
  "startup",
  "quota_exhausted",
  "rate_limited",
  "auth_expired",
  "network_error",
  "upstream_5xx",
]);
const ROUTER_STATUSES = new Set(["ready", "degraded", "unavailable"]);
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_SWITCH_BYTES = 8 * 1024;
const SWITCH_ERRORS = new Set([
  "active_semantic_stream",
  "switch_not_available",
  "switch_rejected",
  "switch_target_mismatch",
  "switch_state_rejected",
]);

type BridgeConfig =
  | { enabled: false }
  | {
      enabled: true;
      adminOrigin: string;
      tokenFile: string;
      credentialsDirectory: string | undefined;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function alias(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    [...value].length < 1 ||
    [...value].length > 64
  ) {
    throw new Error("invalid bridge payload");
  }
  return value;
}

function nullableRatio(value: unknown): number | null {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("invalid bridge payload");
  }
  return value as number | null;
}

function nullableTimestamp(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error("invalid bridge payload");
  }
  return value as string | null;
}

function sanitizeStatus(value: unknown) {
  if (
    !isRecord(value) ||
    !ROUTER_STATUSES.has(String(value.status)) ||
    value.architecture_mode !== "LIMITED_MODE" ||
    value.cross_account_e2e_verified !== false ||
    !Number.isSafeInteger(value.active_streams) ||
    Number(value.active_streams) < 0 ||
    Number(value.active_streams) > 1_000_000 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 1_000
  ) {
    throw new Error("invalid bridge payload");
  }
  const accounts = value.accounts.map((account) => {
    if (
      !isRecord(account) ||
      !ACCOUNT_STATES.has(String(account.state)) ||
      typeof account.enabled !== "boolean" ||
      (account.last_switch_reason !== null &&
        !SWITCH_REASONS.has(String(account.last_switch_reason)))
    ) {
      throw new Error("invalid bridge payload");
    }
    return {
      alias: alias(account.alias),
      state: account.state,
      enabled: account.enabled,
      five_hour_remaining_ratio: nullableRatio(account.five_hour_remaining_ratio),
      weekly_remaining_ratio: nullableRatio(account.weekly_remaining_ratio),
      snapshot_observed_at: nullableTimestamp(account.snapshot_observed_at),
      cooldown_until: nullableTimestamp(account.cooldown_until),
      last_switch_reason: account.last_switch_reason,
    };
  });
  let currentRoute = null;
  if (value.current_route !== null) {
    if (!isRecord(value.current_route) || value.current_route.continuity !== "new_backend_session") {
      throw new Error("invalid bridge payload");
    }
    currentRoute = {
      account_alias: alias(value.current_route.account_alias),
      continuity: "new_backend_session",
    };
  }
  return {
    status: value.status,
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: value.active_streams,
    current_route: currentRoute,
    accounts,
  };
}

function sanitizeSwitchEvent(id: string, type: string, value: unknown) {
  if (
    !CURSOR_PATTERN.test(id) ||
    type !== "router.switch" ||
    !isRecord(value) ||
    (value.from_alias !== null && typeof value.from_alias !== "string") ||
    !SWITCH_REASONS.has(String(value.reason)) ||
    value.continuity !== "new_backend_session" ||
    value.architecture_mode !== "LIMITED_MODE" ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp))
  ) {
    throw new Error("invalid bridge event");
  }
  return {
    id,
    type: "router.switch",
    data: {
      from_alias: value.from_alias === null ? null : alias(value.from_alias),
      to_alias: alias(value.to_alias),
      reason: value.reason,
      continuity: "new_backend_session",
      architecture_mode: "LIMITED_MODE",
      timestamp: value.timestamp,
    },
  };
}

function loadConfig(environment: NodeJS.ProcessEnv): BridgeConfig {
  const rawOrigin = environment.CODEX_ROUTER_ADMIN_ORIGIN;
  const tokenFile = environment.CODEX_ROUTER_ADMIN_TOKEN_FILE;
  if (rawOrigin === undefined && tokenFile === undefined) {
    return { enabled: false };
  }
  if (rawOrigin === undefined || tokenFile === undefined || !path.isAbsolute(tokenFile)) {
    throw new Error("codex router status bridge configuration is incomplete");
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("codex router status bridge configuration is invalid");
  }
  if (
    origin.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]"]).has(origin.hostname) ||
    origin.port === "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("codex router status bridge configuration is invalid");
  }
  const credentialsDirectory = environment.CREDENTIALS_DIRECTORY;
  if (credentialsDirectory !== undefined) {
    const relative = path.relative("/run/credentials", credentialsDirectory);
    if (
      !path.isAbsolute(credentialsDirectory) ||
      path.dirname(tokenFile) !== credentialsDirectory ||
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      relative.includes(path.sep) ||
      !/^[A-Za-z0-9:_.@-]+\.(?:service|scope)$/.test(relative)
    ) {
      throw new Error("codex router status bridge configuration is invalid");
    }
  }
  return {
    enabled: true,
    adminOrigin: origin.origin,
    tokenFile,
    credentialsDirectory,
  };
}

function assertPrivate(
  stat: Awaited<ReturnType<typeof fs.stat>>,
  systemdCredential: boolean,
  directory: boolean,
): void {
  const ownerIsInvalid = systemdCredential
    ? Number(stat.uid) !== 0
    : typeof process.getuid === "function" && Number(stat.uid) !== process.getuid();
  const forbiddenMode = systemdCredential ? (directory ? 0o027 : 0o337) : 0o077;
  if (ownerIsInvalid || (Number(stat.mode) & forbiddenMode) !== 0) {
    throw new Error("admin token is unavailable");
  }
}

async function withAdminToken<T>(
  tokenFile: string,
  credentialsDirectory: string | undefined,
  callback: (token: string) => Promise<T>,
): Promise<T> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let bytes: Buffer | undefined;
  const systemdCredential = credentialsDirectory !== undefined;
  try {
    const directoryStat = await fs.lstat(path.dirname(tokenFile));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("admin token is unavailable");
    }
    assertPrivate(directoryStat, systemdCredential, true);
    handle = await fs.open(tokenFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 24 || stat.size > 4_096) {
      throw new Error("admin token is unavailable");
    }
    assertPrivate(stat, systemdCredential, false);
    bytes = await handle.readFile();
    const token = bytes.toString("utf8");
    if (token.length < 24 || token.length > 4_096 || !TOKEN_PATTERN.test(token)) {
      throw new Error("admin token is unavailable");
    }
    return await callback(token);
  } catch {
    throw new Error("admin token is unavailable");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

async function boundedText(response: Response, maxBytes = MAX_STATUS_BYTES): Promise<string> {
  if (!response.body) {
    throw new Error("router response is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new Error("router response is too large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function manualSwitchBody(value: unknown): { account_alias: string; reason: "manual" } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "account_alias") ||
    !Object.hasOwn(value, "reason") ||
    value.reason !== "manual"
  ) {
    throw new Error("invalid switch request");
  }
  return { account_alias: alias(value.account_alias), reason: "manual" };
}

async function forwardManualSwitch(
  config: Extract<BridgeConfig, { enabled: true }>,
  requestBody: { account_alias: string; reason: "manual" },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await withAdminToken(config.tokenFile, config.credentialsDirectory, (token) =>
      fetch(`${config.adminOrigin}/v1/switch`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      }),
    );
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error("router switch response is unavailable");
    }
    const body = JSON.parse(await boundedText(response, MAX_SWITCH_BYTES)) as unknown;
    if (response.status === 200) {
      if (
        !isRecord(body) ||
        body.accepted !== true ||
        body.account_alias !== requestBody.account_alias ||
        body.continuity !== "new_backend_session" ||
        body.architecture_mode !== "LIMITED_MODE"
      ) {
        throw new Error("router switch response is invalid");
      }
      return {
        statusCode: 200,
        payload: {
          enabled: true,
          accepted: true,
          account_alias: requestBody.account_alias,
          continuity: "new_backend_session",
          architecture_mode: "LIMITED_MODE",
        },
      };
    }
    if (
      response.status === 409 &&
      isRecord(body) &&
      typeof body.error === "string" &&
      SWITCH_ERRORS.has(body.error)
    ) {
      return { statusCode: 409, payload: { enabled: true, error: body.error } };
    }
    throw new Error("router switch response is unavailable");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStatus(config: Extract<BridgeConfig, { enabled: true }>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await withAdminToken(config.tokenFile, config.credentialsDirectory, (token) =>
      fetch(`${config.adminOrigin}/v1/status`, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: controller.signal,
      }),
    );
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      throw new Error("router response is unavailable");
    }
    return sanitizeStatus(JSON.parse(await boundedText(response)));
  } finally {
    clearTimeout(timer);
  }
}

function parseFrame(frame: string) {
  let id: string | null = null;
  let type: string | null = null;
  const data: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") type = value;
    else if (field === "data") data.push(value);
    else throw new Error("unsupported bridge event field");
  }
  if (id === null && type === null && data.length === 0) return null;
  if (id === null || type === null || data.length === 0) throw new Error("incomplete bridge event");
  return sanitizeSwitchEvent(id, type, JSON.parse(data.join("\n")));
}

async function relayEvents(
  response: Response,
  write: (value: string) => void,
): Promise<void> {
  if (!response.body) throw new Error("router events are unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (Buffer.byteLength(frame, "utf8") > MAX_EVENT_BYTES) throw new Error("bridge event is too large");
        const event = parseFrame(frame);
        if (event) {
          write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) throw new Error("bridge event is too large");
    }
    if (buffer.trim() !== "") throw new Error("unterminated bridge event");
  } finally {
    reader.releaseLock();
  }
}

export async function registerRouterStatusBridge(
  app: FastifyInstance,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const config = loadConfig(environment);

  app.get(STATUS_PATH, async (_request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    try {
      return reply.send({ enabled: true, router: await fetchStatus(config) });
    } catch {
      return reply.code(502).send({ enabled: true, error: "router_status_unavailable" });
    }
  });

  app.get(EVENTS_PATH, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    const cursor = request.headers["last-event-id"] ?? "0";
    if (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor)) {
      return reply.code(400).send({ enabled: true, error: "invalid_event_cursor" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref();
    const cancel = () => controller.abort();
    request.raw.once("aborted", cancel);
    reply.raw.once("close", cancel);
    try {
      const response = await withAdminToken(config.tokenFile, config.credentialsDirectory, (token) =>
        fetch(`${config.adminOrigin}/v1/events`, {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
            "last-event-id": cursor,
          },
          signal: controller.signal,
        }),
      );
      clearTimeout(timer);
      if (
        response.status !== 200 ||
        !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
      ) {
        throw new Error("router events are unavailable");
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      reply.raw.write(": connected\n\n");
      await relayEvents(response, (value) => reply.raw.write(value));
      reply.raw.end();
      return reply;
    } catch {
      if (!reply.sent) {
        return reply.code(502).send({ enabled: true, error: "router_events_unavailable" });
      }
      reply.raw.destroy();
      return reply;
    } finally {
      clearTimeout(timer);
      request.raw.off("aborted", cancel);
      reply.raw.off("close", cancel);
    }
  });

  app.post(SWITCH_PATH, { bodyLimit: 4 * 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    let body;
    try {
      body = manualSwitchBody(request.body);
    } catch {
      return reply.code(400).send({ enabled: true, error: "invalid_switch_request" });
    }
    try {
      const result = await forwardManualSwitch(config, body);
      return reply.code(result.statusCode).send(result.payload);
    } catch {
      return reply.code(502).send({ enabled: true, error: "router_switch_unavailable" });
    }
  });
}
