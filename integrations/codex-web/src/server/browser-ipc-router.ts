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

type OutstandingRequest = {
  createdAt: number;
  socket: BrowserSocket;
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

export class BrowserIpcRouter {
  private readonly latestState = new Map<
    string,
    { message: unknown; sequence: number }
  >();
  private readonly mainRequests = new Map<string, OutstandingRequest>();
  private readonly readySockets = new Set<BrowserSocket>();
  private readonly rendererRequests = new Map<string, OutstandingRequest>();
  private readonly sockets = new Set<BrowserSocket>();
  private readonly viewReadySockets = new Set<BrowserSocket>();
  private sequence = 0;

  constructor(
    private readonly authorizeRendererEvent: (message: unknown) => boolean,
  ) {}

  addSocket(socket: BrowserSocket): void {
    this.sockets.add(socket);
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
      this.sequence = 0;
    }
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
      socket,
    });
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
      const target = this.rendererRequests.get(responseKey)?.socket;
      this.rendererRequests.delete(responseKey);
      if (target === undefined) {
        return;
      }
      if (!this.authorizeRendererEvent(message)) {
        const fallback = sanitizedMcpError(message);
        if (fallback !== null) {
          this.send(target, fallback);
        }
        return;
      }
      this.send(target, message);
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
