const MAX_LOCAL_MESSAGE_BYTES = 256 * 1024;
const MAX_MCP_MESSAGE_BYTES = 3 * 1024 * 1024;
const MAX_EXTERNAL_URL_LENGTH = 4_096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const OPEN_IN_BROWSER_OPTIONAL_KEYS = [
  "disposition",
  "hostId",
  "initiator",
  "openTarget",
  "openTargetIntent",
  "originHostId",
  "source",
  "useExternalBrowser",
] as const;

const LOCAL_NOOP_MESSAGE_TYPES = new Set([
  "electron-avatar-overlay-feedback-diagnostics-changed",
  "electron-avatar-overlay-restore-ready",
  "electron-desktop-features-changed",
  "electron-sparkle-gates-changed",
  "log-message",
  "remote-hosted-pip-active-thread-changed",
  "remote-hosted-pip-hidden-thread-ids-changed",
  "set-telemetry-user",
  "view-focused",
]);

const LOCAL_STATSIG_INITIALIZE_RESPONSE = {
  dynamic_configs: {},
  feature_gates: {},
  has_updates: true,
  layer_configs: {},
  param_stores: {},
  time: 1,
} as const;

const LOCAL_FETCH_URLS = new Map<string, unknown>([
  [
    "vscode://codex/get-settings",
    { configuredValues: {}, values: {} },
  ],
  [
    "vscode://codex/list-pinned-threads",
    { threadIds: [] },
  ],
  [
    "vscode://codex/os-info",
    {
      platform: "linux",
      osVersion: "",
      osRelease: "",
      isSystemBackdropSupported: false,
      hasWsl: false,
      isVsCodeRunningInsideWsl: false,
      windowsAccountType: null,
    },
  ],
  [
    "vscode://codex/is-copilot-api-available",
    { available: false },
  ],
]);

export type BrowserMessageDisposition =
  | { kind: "local-noop" }
  | { kind: "local-persisted-sync" }
  | {
      kind: "local-fetch-response";
      body: unknown;
      requestId: string;
    }
  | {
      kind: "local-fetch-error";
      error: string;
      requestId: string;
      status: number;
    }
  | {
      kind: "local-fetch-stream-error";
      error: string;
      requestId: string;
    }
  | {
      kind: "local-file-picker";
      message: {
        body?: string;
        method: "POST";
        requestId: string;
        type: "fetch";
        url:
          | "vscode://codex/pick-file"
          | "vscode://codex/pick-files";
      };
    }
  | {
      kind: "local-mcp-error";
      requestId: string | number;
    }
  | {
      kind: "local-mcp-response";
      requestId: string | number;
      result: unknown;
    }
  | {
      kind: "local-workspace-root-add";
      root: string;
    }
  | {
      kind: "local-workspace-roots-update";
      roots: string[];
    }
  | {
      kind: "open-external";
      url: string;
    }
  | {
      field: "codexHome" | "workspaceRoots";
      kind: "request-browser-config";
      requestId: string;
    }
  | { kind: "server" }
  | { kind: "reject" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedSize(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : new TextEncoder().encode(serialized).length;
  } catch {
    return null;
  }
}

function boundedMessage(value: unknown, maximum: number): boolean {
  const size = serializedSize(value);
  return size !== null && size <= maximum;
}

function safeRequestId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && REQUEST_ID_PATTERN.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function safeFetchRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function safeStateKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
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

function normalizeExternalUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.href.length > MAX_EXTERNAL_URL_LENGTH
  ) {
    return null;
  }
  return parsed.href;
}

function safeJsonRpcRequest(
  value: unknown,
): value is Record<string, unknown> & { id: string | number } {
  return (
    isRecord(value) &&
    onlyKeys(value, ["id", "method"], ["params"]) &&
    safeRequestId(value.id) &&
    typeof value.method === "string" &&
    value.method.length >= 1 &&
    value.method.length <= 160 &&
    boundedMessage(value, MAX_MCP_MESSAGE_BYTES)
  );
}

function safeJsonRpcResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["id"], ["result", "error"]) &&
    safeRequestId(value.id) &&
    Object.hasOwn(value, "result") !== Object.hasOwn(value, "error") &&
    boundedMessage(value, MAX_MCP_MESSAGE_BYTES)
  );
}

function safeAuthStatusRequest(request: Record<string, unknown>): boolean {
  if (request.method !== "getAuthStatus") {
    return true;
  }
  return (
    isRecord(request.params) &&
    onlyKeys(request.params, ["includeToken", "refreshToken"]) &&
    request.params.includeToken === false &&
    request.params.refreshToken === false
  );
}

function localStateDisposition(
  message: Record<string, unknown>,
): BrowserMessageDisposition | null {
  if (message.type === "persisted-atom-sync-request") {
    return onlyKeys(message, ["type"])
      ? { kind: "local-persisted-sync" }
      : { kind: "reject" };
  }
  if (message.type === "persisted-atom-update") {
    return onlyKeys(message, ["type", "key"], ["value", "deleted"]) &&
      safeStateKey(message.key) &&
      boundedMessage(message, MAX_LOCAL_MESSAGE_BYTES)
      ? { kind: "local-noop" }
      : { kind: "reject" };
  }
  if (message.type === "shared-object-set") {
    return onlyKeys(message, ["type", "key"], ["value"]) &&
      safeStateKey(message.key) &&
      boundedMessage(message, MAX_LOCAL_MESSAGE_BYTES)
      ? { kind: "local-noop" }
      : { kind: "reject" };
  }
  if (
    message.type === "shared-object-subscribe" ||
    message.type === "shared-object-unsubscribe"
  ) {
    return onlyKeys(message, ["type", "key"]) && safeStateKey(message.key)
      ? { kind: "local-noop" }
      : { kind: "reject" };
  }
  return null;
}

function workspaceMutationDisposition(
  message: Record<string, unknown>,
): BrowserMessageDisposition | null {
  if (message.type === "electron-add-new-workspace-root-option") {
    return onlyKeys(message, ["type", "root"]) &&
      typeof message.root === "string" &&
      message.root.length >= 1 &&
      message.root.length <= 4_096
      ? {
          kind: "local-workspace-root-add",
          root: message.root,
        }
      : { kind: "reject" };
  }
  if (message.type === "electron-update-workspace-root-options") {
    return onlyKeys(message, ["type", "roots"]) &&
      Array.isArray(message.roots) &&
      message.roots.length <= 16 &&
      message.roots.every(
        (root) =>
          typeof root === "string" &&
          root.length >= 1 &&
          root.length <= 4_096,
      ) &&
      boundedMessage(message, MAX_LOCAL_MESSAGE_BYTES)
      ? {
          kind: "local-workspace-roots-update",
          roots: [...message.roots],
        }
      : { kind: "reject" };
  }
  return null;
}

function fetchError(
  requestId: string,
  error = "unsupported_browser_route",
  status = 403,
): BrowserMessageDisposition {
  return {
    kind: "local-fetch-error",
    requestId,
    status,
    error,
  };
}

function safeFilePickerBody(value: unknown): value is string | undefined {
  if (value === undefined || value === "") {
    return true;
  }
  if (typeof value !== "string" || value.length > 32_768) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      isRecord(parsed) &&
      onlyKeys(parsed, [], ["imagesOnly", "pickerTitle"]) &&
      (parsed.imagesOnly === undefined ||
        typeof parsed.imagesOnly === "boolean") &&
      (parsed.pickerTitle === undefined ||
        (typeof parsed.pickerTitle === "string" &&
          parsed.pickerTitle.length <= 256))
    );
  } catch {
    return false;
  }
}

export function localBrowserStatsigResponse(url: string): unknown | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol === "https:" &&
    parsed.hostname === "ab.chatgpt.com" &&
    parsed.pathname === "/v1/initialize"
  ) {
    return LOCAL_STATSIG_INITIALIZE_RESPONSE;
  }
  if (
    parsed.protocol === "https:" &&
    ((parsed.hostname === "ab.chatgpt.com" &&
      parsed.pathname === "/v1/rgstr") ||
      (parsed.hostname === "chatgpt.com" &&
        parsed.pathname === "/ces/v1/rgstr"))
  ) {
    return {};
  }
  return null;
}

function localFetchDisposition(
  message: Record<string, unknown>,
): BrowserMessageDisposition | null {
  if (message.type === "fetch-stream") {
    return safeFetchRequestId(message.requestId)
      ? {
          kind: "local-fetch-stream-error",
          requestId: message.requestId,
          error: "browser_stream_route_unavailable",
        }
      : { kind: "reject" };
  }
  if (
    message.type === "cancel-fetch" ||
    message.type === "cancel-fetch-stream"
  ) {
    return safeFetchRequestId(message.requestId) &&
      boundedMessage(message, MAX_LOCAL_MESSAGE_BYTES)
      ? { kind: "local-noop" }
      : { kind: "reject" };
  }
  if (message.type !== "fetch") {
    return null;
  }
  if (!safeFetchRequestId(message.requestId)) {
    return { kind: "reject" };
  }
  const { requestId } = message;
  if (
    !boundedMessage(message, MAX_LOCAL_MESSAGE_BYTES) ||
    message.method !== "POST" ||
    typeof message.url !== "string"
  ) {
    return fetchError(requestId, "invalid_browser_request", 400);
  }
  if (!message.url.startsWith("vscode://")) {
    const statsigResponse = localBrowserStatsigResponse(message.url);
    return statsigResponse === null
      ? fetchError(requestId)
      : {
          kind: "local-fetch-response",
          requestId,
          body: statsigResponse,
        };
  }
  if (
    message.url === "vscode://codex/pick-file" ||
    message.url === "vscode://codex/pick-files"
  ) {
    if (!safeFilePickerBody(message.body)) {
      return fetchError(requestId, "invalid_browser_request", 400);
    }
    return {
      kind: "local-file-picker",
      message: {
        ...(typeof message.body === "string" ? { body: message.body } : {}),
        method: "POST",
        requestId,
        type: "fetch",
        url: message.url,
      },
    };
  }
  if (message.url === "vscode://codex/get-global-state") {
    if (
      typeof message.body !== "string" ||
      message.body.length > 32_768
    ) {
      return fetchError(requestId, "invalid_browser_request", 400);
    }
    try {
      const body = JSON.parse(message.body) as unknown;
      if (
        !isRecord(body) ||
        !onlyKeys(body, ["key"]) ||
        !safeStateKey(body.key)
      ) {
        return fetchError(requestId, "invalid_browser_request", 400);
      }
    } catch {
      return fetchError(requestId, "invalid_browser_request", 400);
    }
    return {
      kind: "local-fetch-response",
      requestId,
      body: { value: null },
    };
  }
  if (message.url === "vscode://codex/workspace-root-options") {
    return {
      kind: "request-browser-config",
      requestId,
      field: "workspaceRoots",
    };
  }
  if (message.url === "vscode://codex/codex-home") {
    return {
      kind: "request-browser-config",
      requestId,
      field: "codexHome",
    };
  }
  const localResponse = LOCAL_FETCH_URLS.get(message.url);
  return localResponse === undefined
    ? fetchError(requestId)
    : {
        kind: "local-fetch-response",
        requestId,
        body: localResponse,
      };
}

function mcpDisposition(
  message: Record<string, unknown>,
): BrowserMessageDisposition | null {
  if (message.type === "ready") {
    return onlyKeys(message, ["type"])
      ? { kind: "server" }
      : { kind: "reject" };
  }
  if (
    message.type === "mcp-request" ||
    message.type === "thread-prewarm-start"
  ) {
    const request = isRecord(message.request) ? message.request : null;
    if (
      !onlyKeys(message, ["type", "hostId", "request"]) ||
      message.hostId !== "local" ||
      request === null ||
      !safeJsonRpcRequest(request) ||
      (message.type === "thread-prewarm-start" &&
        request.method !== "thread/start") ||
      !safeAuthStatusRequest(request)
    ) {
      return request !== null && safeRequestId(request.id)
        ? { kind: "local-mcp-error", requestId: request.id }
      : { kind: "reject" };
    }
    if (message.type === "mcp-request") {
      if (request.method === "plugin/list") {
        return {
          kind: "local-mcp-response",
          requestId: request.id,
          result: {
            featuredPluginIds: [],
            marketplaceLoadErrors: [],
            marketplaces: [],
          },
        };
      }
      if (request.method === "mcpServerStatus/list") {
        return {
          kind: "local-mcp-response",
          requestId: request.id,
          result: {
            data: [],
            nextCursor: null,
          },
        };
      }
    }
    return { kind: "server" };
  }
  if (message.type === "mcp-response") {
    return onlyKeys(message, ["type", "hostId", "response"]) &&
      message.hostId === "local" &&
      safeJsonRpcResponse(message.response)
      ? { kind: "server" }
      : { kind: "reject" };
  }
  return null;
}

export function classifyBrowserMessage(
  value: unknown,
): BrowserMessageDisposition {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { kind: "reject" };
  }
  if (value.type === "open-in-browser") {
    const url =
      onlyKeys(value, ["type", "url"], OPEN_IN_BROWSER_OPTIONAL_KEYS) &&
      boundedMessage(value, 32_768)
        ? normalizeExternalUrl(value.url)
        : null;
    return url === null
      ? { kind: "reject" }
      : { kind: "open-external", url };
  }
  if (LOCAL_NOOP_MESSAGE_TYPES.has(value.type)) {
    return boundedMessage(value, MAX_LOCAL_MESSAGE_BYTES)
      ? { kind: "local-noop" }
      : { kind: "reject" };
  }
  const localState = localStateDisposition(value);
  if (localState !== null) {
    return localState;
  }
  const workspaceMutation = workspaceMutationDisposition(value);
  if (workspaceMutation !== null) {
    return workspaceMutation;
  }
  const localFetch = localFetchDisposition(value);
  if (localFetch !== null) {
    return localFetch;
  }
  const mcp = mcpDisposition(value);
  return mcp ?? { kind: "reject" };
}
