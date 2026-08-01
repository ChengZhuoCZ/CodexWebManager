import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const SESSION_COOKIE_NAME = "codex_web_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const LOGIN_PATH = "/__backend/session/login";
const SESSION_PATH = "/__backend/session";
const HEALTH_PATH = "/__backend/healthz";
const BROWSER_CONFIG_PATH = "/__backend/browser-config";
const STARTUP_PROBE_PATH = "/__backend/startup-probe.js";
const STARTUP_DIAGNOSTIC_PATH = "/__backend/startup-diagnostic";
const MAX_LOGIN_BODY_BYTES = 8 * 1_024;
const MAX_STARTUP_DIAGNOSTIC_BODY_BYTES = 128;
const MAX_FAILED_LOGIN_IPS = 1_024;
const MAX_FAILED_LOGINS_PER_WINDOW = 5;
const FAILED_LOGIN_WINDOW_MS = 60_000;
const MAX_TRUSTED_TAILNET_SESSIONS = 64;
const IPC_SUBPROTOCOL = "codex-ipc.v1";
const INLINE_UUID_SCRIPT_SHA256 =
  "'sha256-Dclel/rGxNWaGiFViYSHBS21+R0OTVg2FgATT6T00nc='";
const ROUTED_INLINE_SCRIPT_SHA256 = [
  "'sha256-JFzyxau0BLv5eiwJiFmkh6tzLMjL1kwn6z7lIuy0XAA='",
  "'sha256-mNtCN1bmWu5o8zc8kEpxzwQtpB4bQ4jUuStyIR1LrEI='",
  "'sha256-px6C9XySPrv19JRhBPxaQkoxemcODcCoV+kMOUtL3/I='",
].join(" ");
const STARTUP_DIAGNOSTIC_CODES = new Set([
  "bridge_missing",
  "bridge_ready",
  "app_main_missing",
  "module_load_error",
  "probe_loaded",
  "react_root_missing",
  "render_wait",
  "resource_load_error",
  "runtime_error",
  "unhandled_rejection",
]);
const STARTUP_PROBE_SOURCE = `(() => {
  "use strict";
  const reported = new Set();
  let failureCode = "";
  const report = async (code) => {
    if (reported.has(code)) return;
    reported.add(code);
    try {
      const session = await fetch("/__backend/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!session.ok) return;
      const body = await session.json();
      if (!body || typeof body.csrfToken !== "string") return;
      await fetch("/__backend/startup-diagnostic", {
        body: JSON.stringify({ code }),
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-codex-csrf": body.csrfToken,
        },
        method: "POST",
      });
    } catch {}
  };
  const fail = (code) => {
    if (failureCode === "") failureCode = code;
    void report(code);
  };
  window.addEventListener("error", (event) => {
    if (event.target === window) {
      fail("runtime_error");
    } else if (event.target instanceof HTMLScriptElement) {
      fail("module_load_error");
    } else {
      fail("resource_load_error");
    }
  }, true);
  window.addEventListener("unhandledrejection", () => {
    fail("unhandled_rejection");
  });
  void report("probe_loaded");
  document.addEventListener("DOMContentLoaded", () => {
    if (typeof globalThis.electronBridge === "object") {
      void report("bridge_ready");
    } else {
      fail("bridge_missing");
    }
  }, { once: true });
  window.setTimeout(() => {
    const loader = document.querySelector(".startup-loader");
    if (loader === null) return;
    const code = failureCode || (
      typeof globalThis.electronBridge !== "object"
        ? "bridge_missing"
        : document.documentElement.dataset.codexWindowType !== "electron"
          ? "app_main_missing"
          : globalThis.__codexRoot == null
            ? "react_root_missing"
            : "render_wait"
    );
    void report(code);
    loader.setAttribute("aria-hidden", "false");
    loader.textContent = "";
    const message = document.createElement("div");
    message.setAttribute("role", "alert");
    message.style.cssText = "max-width:32rem;padding:1.5rem;font:14px/1.5 system-ui,sans-serif;text-align:center;color:CanvasText";
    message.textContent = "8216 启动未完成（diag_v2:" + code + "）。请强制刷新；若仍失败，请把阶段码发给开发任务。";
    loader.append(message);
  }, 20000);
})();
`;

type SessionSocket = {
  close(code?: number, reason?: string | Buffer): void;
};

type Session = {
  csrfToken: string;
  expiryTimer: NodeJS.Timeout | null;
  expiresAt: number;
  id: string;
  responses: Set<ServerResponse>;
  sockets: Set<SessionSocket>;
  startupDiagnostics: Set<string>;
};

type FailedLoginWindow = {
  count: number;
  startedAt: number;
};

export type WebSocketAuthorization =
  | {
      ok: true;
      sessionId: string;
    }
  | {
      ok: false;
      statusCode: 400 | 401 | 403;
    };

export type BrowserSessionAuth = {
  authorizeRendererEvent(message: unknown): boolean;
  authorizeRendererMessage(message: unknown): boolean;
  authorizeWebSocket(request: IncomingMessage): WebSocketAuthorization;
  bindWebSocket(sessionId: string, socket: SessionSocket): () => void;
  limitRemoteHistory: boolean;
  onSessionRevoked(listener: (sessionId: string) => void): () => void;
  publicOrigin: string;
  resolveWorkspaceDirectory(directoryPath: string | null): Promise<string>;
  sessionIdForRequest(request: FastifyRequest): string;
};

type AuthConfig = {
  accessTokenDigest: Buffer | null;
  codexHome: string;
  publicOrigin: URL;
  trustedTailnetAccess: boolean;
  workspaceRoots: string[];
};

const SAFE_ZERO_ARGUMENT_INVOKE_CHANNELS = new Set([
  "codex_desktop:get-build-flavor",
  "codex_desktop:get-sentry-init-options",
  "codex_desktop:get-shared-object-snapshot",
  "codex_desktop:get-system-theme-variant",
  "codex_desktop:get-uses-owl-app-shell",
]);
const GIT_WORKER_INVOKE_CHANNEL = "codex_desktop:worker:git:from-view";
const ALLOWED_GIT_WORKER_METHODS = new Set([
  "invalidate-git-read-caches",
  "recover-live-queries",
  "stable-metadata",
  "subscribe-live-query",
  "unwatch-repo",
  "watch-repo",
]);

const SENSITIVE_OUTPUT_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
]);
const SENSITIVE_OUTPUT_KEY_SUFFIXES = [
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "refreshtoken",
  "secretkey",
  "sessiontoken",
] as const;
const MAX_OUTPUT_STRING_CHARACTERS = 256 * 1024;
const SENSITIVE_OUTPUT_VALUE_PATTERNS = [
  /\bBearer[ \t]+[A-Za-z0-9._~+/-]{12,}={0,2}(?=$|[\s,;)\]}])/iu,
  /(?:^|[\r\n])[ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:[ \t]*\S/iu,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/iu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/u,
  /(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|proxy[_-]?authorization|authorization|set[_-]?cookie|cookie)[ \t]*["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9._~+/-]{8,}={0,2}/iu,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeRequestPath(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function isTailnetIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1]! >= 64 &&
    octets[1]! <= 127
  );
}

function isAllowedPublicHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "localhost" ||
    isTailnetIpv4(hostname)
  );
}

function parsePublicOrigin(rawOrigin: string | undefined): URL {
  if (rawOrigin === undefined) {
    throw new Error("codex web browser authentication configuration is incomplete");
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("codex web browser authentication configuration is invalid");
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    !isAllowedPublicHostname(origin.hostname) ||
    origin.port === "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== rawOrigin
  ) {
    throw new Error("codex web browser authentication configuration is invalid");
  }
  return origin;
}

function parseTrustedTailnetAccess(
  rawValue: string | undefined,
  publicOrigin: URL,
): boolean {
  if (rawValue === undefined || rawValue === "0") {
    return false;
  }
  if (
    rawValue !== "1" ||
    publicOrigin.protocol !== "http:" ||
    !isTailnetIpv4(publicOrigin.hostname)
  ) {
    throw new Error("codex web trusted Tailnet access configuration is invalid");
  }
  return true;
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
    throw new Error("codex web browser access token is unavailable");
  }
}

async function readAccessTokenDigest(
  tokenFile: string,
  credentialsDirectory: string | undefined,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let bytes: Buffer | undefined;
  const systemdCredential = credentialsDirectory !== undefined;
  try {
    const directoryStat = await fs.lstat(path.dirname(tokenFile));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("invalid directory");
    }
    assertPrivate(directoryStat, systemdCredential, true);
    handle = await fs.open(
      tokenFile,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 32 || stat.size > 4_096) {
      throw new Error("invalid token file");
    }
    assertPrivate(stat, systemdCredential, false);
    bytes = await handle.readFile();
    const token = bytes.toString("utf8");
    if (
      token.length < 32 ||
      token.length > 4_096 ||
      !ACCESS_TOKEN_PATTERN.test(token)
    ) {
      throw new Error("invalid token");
    }
    return sha256(bytes);
  } catch {
    throw new Error("codex web browser access token is unavailable");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

async function resolveWorkspaceRoots(
  rawRoots: string | undefined,
): Promise<string[]> {
  if (rawRoots === undefined) {
    throw new Error("codex web workspace roots are unavailable");
  }
  const candidates = rawRoots.split(path.delimiter);
  if (
    candidates.length === 0 ||
    candidates.length > 16 ||
    candidates.some((candidate) => candidate.length === 0 || !path.isAbsolute(candidate))
  ) {
    throw new Error("codex web workspace roots are unavailable");
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("codex web workspace roots are unavailable");
    }
    const resolved = await fs.realpath(candidate);
    if (!roots.includes(resolved)) {
      roots.push(resolved);
    }
  }
  if (roots.length === 0) {
    throw new Error("codex web workspace roots are unavailable");
  }
  return roots;
}

async function resolveCodexHome(rawCodexHome: string | undefined): Promise<string> {
  if (
    rawCodexHome === undefined ||
    !path.isAbsolute(rawCodexHome) ||
    path.resolve(rawCodexHome) !== rawCodexHome ||
    rawCodexHome.length > 4_096
  ) {
    throw new Error("codex web browser authentication configuration is incomplete");
  }
  const stat = await fs.lstat(rawCodexHome);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("codex web codex home is unavailable");
  }
  return fs.realpath(rawCodexHome);
}

async function loadConfig(
  environment: NodeJS.ProcessEnv,
): Promise<AuthConfig> {
  const publicOrigin = parsePublicOrigin(environment.CODEX_WEB_PUBLIC_ORIGIN);
  const trustedTailnetAccess = parseTrustedTailnetAccess(
    environment.CODEX_WEB_TRUSTED_TAILNET_ACCESS,
    publicOrigin,
  );
  let accessTokenDigest: Buffer | null = null;
  if (!trustedTailnetAccess) {
    const tokenFile = environment.CODEX_WEB_ACCESS_TOKEN_FILE;
    if (tokenFile === undefined || !path.isAbsolute(tokenFile)) {
      throw new Error("codex web browser authentication configuration is incomplete");
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
        throw new Error("codex web browser authentication configuration is invalid");
      }
    }
    accessTokenDigest = await readAccessTokenDigest(
      tokenFile,
      credentialsDirectory,
    );
  }
  const [codexHome, workspaceRoots] = await Promise.all([
    resolveCodexHome(environment.CODEX_WEB_CODEX_HOME),
    resolveWorkspaceRoots(environment.CODEX_WEB_WORKSPACE_ROOTS),
  ]);
  return {
    accessTokenDigest,
    codexHome,
    publicOrigin,
    trustedTailnetAccess,
    workspaceRoots,
  };
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (cookieHeader === undefined || cookieHeader.length > 8_192) {
    return null;
  }
  const values: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const candidateName = pair.slice(0, separator).trim();
    if (candidateName === name) {
      values.push(pair.slice(separator + 1).trim());
    }
  }
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) {
    return null;
  }
  return values[0]!;
}

function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function expiredSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function loginPage(failed: boolean): string {
  const error = failed
    ? '<p role="alert">访问密钥无效或尝试过于频繁。</p>'
    : "";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Codex Web 安全登录</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { display:grid; min-height:100vh; margin:0; place-items:center; background:#111; color:#eee; }
      main { width:min(28rem,calc(100% - 2rem)); padding:2rem; border:1px solid #444; border-radius:1rem; background:#1b1b1b; }
      h1 { margin-top:0; font-size:1.35rem; }
      label,input,button { box-sizing:border-box; display:block; width:100%; }
      input,button { margin-top:.6rem; padding:.8rem; border-radius:.55rem; border:1px solid #666; }
      button { cursor:pointer; font-weight:650; }
      p { line-height:1.5; color:#bbb; }
      [role=alert] { color:#ff9b9b; }
    </style>
  </head>
  <body>
    <main>
      <h1>Codex Web 安全登录</h1>
      <p>请输入单独的站点访问密钥。不要在这里输入 ChatGPT 密码、验证码或令牌。</p>
      ${error}
      <form method="post" action="${LOGIN_PATH}" autocomplete="off">
        <label>站点访问密钥
          <input name="access_token" type="password" minlength="32" maxlength="4096" required autofocus>
        </label>
        <button type="submit">进入 Codex Web</button>
      </form>
    </main>
  </body>
</html>`;
}

function requestHostMatches(
  request: FastifyRequest | IncomingMessage,
  publicOrigin: URL,
): boolean {
  return request.headers.host?.toLowerCase() === publicOrigin.host.toLowerCase();
}

function requestOriginMatches(
  request: FastifyRequest | IncomingMessage,
  publicOrigin: URL,
): boolean {
  return request.headers.origin === publicOrigin.origin;
}

function sameOriginFetch(request: FastifyRequest): boolean {
  return request.headers["sec-fetch-site"] === "same-origin";
}

function setSecurityHeaders(
  reply: FastifyReply,
  publicOrigin: URL,
  requestPath: string,
): void {
  const websocketOrigin = `${publicOrigin.protocol === "https:" ? "wss:" : "ws:"}//${publicOrigin.host}`;
  if (!reply.hasHeader("content-security-policy")) {
    reply.header(
      "content-security-policy",
      [
        "default-src 'self' data: blob:",
        `script-src 'self' ${INLINE_UUID_SCRIPT_SHA256} ${ROUTED_INLINE_SCRIPT_SHA256} 'wasm-unsafe-eval'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        `connect-src 'self' ${websocketOrigin}`,
        "frame-src 'self' blob:",
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }
  reply
    .header("cross-origin-resource-policy", "same-origin")
    .header("permissions-policy", "camera=(), geolocation=(), microphone=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
  if (
    requestPath === "/" ||
    requestPath === LOGIN_PATH ||
    requestPath === SESSION_PATH ||
    requestPath === BROWSER_CONFIG_PATH ||
    requestPath === "/assets/preload.js" ||
    requestPath.startsWith("/__backend/codex-router/")
  ) {
    reply.header("cache-control", "no-store");
  }
}

function isUnsafeMethod(method: string): boolean {
  return !new Set(["GET", "HEAD", "OPTIONS"]).has(method.toUpperCase());
}

function validCsrfHeader(request: FastifyRequest, session: Session): boolean {
  const header = request.headers["x-codex-csrf"];
  return (
    typeof header === "string" &&
    equalDigest(sha256(header), sha256(session.csrfToken))
  );
}

function safeRequestId(value: unknown): boolean {
  return (
    (typeof value === "string" && value.length >= 1 && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function onlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function serializedBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

function safeJsonRpcRequest(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["id", "method"], ["params"]) ||
    !safeRequestId(value.id) ||
    typeof value.method !== "string" ||
    value.method.length < 1 ||
    value.method.length > 160
  ) {
    return false;
  }
  const size = serializedBytes(value);
  return size !== null && size <= 3 * 1024 * 1024;
}

function safeJsonRpcResponse(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["id"], ["result", "error"]) ||
    !safeRequestId(value.id) ||
    Object.hasOwn(value, "result") === Object.hasOwn(value, "error")
  ) {
    return false;
  }
  const size = serializedBytes(value);
  return size !== null && size <= 3 * 1024 * 1024;
}

function isSafeAuthStatusRequest(request: Record<string, unknown>): boolean {
  if (request.method !== "getAuthStatus") {
    return true;
  }
  if (!isRecord(request.params)) {
    return false;
  }
  const keys = Object.keys(request.params).sort();
  return (
    keys.length === 2 &&
    keys[0] === "includeToken" &&
    keys[1] === "refreshToken" &&
    request.params.includeToken === false &&
    request.params.refreshToken === false
  );
}

function isAllowedMessageFromViewPayload(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    value.type.length > 128
  ) {
    return false;
  }
  if (value.type === "ready") {
    return onlyKeys(value, ["type"]);
  }
  if (value.type === "mcp-request" || value.type === "thread-prewarm-start") {
    if (
      !onlyKeys(value, ["type", "hostId", "request"]) ||
      value.hostId !== "local" ||
      !safeJsonRpcRequest(value.request)
    ) {
      return false;
    }
    if (
      value.type === "thread-prewarm-start" &&
      value.request.method !== "thread/start"
    ) {
      return false;
    }
    return isSafeAuthStatusRequest(value.request);
  }
  if (value.type === "mcp-response") {
    return (
      onlyKeys(value, ["type", "hostId", "response"]) &&
      value.hostId === "local" &&
      safeJsonRpcResponse(value.response)
    );
  }
  return false;
}

function normalizedSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveOutputKey(key: string): boolean {
  const normalized = normalizedSensitiveKey(key);
  return (
    SENSITIVE_OUTPUT_KEYS.has(normalized) ||
    SENSITIVE_OUTPUT_KEY_SUFFIXES.some((suffix) =>
      normalized.endsWith(suffix),
    )
  );
}

function containsSensitiveOutputValue(value: string): boolean {
  if (value.length > MAX_OUTPUT_STRING_CHARACTERS) {
    return true;
  }
  return SENSITIVE_OUTPUT_VALUE_PATTERNS.some((pattern) =>
    pattern.test(value),
  );
}

function containsSensitiveOutput(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): boolean {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 32) {
    return true;
  }
  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      typeof value[0] === "string" &&
      isSensitiveOutputKey(value[0])
    ) {
      return true;
    }
    return value.some((entry) =>
      containsSensitiveOutput(entry, state, depth + 1),
    );
  }
  if (typeof value === "string") {
    return containsSensitiveOutputValue(value);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    Object.hasOwn(value, "value") &&
    ((typeof value.name === "string" && isSensitiveOutputKey(value.name)) ||
      (typeof value.key === "string" && isSensitiveOutputKey(value.key)))
  ) {
    return true;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveOutputKey(key)) {
      return true;
    }
    if (key === "bodyJsonString" && typeof entry === "string") {
      try {
        if (containsSensitiveOutput(JSON.parse(entry), state, depth + 1)) {
          return true;
        }
      } catch {
        return true;
      }
      continue;
    }
    if (containsSensitiveOutput(entry, state, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function isAuthorizedRendererEvent(message: unknown): boolean {
  const size = serializedBytes(message);
  return (
    size !== null &&
    size <= 4 * 1024 * 1024 &&
    !containsSensitiveOutput(message, { nodes: 0 })
  );
}

function safeGitWorkerValue(
  value: unknown,
  workspaceRoots: readonly string[],
  state: { nodes: number },
  depth = 0,
): boolean {
  state.nodes += 1;
  if (state.nodes > 4_096 || depth > 12) {
    return false;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 1_024 &&
      value.every((entry) =>
        safeGitWorkerValue(entry, workspaceRoots, state, depth + 1),
      )
    );
  }
  if (typeof value === "string") {
    if (
      value.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      containsSensitiveOutputValue(value)
    ) {
      return false;
    }
    return (
      !path.isAbsolute(value) ||
      workspaceRoots.some((root) => isPathWithinRoot(root, value))
    );
  }
  if (!isRecord(value)) {
    return (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 128 || isSensitiveOutputKey(key)) {
      return false;
    }
    if (
      normalizedSensitiveKey(key) === "hostconfig" &&
      (!isRecord(entry) ||
        entry.id !== "local" ||
        entry.kind !== "local" ||
        !onlyKeys(entry, ["id", "kind"], ["display_name", "displayName"]))
    ) {
      return false;
    }
    if (!safeGitWorkerValue(entry, workspaceRoots, state, depth + 1)) {
      return false;
    }
  }
  return true;
}

function isAuthorizedGitWorkerInvoke(
  message: Record<string, unknown>,
  workspaceRoots: readonly string[],
): boolean {
  if (
    workspaceRoots.length === 0 ||
    !onlyKeys(message, ["type", "requestId", "channel", "args"]) ||
    message.type !== "ipc-renderer-invoke" ||
    !safeRequestId(message.requestId) ||
    message.channel !== GIT_WORKER_INVOKE_CHANNEL ||
    !Array.isArray(message.args) ||
    message.args.length !== 1 ||
    !isRecord(message.args[0])
  ) {
    return false;
  }
  const envelope = message.args[0];
  if (
    envelope.type === "worker-request-cancel" &&
    onlyKeys(envelope, ["type", "workerId", "id"]) &&
    envelope.workerId === "git" &&
    safeRequestId(envelope.id)
  ) {
    return true;
  }
  if (
    envelope.type !== "worker-request" ||
    !onlyKeys(envelope, ["type", "workerId", "request"]) ||
    envelope.workerId !== "git" ||
    !isRecord(envelope.request) ||
    !onlyKeys(envelope.request, ["id", "method", "params"]) ||
    !safeRequestId(envelope.request.id) ||
    typeof envelope.request.method !== "string" ||
    !ALLOWED_GIT_WORKER_METHODS.has(envelope.request.method) ||
    !isRecord(envelope.request.params)
  ) {
    return false;
  }
  const size = serializedBytes(message);
  return (
    size !== null &&
    size <= 512 * 1_024 &&
    !containsSensitiveOutput(message, { nodes: 0 }) &&
    safeGitWorkerValue(
      envelope.request.params,
      workspaceRoots,
      { nodes: 0 },
    )
  );
}

export function isAuthorizedRendererMessage(
  message: unknown,
  workspaceRoots: readonly string[] = [],
): boolean {
  if (!isRecord(message) || typeof message.type !== "string") {
    return false;
  }
  if (message.type === "ipc-renderer-ready") {
    return Object.keys(message).length === 1;
  }
  if (message.type === "workspace-directory-entries-request") {
    return (
      safeRequestId(message.requestId) &&
      (message.directoryPath === null ||
        (typeof message.directoryPath === "string" &&
          message.directoryPath.length <= 4_096)) &&
      message.directoriesOnly === true
    );
  }
  if (
    message.type !== "ipc-renderer-invoke" &&
    message.type !== "ipc-renderer-send"
  ) {
    return false;
  }
  if (
    message.type === "ipc-renderer-invoke" &&
    message.channel === GIT_WORKER_INVOKE_CHANNEL
  ) {
    return isAuthorizedGitWorkerInvoke(message, workspaceRoots);
  }
  if (
    message.type !== "ipc-renderer-invoke" ||
    !safeRequestId(message.requestId) ||
    typeof message.channel !== "string" ||
    !Array.isArray(message.args) ||
    message.args.length > 16
  ) {
    return false;
  }
  if (SAFE_ZERO_ARGUMENT_INVOKE_CHANNELS.has(message.channel)) {
    return message.args.length === 0;
  }
  if (message.channel === "codex_desktop:get-fast-mode-rollout-metrics") {
    if (message.args.length !== 1 || !isRecord(message.args[0])) {
      return false;
    }
    try {
      return Buffer.byteLength(JSON.stringify(message.args[0])) <= 4_096;
    } catch {
      return false;
    }
  }
  if (message.channel === "codex_desktop:message-from-view") {
    return (
      message.args.length === 1 &&
      isAllowedMessageFromViewPayload(message.args[0])
    );
  }
  return false;
}

function hasRequiredWebSocketProtocol(request: IncomingMessage): boolean {
  const header = request.headers["sec-websocket-protocol"];
  if (typeof header !== "string") {
    return false;
  }
  const protocols = header.split(",").map((value) => value.trim());
  return protocols.length === 1 && protocols[0] === IPC_SUBPROTOCOL;
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function registerBrowserSessionAuth(
  app: FastifyInstance,
  environment: NodeJS.ProcessEnv,
): Promise<BrowserSessionAuth> {
  const config = await loadConfig(environment);
  const sessions = new Map<string, Session>();
  const requestSessions = new WeakMap<FastifyRequest, Session>();
  const failedLogins = new Map<string, FailedLoginWindow>();
  const sessionRevocationListeners = new Set<(sessionId: string) => void>();
  const secureCookie = config.publicOrigin.protocol === "https:";

  function revokeSession(
    session: Session,
    responseToKeep?: ServerResponse,
  ): void {
    sessions.delete(session.id);
    if (session.expiryTimer !== null) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = null;
    }
    for (const response of session.responses) {
      if (response === responseToKeep) {
        continue;
      }
      try {
        response.destroy();
      } catch {
        // The HTTP response may already be closing.
      }
    }
    session.responses.clear();
    for (const socket of session.sockets) {
      try {
        socket.close(1008, "session expired");
      } catch {
        // The socket may already be closing.
      }
    }
    session.sockets.clear();
    for (const listener of sessionRevocationListeners) {
      try {
        listener(session.id);
      } catch {
        // Session revocation remains fail-closed if best-effort cleanup fails.
      }
    }
  }

  function activeSession(cookieHeader: string | undefined): Session | null {
    const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (token === null) {
      return null;
    }
    const id = sha256(token).toString("hex");
    const session = sessions.get(id) ?? null;
    if (session !== null && session.expiresAt <= Date.now()) {
      revokeSession(session);
      return null;
    }
    return session;
  }

  function createSession(
    revokeExisting = true,
  ): { session: Session; token: string } {
    if (revokeExisting) {
      for (const session of sessions.values()) {
        revokeSession(session);
      }
    } else {
      while (sessions.size >= MAX_TRUSTED_TAILNET_SESSIONS) {
        const oldest = sessions.values().next().value;
        if (oldest === undefined) {
          break;
        }
        revokeSession(oldest);
      }
    }
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      csrfToken: randomBytes(32).toString("base64url"),
      expiryTimer: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
      id: sha256(token).toString("hex"),
      responses: new Set(),
      sockets: new Set(),
      startupDiagnostics: new Set(),
    };
    sessions.set(session.id, session);
    session.expiryTimer = setTimeout(() => {
      if (sessions.get(session.id) === session) {
        revokeSession(session);
      }
    }, SESSION_TTL_MS);
    session.expiryTimer.unref();
    return { session, token };
  }

  function loginRateLimited(remoteAddress: string): boolean {
    const now = Date.now();
    const current = failedLogins.get(remoteAddress);
    if (current === undefined || now - current.startedAt >= FAILED_LOGIN_WINDOW_MS) {
      return false;
    }
    return current.count >= MAX_FAILED_LOGINS_PER_WINDOW;
  }

  function recordFailedLogin(remoteAddress: string): void {
    const now = Date.now();
    const current = failedLogins.get(remoteAddress);
    if (current === undefined || now - current.startedAt >= FAILED_LOGIN_WINDOW_MS) {
      if (failedLogins.size >= MAX_FAILED_LOGIN_IPS) {
        const oldest = failedLogins.keys().next().value;
        if (typeof oldest === "string") {
          failedLogins.delete(oldest);
        }
      }
      failedLogins.set(remoteAddress, { count: 1, startedAt: now });
      return;
    }
    current.count += 1;
  }

  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
  }

  app.addHook("onSend", async (request, reply, payload) => {
    setSecurityHeaders(
      reply,
      config.publicOrigin,
      normalizeRequestPath(request.raw.url),
    );
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    const requestPath = normalizeRequestPath(request.raw.url);
    if (requestPath === HEALTH_PATH) {
      return;
    }
    if (!requestHostMatches(request, config.publicOrigin)) {
      return reply.code(421).send({ error: "misdirected_request" });
    }
    if (requestPath === LOGIN_PATH) {
      if (config.trustedTailnetAccess) {
        if (request.method === "GET") {
          return reply.code(303).header("location", "/").send();
        }
        return reply.code(403).send({ error: "request_forbidden" });
      }
      if (
        request.method !== "GET" &&
        (!requestOriginMatches(request, config.publicOrigin) ||
          !sameOriginFetch(request))
      ) {
        return reply.code(403).send({ error: "request_forbidden" });
      }
      return;
    }
    let session = activeSession(request.headers.cookie);
    if (session === null) {
      const acceptsHtml =
        request.method === "GET" &&
        (request.headers.accept ?? "").includes("text/html");
      if (config.trustedTailnetAccess && acceptsHtml) {
        const created = createSession(false);
        session = created.session;
        reply.header("set-cookie", sessionCookie(created.token, secureCookie));
      } else if (acceptsHtml) {
        return reply
          .code(303)
          .header("location", LOGIN_PATH)
          .send();
      } else {
        return reply.code(401).send({ error: "authentication_required" });
      }
    }
    requestSessions.set(request, session);
    session.responses.add(reply.raw);
    const releaseResponse = () => session.responses.delete(reply.raw);
    reply.raw.once("close", releaseResponse);
    reply.raw.once("finish", releaseResponse);
    if (
      isUnsafeMethod(request.method) &&
      (!requestOriginMatches(request, config.publicOrigin) ||
        !sameOriginFetch(request) ||
        !validCsrfHeader(request, session))
    ) {
      return reply.code(403).send({ error: "request_forbidden" });
    }
  });

  app.get(HEALTH_PATH, async (_request, reply) => {
    return reply
      .header("cache-control", "no-store")
      .send({ ok: true });
  });

  app.get(LOGIN_PATH, async (_request, reply) => {
    return reply
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(loginPage(false));
  });

  app.post(
    LOGIN_PATH,
    { bodyLimit: MAX_LOGIN_BODY_BYTES },
    async (request, reply) => {
      const remoteAddress = request.ip;
      const body =
        typeof request.body === "string"
          ? new URLSearchParams(request.body)
          : null;
      const keys = body ? Array.from(body.keys()) : [];
      const supplied =
        body !== null &&
        keys.length === 1 &&
        keys[0] === "access_token"
          ? body.get("access_token")
          : null;
      const suppliedDigest = sha256(
        typeof supplied === "string" ? supplied : "",
      );
      const accepted =
        !loginRateLimited(remoteAddress) &&
        typeof supplied === "string" &&
        supplied.length >= 32 &&
        supplied.length <= 4_096 &&
        ACCESS_TOKEN_PATTERN.test(supplied) &&
        config.accessTokenDigest !== null &&
        equalDigest(suppliedDigest, config.accessTokenDigest);
      if (!accepted) {
        recordFailedLogin(remoteAddress);
        return reply
          .code(401)
          .header("cache-control", "no-store")
          .type("text/html; charset=utf-8")
          .send(loginPage(true));
      }
      failedLogins.delete(remoteAddress);
      const { token } = createSession();
      return reply
        .code(303)
        .header("cache-control", "no-store")
        .header("location", "/")
        .header("set-cookie", sessionCookie(token, secureCookie))
        .send();
    },
  );

  app.get(SESSION_PATH, async (request, reply) => {
    const session = requestSessions.get(request);
    if (session === undefined) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    return reply.header("cache-control", "no-store").send({
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.get(BROWSER_CONFIG_PATH, async (_request, reply) => {
    return reply.header("cache-control", "no-store").send({
      codexHome: config.codexHome,
      workspaceRoots: [...config.workspaceRoots],
    });
  });

  app.get(STARTUP_PROBE_PATH, async (_request, reply) => {
    return reply
      .header("cache-control", "no-store")
      .type("application/javascript; charset=utf-8")
      .send(STARTUP_PROBE_SOURCE);
  });

  app.post(
    STARTUP_DIAGNOSTIC_PATH,
    { bodyLimit: MAX_STARTUP_DIAGNOSTIC_BODY_BYTES },
    async (request, reply) => {
      const body = request.body;
      if (
        !isRecord(body) ||
        !onlyKeys(body, ["code"]) ||
        typeof body.code !== "string" ||
        !STARTUP_DIAGNOSTIC_CODES.has(body.code)
      ) {
        return reply.code(400).send({ error: "invalid_startup_diagnostic" });
      }
      const session = requestSessions.get(request);
      if (session === undefined) {
        return reply.code(401).send({ error: "authentication_required" });
      }
      if (!session.startupDiagnostics.has(body.code)) {
        session.startupDiagnostics.add(body.code);
        console.warn(`[browser-startup] code=${body.code}`);
      }
      return reply.code(204).send();
    },
  );

  app.delete(SESSION_PATH, async (request, reply) => {
    const session = requestSessions.get(request);
    if (session !== undefined) {
      revokeSession(session, reply.raw);
    }
    return reply
      .code(204)
      .header("cache-control", "no-store")
      .header("set-cookie", expiredSessionCookie(secureCookie))
      .send();
  });

  return {
    authorizeRendererEvent: isAuthorizedRendererEvent,
    authorizeRendererMessage: (message) =>
      isAuthorizedRendererMessage(message, config.workspaceRoots),
    authorizeWebSocket(request): WebSocketAuthorization {
      if (
        !requestHostMatches(request, config.publicOrigin) ||
        !requestOriginMatches(request, config.publicOrigin)
      ) {
        return { ok: false, statusCode: 403 };
      }
      if (!hasRequiredWebSocketProtocol(request)) {
        return { ok: false, statusCode: 400 };
      }
      const session = activeSession(request.headers.cookie);
      return session === null
        ? { ok: false, statusCode: 401 }
        : { ok: true, sessionId: session.id };
    },
    bindWebSocket(sessionId, socket): () => void {
      const session = sessions.get(sessionId);
      if (session === undefined || session.expiresAt <= Date.now()) {
        socket.close(1008, "session expired");
        return () => undefined;
      }
      session.sockets.add(socket);
      return () => session.sockets.delete(socket);
    },
    limitRemoteHistory: config.trustedTailnetAccess,
    onSessionRevoked(listener): () => void {
      sessionRevocationListeners.add(listener);
      return () => sessionRevocationListeners.delete(listener);
    },
    publicOrigin: config.publicOrigin.origin,
    async resolveWorkspaceDirectory(directoryPath): Promise<string> {
      const requested = directoryPath ?? config.workspaceRoots[0]!;
      const resolved = await fs.realpath(path.resolve(requested));
      const stat = await fs.stat(resolved);
      if (
        !stat.isDirectory() ||
        !config.workspaceRoots.some((root) => isPathWithinRoot(root, resolved))
      ) {
        throw new Error("workspace directory is unavailable");
      }
      return resolved;
    },
    sessionIdForRequest(request): string {
      const session = requestSessions.get(request);
      if (session === undefined) {
        throw new Error("browser session is unavailable");
      }
      return session.id;
    },
  };
}
