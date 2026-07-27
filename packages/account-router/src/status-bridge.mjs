import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { SecretLease } from "./secrets.mjs";

const ACCOUNT_STATES = new Set([
  "healthy",
  "cooling_down",
  "half_open",
  "auth_expired",
  "quota_exhausted",
  "disabled",
  "unknown",
]);
const ROUTER_STATUSES = new Set(["ready", "degraded", "unavailable"]);
const SWITCH_REASONS = new Set([
  "manual",
  "startup",
  "quota_exhausted",
  "rate_limited",
  "auth_expired",
  "network_error",
  "upstream_5xx",
]);
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const ALIAS_MAX_LENGTH = 64;

export class StatusBridgeError extends Error {
  constructor(code) {
    super(code);
    this.name = "StatusBridgeError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAlias(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    [...value].length < 1 ||
    [...value].length > ALIAS_MAX_LENGTH
  ) {
    throw new Error("invalid alias");
  }
  return value;
}

function assertNullableRatio(value) {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("invalid ratio");
  }
  return value;
}

function assertNullableTimestamp(value) {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error("invalid timestamp");
  }
  return value;
}

function sanitizeAccount(value) {
  if (!isPlainObject(value)) {
    throw new Error("invalid account status");
  }
  const alias = assertAlias(value.alias);
  if (!ACCOUNT_STATES.has(value.state) || typeof value.enabled !== "boolean") {
    throw new Error("invalid account status");
  }
  if (value.last_switch_reason !== null && !SWITCH_REASONS.has(value.last_switch_reason)) {
    throw new Error("invalid account status");
  }
  return Object.freeze({
    alias,
    state: value.state,
    enabled: value.enabled,
    five_hour_remaining_ratio: assertNullableRatio(value.five_hour_remaining_ratio),
    weekly_remaining_ratio: assertNullableRatio(value.weekly_remaining_ratio),
    snapshot_observed_at: assertNullableTimestamp(value.snapshot_observed_at),
    cooldown_until: assertNullableTimestamp(value.cooldown_until),
    last_switch_reason: value.last_switch_reason,
  });
}

function sanitizeCurrentRoute(value) {
  if (value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    value.continuity !== "new_backend_session"
  ) {
    throw new Error("invalid current route");
  }
  return Object.freeze({
    account_alias: assertAlias(value.account_alias),
    continuity: "new_backend_session",
  });
}

export function sanitizeRouterStatus(value) {
  if (
    !isPlainObject(value) ||
    !ROUTER_STATUSES.has(value.status) ||
    value.architecture_mode !== "LIMITED_MODE" ||
    value.cross_account_e2e_verified !== false ||
    !Number.isSafeInteger(value.active_streams) ||
    value.active_streams < 0 ||
    value.active_streams > 1_000_000 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 1_000
  ) {
    throw new Error("invalid router status");
  }
  return Object.freeze({
    status: value.status,
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: value.active_streams,
    current_route: sanitizeCurrentRoute(value.current_route),
    accounts: Object.freeze(value.accounts.map(sanitizeAccount)),
  });
}

export function sanitizeRouterSwitchEvent(value) {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    !CURSOR_PATTERN.test(value.id) ||
    value.type !== "router.switch" ||
    !isPlainObject(value.data)
  ) {
    throw new Error("invalid router switch event");
  }
  const data = value.data;
  let fromAlias = null;
  if (data.from_alias !== null) {
    fromAlias = assertAlias(data.from_alias);
  }
  if (
    !SWITCH_REASONS.has(data.reason) ||
    data.continuity !== "new_backend_session" ||
    data.architecture_mode !== "LIMITED_MODE" ||
    typeof data.timestamp !== "string" ||
    Number.isNaN(Date.parse(data.timestamp))
  ) {
    throw new Error("invalid router switch event");
  }
  const sanitizedData = Object.freeze({
    from_alias: fromAlias,
    to_alias: assertAlias(data.to_alias),
    reason: data.reason,
    continuity: "new_backend_session",
    architecture_mode: "LIMITED_MODE",
    timestamp: data.timestamp,
  });
  return Object.freeze({ id: value.id, type: "router.switch", data: sanitizedData });
}

function validateAdminOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("status bridge configuration is invalid");
  }
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]"]).has(url.hostname) ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("status bridge configuration is invalid");
  }
  return url.origin;
}

function assertBoundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertToken(token) {
  if (
    typeof token !== "string" ||
    token.length < 24 ||
    token.length > 4_096 ||
    !TOKEN_PATTERN.test(token)
  ) {
    throw new Error("admin token is invalid");
  }
  return token;
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) {
    throw new Error("response body is unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("response body is too large");
      }
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

function requestSignal(timeoutMs, outerSignal = undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request deadline exceeded")), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(outerSignal.reason);
  if (outerSignal) {
    if (outerSignal.aborted) {
      onAbort();
    } else {
      outerSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    connected() {
      clearTimeout(timer);
    },
    cleanup() {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

async function consumeEventStream(response, { maxEventBytes, onEvent }) {
  if (!response.body) {
    throw new Error("event body is unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";

  const dispatch = (frame) => {
    let id = null;
    let type = null;
    const data = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "" || line.startsWith(":")) {
        continue;
      }
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "id") {
        id = value;
      } else if (field === "event") {
        type = value;
      } else if (field === "data") {
        data.push(value);
      } else {
        throw new Error("unsupported event field");
      }
    }
    if (id === null && type === null && data.length === 0) {
      return;
    }
    if (id === null || type === null || data.length === 0) {
      throw new Error("incomplete event");
    }
    const parsed = JSON.parse(data.join("\n"));
    onEvent(sanitizeRouterSwitchEvent({ id, type, data: parsed }));
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (Buffer.byteLength(frame, "utf8") > maxEventBytes) {
          throw new Error("event frame is too large");
        }
        dispatch(frame);
      }
      if (Buffer.byteLength(buffer, "utf8") > maxEventBytes) {
        throw new Error("event frame is too large");
      }
    }
    if (buffer.trim() !== "") {
      throw new Error("unterminated event frame");
    }
  } finally {
    reader.releaseLock();
  }
}

export function createStatusBridge({
  adminOrigin = null,
  withAdminToken = null,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 3_000,
  maxStatusBytes = 64 * 1024,
  maxEventBytes = 16 * 1024,
} = {}) {
  const configuredOrigin = adminOrigin !== null;
  const configuredToken = withAdminToken !== null;
  if (configuredOrigin !== configuredToken) {
    throw new Error("status bridge configuration is incomplete");
  }
  if (configuredToken && typeof withAdminToken !== "function") {
    throw new Error("status bridge configuration is invalid");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("status bridge fetch implementation is invalid");
  }
  const timeout = assertBoundedInteger(requestTimeoutMs, "status bridge request timeout", 10, 30_000);
  const statusLimit = assertBoundedInteger(maxStatusBytes, "status bridge status limit", 256, 1024 * 1024);
  const eventLimit = assertBoundedInteger(maxEventBytes, "status bridge event limit", 256, 1024 * 1024);
  const origin = configuredOrigin ? validateAdminOrigin(adminOrigin) : null;

  if (origin === null) {
    return Object.freeze({
      enabled: false,
      async getStatus() {
        return Object.freeze({ enabled: false });
      },
      async followEvents({ afterId = "0", onEvent } = {}) {
        if (typeof afterId !== "string" || !CURSOR_PATTERN.test(afterId)) {
          throw new StatusBridgeError("invalid_event_cursor");
        }
        if (typeof onEvent !== "function") {
          throw new StatusBridgeError("invalid_event_consumer");
        }
        throw new StatusBridgeError("bridge_disabled");
      },
    });
  }

  return Object.freeze({
    enabled: true,
    async getStatus() {
      const request = requestSignal(timeout);
      try {
        const response = await withAdminToken(async (rawToken) => {
          const token = assertToken(rawToken);
          return fetchImpl(`${origin}/v1/status`, {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
            },
            signal: request.signal,
          });
        });
        if (
          !(response instanceof Response) ||
          response.status !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
        ) {
          throw new Error("invalid status response");
        }
        const payload = JSON.parse(await readBoundedBody(response, statusLimit));
        return Object.freeze({ enabled: true, router: sanitizeRouterStatus(payload) });
      } catch {
        throw new StatusBridgeError("router_status_unavailable");
      } finally {
        request.cleanup();
      }
    },
    async followEvents({ afterId = "0", onEvent, signal = undefined } = {}) {
      if (typeof afterId !== "string" || !CURSOR_PATTERN.test(afterId)) {
        throw new StatusBridgeError("invalid_event_cursor");
      }
      if (typeof onEvent !== "function") {
        throw new StatusBridgeError("invalid_event_consumer");
      }
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new StatusBridgeError("invalid_abort_signal");
      }
      const request = requestSignal(timeout, signal);
      try {
        const response = await withAdminToken(async (rawToken) => {
          const token = assertToken(rawToken);
          return fetchImpl(`${origin}/v1/events`, {
            method: "GET",
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${token}`,
              "last-event-id": afterId,
            },
            signal: request.signal,
          });
        });
        request.connected();
        if (
          !(response instanceof Response) ||
          response.status !== 200 ||
          !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
        ) {
          throw new Error("invalid event response");
        }
        await consumeEventStream(response, { maxEventBytes: eventLimit, onEvent });
      } catch {
        throw new StatusBridgeError("router_events_unavailable");
      } finally {
        request.cleanup();
      }
    },
  });
}

function isSystemdCredentialDirectory(directory) {
  const relative = path.relative("/run/credentials", directory);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    !relative.includes(path.sep) &&
    /^[A-Za-z0-9:_.@-]+\.(?:service|scope)$/.test(relative)
  );
}

function assertPrivateStat(stat, label, systemdCredential, directory) {
  if (systemdCredential) {
    if (stat.uid !== 0) {
      throw new Error(`${label} owner is invalid`);
    }
    const forbiddenMode = directory ? 0o027 : 0o337;
    if ((stat.mode & forbiddenMode) !== 0) {
      throw new Error(`${label} permissions are invalid`);
    }
    return;
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} owner is invalid`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are invalid`);
  }
}

export function createPrivateFileTokenConsumer({
  tokenFile,
  credentialsDirectory,
  maxBytes = 4_096,
} = {}) {
  if (typeof tokenFile !== "string" || !path.isAbsolute(tokenFile)) {
    throw new Error("admin token file configuration is invalid");
  }
  const limit = assertBoundedInteger(maxBytes, "admin token file limit", 24, 4_096);
  const parentDirectory = path.dirname(tokenFile);
  const systemdCredential = credentialsDirectory !== undefined;
  if (
    systemdCredential &&
    (credentialsDirectory !== parentDirectory ||
      !isSystemdCredentialDirectory(credentialsDirectory))
  ) {
    throw new Error("admin token file configuration is invalid");
  }

  return async (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("admin token callback must be a function");
    }
    let handle;
    try {
      const directoryStat = await fs.lstat(parentDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("invalid token directory");
      }
      assertPrivateStat(directoryStat, "admin token directory", systemdCredential, true);
      handle = await fs.open(tokenFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 24 || stat.size > limit) {
        throw new Error("invalid token file");
      }
      assertPrivateStat(stat, "admin token file", systemdCredential, false);
      const bytes = await handle.readFile();
      if (bytes.length < 24 || bytes.length > limit) {
        bytes.fill(0);
        throw new Error("invalid token file");
      }
      const lease = new SecretLease(bytes);
      bytes.fill(0);
      try {
        return await lease.use(async (token) => callback(assertToken(token)));
      } finally {
        lease.dispose();
      }
    } catch {
      throw new Error("admin token is unavailable");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
}
