type BrowserSocket = {
  readonly readyState: number;
  send(data: string): void;
};

type RoutedMessage = {
  args?: unknown[];
  channel?: unknown;
  type?: unknown;
};

const OPEN_SOCKET_STATE = 1;
const OUTSTANDING_REQUEST_LIMIT = 4_096;
const OUTSTANDING_REQUEST_TTL_MS = 15 * 60 * 1_000;
const REMOTE_HISTORY_TURN_LIMIT = 5;
const CONFIG_DIAGNOSTIC_METHODS = new Set([
  "config/read",
  "configRequirements/read",
  "permissionProfile/list",
]);

type OutstandingRequest = {
  createdAt: number;
  history: HistoryRequestContext | null;
  method: string | null;
  socket: BrowserSocket;
};

type HistoryRequestContext = {
  cursor: string | null;
  initialTurnsSortDirection: "asc" | "desc" | "invalid" | null;
  sortDirection: "asc" | "desc" | "invalid" | null;
  threadId: string | null;
  turnId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function correlationId(value: unknown): string | null {
  if (typeof value === "string" && value.length >= 1 && value.length <= 256) {
    return `s:${value}`;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? `n:${value}`
    : null;
}

function viewPayload(message: RoutedMessage): Record<string, unknown> | null {
  return message.type === "ipc-renderer-invoke" &&
    message.channel === "codex_desktop:message-from-view" &&
    Array.isArray(message.args) &&
    isRecord(message.args[0])
    ? message.args[0]
    : null;
}

function mainViewPayload(message: unknown): Record<string, unknown> | null {
  if (
    !isRecord(message) ||
    message.type !== "ipc-main-event" ||
    message.channel !== "codex_desktop:message-for-view" ||
    !Array.isArray(message.args) ||
    !isRecord(message.args[0])
  ) {
    return null;
  }
  return message.args[0];
}

function mcpKey(
  hostId: unknown,
  id: unknown,
  direction: "main" | "renderer",
): string | null {
  const normalizedId = correlationId(id);
  return hostId === "local" && normalizedId !== null
    ? `${direction}:local:${normalizedId}`
    : null;
}

function rendererRequestKey(message: RoutedMessage): string | null {
  const payload = viewPayload(message);
  if (
    payload === null ||
    (payload.type !== "mcp-request" &&
      payload.type !== "thread-prewarm-start") ||
    !isRecord(payload.request)
  ) {
    return null;
  }
  return mcpKey(payload.hostId, payload.request.id, "renderer");
}

function rendererRequestMethod(message: RoutedMessage): string | null {
  const payload = viewPayload(message);
  if (
    payload === null ||
    (payload.type !== "mcp-request" &&
      payload.type !== "thread-prewarm-start") ||
    !isRecord(payload.request) ||
    typeof payload.request.method !== "string" ||
    !/^[A-Za-z][A-Za-z0-9/._-]{0,159}$/u.test(payload.request.method)
  ) {
    return null;
  }
  return payload.request.method;
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    ? value
    : null;
}

function boundedCursor(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" && value.length >= 1 && value.length <= 4_096
    ? value
    : "invalid";
}

function sortDirection(
  value: unknown,
): "asc" | "desc" | "invalid" | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value === "asc" || value === "desc" ? value : "invalid";
}

function rendererHistoryContext(
  message: RoutedMessage,
): HistoryRequestContext | null {
  const payload = viewPayload(message);
  if (
    payload === null ||
    (payload.type !== "mcp-request" &&
      payload.type !== "thread-prewarm-start") ||
    !isRecord(payload.request) ||
    !isRecord(payload.request.params)
  ) {
    return null;
  }
  const initialTurnsPage = isRecord(payload.request.params.initialTurnsPage)
    ? payload.request.params.initialTurnsPage
    : null;
  return {
    cursor: boundedCursor(payload.request.params.cursor),
    initialTurnsSortDirection: sortDirection(initialTurnsPage?.sortDirection),
    sortDirection: sortDirection(payload.request.params.sortDirection),
    threadId: boundedIdentifier(payload.request.params.threadId),
    turnId: boundedIdentifier(payload.request.params.turnId),
  };
}

function warnFilteredRendererResponse(method: string | null): void {
  const runtimeConsole = (
    globalThis as {
      console?: { warn(message: string): void };
    }
  ).console;
  runtimeConsole?.warn(
    `[browser-ipc-router] filtered renderer response method=${method ?? "unknown"}`,
  );
}

function warnRendererConfigFlow(
  stage: "request" | "response",
  method: string | null,
): void {
  if (method === null || !CONFIG_DIAGNOSTIC_METHODS.has(method)) {
    return;
  }
  const runtimeConsole = (
    globalThis as {
      console?: { warn(message: string): void };
    }
  ).console;
  runtimeConsole?.warn(
    `[browser-ipc-router] renderer config ${stage} method=${method}`,
  );
}

function warnRendererConfigDelivery(
  method: string | null,
  delivered: boolean,
): void {
  if (method === null || !CONFIG_DIAGNOSTIC_METHODS.has(method)) {
    return;
  }
  const runtimeConsole = (
    globalThis as {
      console?: { warn(message: string): void };
    }
  ).console;
  runtimeConsole?.warn(
    `[browser-ipc-router] renderer config delivery method=${method} delivered=${delivered}`,
  );
}

function rendererResponseKey(message: RoutedMessage): string | null {
  const payload = viewPayload(message);
  if (
    payload === null ||
    payload.type !== "mcp-response" ||
    !isRecord(payload.response)
  ) {
    return null;
  }
  return mcpKey(payload.hostId, payload.response.id, "main");
}

function mainResponseKey(message: unknown): string | null {
  const payload = mainViewPayload(message);
  if (
    payload === null ||
    payload.type !== "mcp-response" ||
    !isRecord(payload.message)
  ) {
    return null;
  }
  return mcpKey(payload.hostId, payload.message.id, "renderer");
}

function mainRequestKey(message: unknown): string | null {
  const payload = mainViewPayload(message);
  if (
    payload === null ||
    payload.type !== "mcp-request" ||
    !isRecord(payload.request)
  ) {
    return null;
  }
  return mcpKey(payload.hostId, payload.request.id, "main");
}

function appServerStateKey(message: unknown): string | null {
  const payload = mainViewPayload(message);
  return payload !== null &&
    (payload.type === "codex-app-server-connection-changed" ||
      payload.type === "codex-app-server-initialized") &&
    payload.hostId === "local"
    ? `${payload.type}:local`
    : null;
}

function sanitizedMcpError(message: unknown): unknown | null {
  const payload = mainViewPayload(message);
  if (
    payload === null ||
    payload.type !== "mcp-response" ||
    !isRecord(payload.message) ||
    !correlationId(payload.message.id)
  ) {
    return null;
  }
  return {
    type: "ipc-main-event",
    channel: "codex_desktop:message-for-view",
    args: [
      {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: payload.message.id,
          error: {
            code: -32_603,
            message: "Response unavailable in browser mode",
          },
        },
      },
    ],
  };
}

function replaceMcpResult(message: unknown, result: unknown): unknown | null {
  const envelope = isRecord(message) ? message : null;
  const args = envelope !== null && Array.isArray(envelope.args)
    ? envelope.args
    : null;
  const payload = args !== null && isRecord(args[0]) ? args[0] : null;
  const response = payload !== null && isRecord(payload.message)
    ? payload.message
    : null;
  if (envelope === null || args === null || payload === null || response === null) {
    return null;
  }
  return {
    ...envelope,
    args: [
      {
        ...payload,
        message: {
          ...response,
          result,
        },
      },
      ...args.slice(1),
    ],
  };
}

function limitedThreadResult(
  result: unknown,
  history: HistoryRequestContext | null,
): Record<string, unknown> | null {
  if (
    !isRecord(result) ||
    !isRecord(result.thread) ||
    !Array.isArray(result.thread.turns)
  ) {
    return null;
  }
  const limited: Record<string, unknown> = {
    ...result,
    thread: {
      ...result.thread,
      turns: result.thread.turns.slice(-REMOTE_HISTORY_TURN_LIMIT),
    },
  };
  if (Object.hasOwn(result, "initialTurnsPage")) {
    const initialTurnsPage = result.initialTurnsPage;
    if (
      initialTurnsPage !== null &&
      (!isRecord(initialTurnsPage) ||
        !Array.isArray(initialTurnsPage.data))
    ) {
      return null;
    }
    if (isRecord(initialTurnsPage) && Array.isArray(initialTurnsPage.data)) {
      const descending =
        history?.initialTurnsSortDirection === null ||
        history?.initialTurnsSortDirection === "desc";
      limited.initialTurnsPage = {
        ...initialTurnsPage,
        data: descending
          ? initialTurnsPage.data.slice(0, REMOTE_HISTORY_TURN_LIMIT)
          : [],
        nextCursor: null,
        backwardsCursor: null,
      };
    }
  }
  if (Object.hasOwn(result, "turnsBackwardsCursor")) {
    limited.turnsBackwardsCursor = null;
  }
  return limited;
}

function limitedTurnsPageResult(
  result: unknown,
  history: HistoryRequestContext | null,
): Record<string, unknown> | null {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return null;
  }
  const initialDescendingPage =
    history?.cursor === null &&
    (history.sortDirection === null || history.sortDirection === "desc");
  return {
    ...result,
    data: initialDescendingPage
      ? result.data.slice(0, REMOTE_HISTORY_TURN_LIMIT)
      : [],
    nextCursor: null,
    backwardsCursor: null,
  };
}

function limitedItemsPageResult(
  result: unknown,
  history: HistoryRequestContext | null,
  allowedTurnIds: ReadonlySet<string> | null,
): Record<string, unknown> | null {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return null;
  }
  const turnId = history?.turnId ?? null;
  if (turnId === null || allowedTurnIds?.has(turnId) !== true) {
    return {
      ...result,
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    };
  }
  return result.data.every(
    (entry) => isRecord(entry) && entry.turnId === turnId,
  )
    ? result
    : null;
}

function limitedBrowserHistoryResponse(
  message: unknown,
  request: OutstandingRequest,
  allowedTurnIds: ReadonlySet<string> | null,
  limitRemoteHistory: boolean,
): unknown | null {
  if (!limitRemoteHistory) {
    return message;
  }
  if (
    request.method !== "thread/read" &&
    request.method !== "thread/resume" &&
    request.method !== "thread/fork" &&
    request.method !== "thread/rollback" &&
    request.method !== "thread/turns/list" &&
    request.method !== "thread/items/list"
  ) {
    return message;
  }
  const payload = mainViewPayload(message);
  if (payload === null || !isRecord(payload.message)) {
    return null;
  }
  if (Object.hasOwn(payload.message, "error")) {
    return message;
  }
  if (!Object.hasOwn(payload.message, "result")) {
    return null;
  }
  const result = request.method === "thread/turns/list"
    ? limitedTurnsPageResult(payload.message.result, request.history)
    : request.method === "thread/items/list"
      ? limitedItemsPageResult(
          payload.message.result,
          request.history,
          allowedTurnIds,
        )
      : limitedThreadResult(payload.message.result, request.history);
  return result === null ? null : replaceMcpResult(message, result);
}

function mcpResult(message: unknown): Record<string, unknown> | null {
  const payload = mainViewPayload(message);
  return payload !== null &&
    isRecord(payload.message) &&
    isRecord(payload.message.result)
    ? payload.message.result
    : null;
}

function turnIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > REMOTE_HISTORY_TURN_LIMIT) {
    return null;
  }
  const ids: string[] = [];
  for (const turn of value) {
    if (!isRecord(turn) || typeof turn.id !== "string" || turn.id.length === 0) {
      return null;
    }
    ids.push(turn.id);
  }
  return ids;
}

export class BrowserIpcRouter {
  private readonly latestState = new Map<
    string,
    { message: unknown; sequence: number }
  >();
  private readonly mainRequests = new Map<string, OutstandingRequest>();
  private readonly readySockets = new Set<BrowserSocket>();
  private readonly rendererRequests = new Map<string, OutstandingRequest>();
  private readonly recentTurnIds = new Map<
    BrowserSocket,
    Map<string, Set<string>>
  >();
  private readonly sockets = new Set<BrowserSocket>();
  private readonly viewReadySockets = new Set<BrowserSocket>();
  private sequence = 0;

  constructor(
    private readonly authorizeRendererEvent: (message: unknown) => boolean,
    private readonly limitRemoteHistory = false,
  ) {}

  addSocket(socket: BrowserSocket): void {
    this.sockets.add(socket);
    this.recentTurnIds.set(socket, new Map());
  }

  removeSocket(socket: BrowserSocket): void {
    this.sockets.delete(socket);
    this.readySockets.delete(socket);
    this.viewReadySockets.delete(socket);
    this.removeSocketRequests(this.mainRequests, socket);
    this.removeSocketRequests(this.rendererRequests, socket);
    if (this.sockets.size === 0) {
      this.latestState.clear();
      this.mainRequests.clear();
      this.rendererRequests.clear();
      this.recentTurnIds.clear();
      this.sequence = 0;
    }
    this.recentTurnIds.delete(socket);
  }

  markTransportReady(socket: BrowserSocket): boolean {
    if (!this.sockets.has(socket) || this.readySockets.has(socket)) {
      return false;
    }
    this.readySockets.add(socket);
    return true;
  }

  trackRendererMessage(socket: BrowserSocket, message: RoutedMessage): boolean {
    if (!this.sockets.has(socket) || !this.readySockets.has(socket)) {
      return false;
    }
    this.pruneExpiredRequests();
    const payload = viewPayload(message);
    if (payload?.type === "ready") {
      if (this.viewReadySockets.has(socket)) {
        return false;
      }
      this.viewReadySockets.add(socket);
      for (const { message } of Array.from(this.latestState.values()).sort(
        (left, right) => left.sequence - right.sequence,
      )) {
        this.send(socket, message);
      }
      return true;
    }

    const responseKey = rendererResponseKey(message);
    if (responseKey !== null) {
      if (this.mainRequests.get(responseKey)?.socket !== socket) {
        return false;
      }
      this.mainRequests.delete(responseKey);
      return true;
    }

    const requestKey = rendererRequestKey(message);
    if (requestKey === null) {
      return true;
    }
    if (
      this.rendererRequests.has(requestKey) ||
      this.rendererRequests.size >= OUTSTANDING_REQUEST_LIMIT
    ) {
      return false;
    }
    this.rendererRequests.set(requestKey, {
      createdAt: Date.now(),
      history: rendererHistoryContext(message),
      method: rendererRequestMethod(message),
      socket,
    });
    warnRendererConfigFlow("request", rendererRequestMethod(message));
    return true;
  }

  cancelRendererMessage(socket: BrowserSocket, message: RoutedMessage): void {
    const key = rendererRequestKey(message);
    if (key !== null && this.rendererRequests.get(key)?.socket === socket) {
      this.rendererRequests.delete(key);
    }
  }

  routeMainMessage(message: unknown): void {
    this.pruneExpiredRequests();
    const payload = mainViewPayload(message);
    const responseKey = mainResponseKey(message);
    if (responseKey !== null) {
      const outstanding = this.rendererRequests.get(responseKey);
      this.rendererRequests.delete(responseKey);
      if (outstanding === undefined) {
        return;
      }
      const target = outstanding.socket;
      const threadId = outstanding.history?.threadId ?? null;
      const allowedTurnIds = threadId === null
        ? null
        : this.recentTurnIds.get(target)?.get(threadId) ?? null;
      const deliverable = limitedBrowserHistoryResponse(
        message,
        outstanding,
        allowedTurnIds,
        this.limitRemoteHistory,
      );
      if (deliverable === null || !this.authorizeRendererEvent(deliverable)) {
        warnFilteredRendererResponse(outstanding.method);
        const fallback = sanitizedMcpError(message);
        if (fallback !== null) {
          this.send(target, fallback);
        }
        return;
      }
      warnRendererConfigFlow("response", outstanding.method);
      const delivered = this.send(target, deliverable);
      if (delivered && this.limitRemoteHistory) {
        this.rememberRecentTurns(target, outstanding, deliverable);
      }
      warnRendererConfigDelivery(outstanding.method, delivered);
      return;
    }
    if (payload?.type === "mcp-response") {
      return;
    }

    if (!this.authorizeRendererEvent(message)) {
      return;
    }

    const requestKey = mainRequestKey(message);
    if (requestKey !== null) {
      if (
        this.mainRequests.has(requestKey) ||
        this.mainRequests.size >= OUTSTANDING_REQUEST_LIMIT
      ) {
        return;
      }
      const target = this.firstViewReadySocket();
      if (target === null) {
        return;
      }
      this.mainRequests.set(requestKey, {
        createdAt: Date.now(),
        history: null,
        method: null,
        socket: target,
      });
      if (!this.send(target, message)) {
        this.mainRequests.delete(requestKey);
      }
      return;
    }
    if (payload?.type === "mcp-request") {
      return;
    }

    const stateKey = appServerStateKey(message);
    if (stateKey !== null) {
      this.sequence += 1;
      this.latestState.set(stateKey, {
        message,
        sequence: this.sequence,
      });
    }
    for (const socket of this.viewReadySockets) {
      this.send(socket, message);
    }
  }

  sendDirect(socket: BrowserSocket, message: unknown): boolean {
    return this.authorizeRendererEvent(message) && this.send(socket, message);
  }

  private firstViewReadySocket(): BrowserSocket | null {
    for (const socket of this.viewReadySockets) {
      if (socket.readyState === OPEN_SOCKET_STATE) {
        return socket;
      }
    }
    return null;
  }

  private rememberRecentTurns(
    socket: BrowserSocket,
    request: OutstandingRequest,
    message: unknown,
  ): void {
    if (request.method === "thread/turns/list") {
      if (request.history?.cursor !== null) {
        return;
      }
      const threadId = request.history?.threadId ?? null;
      const result = mcpResult(message);
      const ids = turnIds(result?.data);
      if (threadId !== null && ids !== null) {
        this.recentTurnIds.get(socket)?.set(threadId, new Set(ids));
      }
      return;
    }
    if (
      request.method !== "thread/read" &&
      request.method !== "thread/resume" &&
      request.method !== "thread/fork" &&
      request.method !== "thread/rollback"
    ) {
      return;
    }
    const result = mcpResult(message);
    const thread = isRecord(result?.thread) ? result.thread : null;
    const ids = turnIds(thread?.turns);
    if (thread !== null && typeof thread.id === "string" && ids !== null) {
      this.recentTurnIds.get(socket)?.set(thread.id, new Set(ids));
    }
  }

  private removeSocketRequests(
    requests: Map<string, OutstandingRequest>,
    socket: BrowserSocket,
  ): void {
    for (const [key, target] of requests) {
      if (target.socket === socket) {
        requests.delete(key);
      }
    }
  }

  private pruneExpiredRequests(): void {
    const cutoff = Date.now() - OUTSTANDING_REQUEST_TTL_MS;
    for (const requests of [this.mainRequests, this.rendererRequests]) {
      for (const [key, request] of requests) {
        if (request.createdAt <= cutoff) {
          requests.delete(key);
        }
      }
    }
  }

  private send(socket: BrowserSocket, message: unknown): boolean {
    if (socket.readyState !== OPEN_SOCKET_STATE) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
}
