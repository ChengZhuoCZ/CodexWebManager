import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const QUOTA_REFRESH_PATH = "/__backend/codex-router/quota-refresh";
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
const MAX_APP_SERVER_BYTES = 64 * 1024;

type BridgeConfig =
  | { enabled: false }
  | {
      enabled: true;
      adminOrigin: string;
      tokenFile: string;
      credentialsDirectory: string | undefined;
      managerSocket: string | undefined;
      restartWebAfterSwitch: boolean;
    };

type QuotaRefreshConfig =
  | { enabled: false }
  | { enabled: true; socketPath: string };

type WeeklyQuotaSnapshot = {
  accountAlias: string;
  weeklyRemainingRatio: number;
  weeklyResetsAt: string | null;
  observedAt: string;
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
    !Number.isSafeInteger(value.active_requests) ||
    Number(value.active_requests) < 0 ||
    Number(value.active_requests) > 1_000_000 ||
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
      weekly_resets_at: account.weekly_resets_at === undefined
        ? null
        : nullableTimestamp(account.weekly_resets_at),
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
    active_requests: value.active_requests,
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
  const managerSocket = environment.CODEX_ROUTER_ACCOUNT_MANAGER_SOCKET;
  if (
    managerSocket !== undefined &&
    managerSocket !== "/run/codex-router-account-manager.sock"
  ) throw new Error("codex router status bridge configuration is invalid");
  const restartWeb = environment.CODEX_ROUTER_RESTART_WEB_AFTER_SWITCH;
  if (restartWeb !== undefined && restartWeb !== "1") {
    throw new Error("codex router status bridge configuration is invalid");
  }
  return {
    enabled: true,
    adminOrigin: origin.origin,
    tokenFile,
    credentialsDirectory,
    managerSocket: managerSocket === undefined ? undefined : path.normalize(managerSocket),
    restartWebAfterSwitch: restartWeb === "1",
  };
}

function loadQuotaRefreshConfig(environment: NodeJS.ProcessEnv): QuotaRefreshConfig {
  const socketPath = environment.CODEX_UNIX_SOCKET;
  const accountAlias = environment.CODEX_ROUTER_QUOTA_ACCOUNT_ALIAS;
  if (accountAlias === undefined) return { enabled: false };
  alias(accountAlias);
  if (
    socketPath === undefined ||
    !path.isAbsolute(socketPath) ||
    !socketPath.startsWith(`/run${path.sep}`) ||
    !socketPath.endsWith(".sock") ||
    socketPath.includes("\0") ||
    socketPath.includes("\n") ||
    socketPath.length > 160
  ) {
    throw new Error("codex router quota refresh configuration is invalid");
  }
  return {
    enabled: true,
    socketPath: path.normalize(socketPath),
  };
}

function mergeWeeklyQuotaSnapshot(
  status: ReturnType<typeof sanitizeStatus>,
  snapshot: WeeklyQuotaSnapshot | null,
): ReturnType<typeof sanitizeStatus> {
  const currentAlias = status.current_route?.account_alias ?? null;
  const accounts = status.accounts.map((account) => {
    if (snapshot === null || account.alias !== snapshot.accountAlias) {
      if (account.alias !== currentAlias) return account;
      return {
        ...account,
        weekly_remaining_ratio: null,
        weekly_resets_at: null,
        snapshot_observed_at: null,
      };
    }
    const routerObservedAt = account.snapshot_observed_at === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(account.snapshot_observed_at);
    if (routerObservedAt > Date.parse(snapshot.observedAt)) return account;
    return {
      ...account,
      weekly_remaining_ratio: snapshot.weeklyRemainingRatio,
      weekly_resets_at: snapshot.weeklyResetsAt,
      snapshot_observed_at: snapshot.observedAt,
    };
  });
  return { ...status, accounts };
}

function assertPrivate(
  stat: Stats,
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

function managerRequest(
  socketPath: string,
  value: Record<string, unknown>,
  timeoutMs = 125_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let length = 0;
    const chunks: Buffer[] = [];
    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== null || result === undefined) reject(error ?? new Error("account manager failed"));
      else resolve(result);
    };
    const socket = net.createConnection(socketPath);
    socket.setTimeout(timeoutMs, () => finish(new Error("account manager timed out")));
    socket.once("error", () => finish(new Error("account manager failed")));
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_SWITCH_BYTES) {
        finish(new Error("account manager failed"));
        return;
      }
      chunks.push(bytes);
    });
    socket.once("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isRecord(body)) throw new Error("account manager failed");
        finish(null, body);
      } catch {
        finish(new Error("account manager failed"));
      }
    });
  });
}

export async function forwardManualSwitch(
  config: Extract<BridgeConfig, { enabled: true }>,
  requestBody: { account_alias: string; reason: "manual" },
) {
  if (config.managerSocket === undefined) throw new Error("account manager is unavailable");
  const body = await managerRequest(config.managerSocket, {
    operation: "switch",
    alias: requestBody.account_alias,
  });
  if (body.ok === false && body.error === "account_operation_failed") {
    return { statusCode: 409, payload: { enabled: true, error: "switch_rejected" } };
  }
  if (
    body.ok !== true || body.event !== "router_account_switched" ||
    body.credentials_exposed !== false || !Number.isSafeInteger(body.configured_accounts) ||
    body.account_alias !== requestBody.account_alias || body.continuity !== "new_backend_session" ||
    body.architecture_mode !== "LIMITED_MODE" || body.native_identity_rebound !== true ||
    body.web_restart_required !== true
  ) throw new Error("router switch response is invalid");
  return {
    statusCode: 200,
    payload: {
      enabled: true,
      accepted: true,
      account_alias: requestBody.account_alias,
      continuity: "new_backend_session",
      architecture_mode: "LIMITED_MODE",
      native_identity_rebound: true,
      web_restart_required: true,
    },
  };
}

function weeklyQuotaSnapshotFromResult(
  value: unknown,
  accountAlias: string,
  observedAt: string,
): WeeklyQuotaSnapshot {
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    throw new Error("weekly quota is unavailable");
  }
  const windows = [value.rateLimits.primary, value.rateLimits.secondary];
  const weekly = windows.find(
    (candidate) =>
      isRecord(candidate) &&
      (candidate.windowDurationMins === 10_079 || candidate.windowDurationMins === 10_080),
  );
  if (
    !isRecord(weekly) ||
    typeof weekly.usedPercent !== "number" ||
    !Number.isFinite(weekly.usedPercent) ||
    weekly.usedPercent < 0 ||
    weekly.usedPercent > 100 ||
    Number.isNaN(Date.parse(observedAt))
  ) {
    throw new Error("weekly quota is unavailable");
  }
  let weeklyResetsAt: string | null = null;
  if (weekly.resetsAt !== null && weekly.resetsAt !== undefined) {
    if (
      typeof weekly.resetsAt !== "number" ||
      !Number.isSafeInteger(weekly.resetsAt) ||
      weekly.resetsAt < 0 ||
      weekly.resetsAt > 4_102_444_800
    ) {
      throw new Error("weekly quota is unavailable");
    }
    weeklyResetsAt = new Date(weekly.resetsAt * 1000).toISOString();
  }
  return {
    accountAlias,
    weeklyRemainingRatio: Math.max(0, Math.min(1, (100 - weekly.usedPercent) / 100)),
    weeklyResetsAt,
    observedAt,
  };
}

async function readWeeklyQuotaSnapshot(
  config: Extract<QuotaRefreshConfig, { enabled: true }>,
  accountAlias: string,
): Promise<WeeklyQuotaSnapshot> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let initialized = false;
    const finish = (error: Error | null, value?: WeeklyQuotaSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (error !== null || value === undefined) reject(error ?? new Error("weekly quota is unavailable"));
      else resolve(value);
    };
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => net.createConnection(config.socketPath),
      maxPayload: MAX_APP_SERVER_BYTES,
      perMessageDeflate: false,
    });
    const timer = setTimeout(
      () => finish(new Error("weekly quota request timed out")),
      REQUEST_TIMEOUT_MS,
    );
    timer.unref();
    socket.once("error", () => finish(new Error("weekly quota is unavailable")));
    socket.once("close", () => finish(new Error("weekly quota is unavailable")));
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex_web_quota_refresh",
            title: "Codex Web quota refresh",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      }));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data.toString(), "utf8") > MAX_APP_SERVER_BYTES) {
        finish(new Error("weekly quota is unavailable"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString()) as unknown;
      } catch {
        finish(new Error("weekly quota is unavailable"));
        return;
      }
      if (!isRecord(message) || (message.id !== 1 && message.id !== 2)) return;
      if (Object.hasOwn(message, "error")) {
        finish(new Error("weekly quota is unavailable"));
        return;
      }
      if (message.id === 1 && !initialized) {
        initialized = true;
        socket.send(JSON.stringify({ method: "initialized", params: {} }));
        socket.send(JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} }));
        return;
      }
      if (message.id === 2) {
        try {
          finish(
            null,
            weeklyQuotaSnapshotFromResult(
              message.result,
              accountAlias,
              new Date().toISOString(),
            ),
          );
        } catch {
          finish(new Error("weekly quota is unavailable"));
        }
      }
    });
  });
}

async function currentQuotaIdentity(
  config: Extract<BridgeConfig, { enabled: true }>,
): Promise<string> {
  if (config.managerSocket === undefined) throw new Error("weekly quota is unavailable");
  const [status, manager] = await Promise.all([
    fetchStatus(config),
    managerRequest(config.managerSocket, { operation: "observe" }, REQUEST_TIMEOUT_MS),
  ]);
  if (
    status.status !== "ready" || status.active_requests !== 0 || status.active_streams !== 0 ||
    status.current_route === null || manager.ok !== true ||
    manager.event !== "router_account_observer_ready" ||
    manager.credentials_exposed !== false ||
    !Number.isSafeInteger(manager.configured_accounts) ||
    Number(manager.configured_accounts) < 1 || Number(manager.configured_accounts) > 1_000
  ) {
    throw new Error("weekly quota is unavailable");
  }
  const identityAlias = alias(manager.account_alias);
  if (identityAlias !== status.current_route.account_alias) {
    throw new Error("weekly quota is unavailable");
  }
  return identityAlias;
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
  const quotaRefreshConfig = loadQuotaRefreshConfig(environment);
  let quotaSnapshot: WeeklyQuotaSnapshot | null = null;
  if (config.enabled && config.managerSocket !== undefined) {
    void managerRequest(config.managerSocket, { operation: "observe" }).catch(() => undefined);
  }

  app.get(STATUS_PATH, async (_request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled) return reply.code(404).send({ enabled: false });
    try {
      return reply.send({
        enabled: true,
        router: mergeWeeklyQuotaSnapshot(await fetchStatus(config), quotaSnapshot),
      });
    } catch {
      return reply.code(502).send({ enabled: true, error: "router_status_unavailable" });
    }
  });

  app.post(QUOTA_REFRESH_PATH, { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    if (!config.enabled || !quotaRefreshConfig.enabled) {
      return reply.code(404).send({ enabled: false });
    }
    if (!isRecord(request.body) || Object.keys(request.body).length !== 0) {
      return reply.code(400).send({ enabled: true, error: "invalid_quota_refresh_request" });
    }
    try {
      const identityBefore = await currentQuotaIdentity(config);
      const candidate = await readWeeklyQuotaSnapshot(quotaRefreshConfig, identityBefore);
      const identityAfter = await currentQuotaIdentity(config);
      if (identityAfter !== identityBefore) throw new Error("weekly quota is unavailable");
      quotaSnapshot = candidate;
      return reply.send({
        enabled: true,
        refreshed: true,
        account_alias: quotaSnapshot.accountAlias,
        weekly_remaining_ratio: quotaSnapshot.weeklyRemainingRatio,
        weekly_resets_at: quotaSnapshot.weeklyResetsAt,
        snapshot_observed_at: quotaSnapshot.observedAt,
      });
    } catch {
      return reply.code(502).send({ enabled: true, error: "quota_refresh_unavailable" });
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
      if (config.restartWebAfterSwitch && result.payload.web_restart_required === true) {
        reply.raw.once("finish", () => {
          const timer = setTimeout(() => process.exit(0), 100);
          timer.unref();
        });
      }
      return reply.code(result.statusCode).send(result.payload);
    } catch {
      return reply.code(502).send({ enabled: true, error: "router_switch_unavailable" });
    }
  });
}
