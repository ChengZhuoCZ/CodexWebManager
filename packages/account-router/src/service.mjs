import http from "node:http";
import { assertLoopbackHost, defaults, parsePort } from "./config.mjs";
import { createHealthHandler } from "./http-handler.mjs";

const SERVICE_STATES = Object.freeze({
  CREATED: "created",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
});
const DEFAULT_LISTENER_START_DEADLINE_MS = 5_000;
const MAX_LISTENER_START_DEADLINE_MS = 60_000;

export function assertListenerStartDeadline(deadlineMs) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_LISTENER_START_DEADLINE_MS
  ) {
    throw new Error("listener start deadline must be an integer from 1 through 60000");
  }
  return deadlineMs;
}

export function assertListenerStartSignal(signal) {
  if (
    signal !== null &&
    (
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("listener start signal is invalid");
  }
  return signal;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("listener start aborted");
}

export function listenWithDeadline(server, {
  port,
  host,
  signal = null,
  deadlineMs = DEFAULT_LISTENER_START_DEADLINE_MS,
} = {}) {
  if (
    server === null ||
    typeof server !== "object" ||
    typeof server.once !== "function" ||
    typeof server.off !== "function" ||
    typeof server.listen !== "function"
  ) {
    throw new TypeError("listener server is invalid");
  }
  const parentSignal = assertListenerStartSignal(signal);
  assertListenerStartDeadline(deadlineMs);
  const controller = parentSignal === null ? new AbortController() : null;
  const activeSignal = parentSignal ?? controller.signal;
  const deadlineError = new Error("listener start deadline exceeded");
  const timer = controller === null
    ? null
    : setTimeout(() => controller.abort(deadlineError), deadlineMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      server.off("listening", onListening);
      activeSignal.removeEventListener("abort", onAbort);
      if (timer !== null) clearTimeout(timer);
      callback(value);
    };
    const onError = (error) => {
      finish(reject, error);
    };
    const onListening = () => {
      finish(resolve);
    };
    const onAbort = () => {
      finish(reject, abortReason(activeSignal));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    activeSignal.addEventListener("abort", onAbort, { once: true });
    if (activeSignal.aborted) {
      onAbort();
      return;
    }
    try {
      server.listen({ port, host, signal: activeSignal });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createRouterService({
  adminHost = defaults.adminHost,
  adminPort = defaults.adminPort,
  startDeadlineMs = DEFAULT_LISTENER_START_DEADLINE_MS,
  getUsableAccountCount = () => 0,
  adminHandler = null,
} = {}) {
  const host = assertLoopbackHost(adminHost);
  const port = parsePort(adminPort);
  const listenerStartDeadlineMs = assertListenerStartDeadline(startDeadlineMs);
  if (adminHandler !== null && typeof adminHandler !== "function") {
    throw new TypeError("adminHandler must be a function");
  }
  const server = http.createServer(
    createHealthHandler({ getUsableAccountCount, fallback: adminHandler }),
  );
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  let state = SERVICE_STATES.CREATED;

  return {
    get state() {
      return state;
    },
    get address() {
      const address = server.address();
      if (!address || typeof address === "string") {
        return null;
      }
      return Object.freeze({ address: address.address, family: address.family, port: address.port });
    },
    async start({ signal = null } = {}) {
      if (state !== SERVICE_STATES.CREATED) {
        throw new Error(`cannot start service from ${state} state`);
      }
      state = SERVICE_STATES.STARTING;
      try {
        await listenWithDeadline(server, {
          port,
          host,
          signal,
          deadlineMs: listenerStartDeadlineMs,
        });
        state = SERVICE_STATES.RUNNING;
        return this.address;
      } catch (error) {
        state = SERVICE_STATES.STOPPED;
        throw error;
      }
    },
    async stop() {
      if (state === SERVICE_STATES.STOPPED) {
        return;
      }
      if (state === SERVICE_STATES.CREATED) {
        state = SERVICE_STATES.STOPPED;
        return;
      }
      if (state === SERVICE_STATES.STOPPING) {
        return;
      }
      state = SERVICE_STATES.STOPPING;
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await close(server);
      state = SERVICE_STATES.STOPPED;
    },
  };
}

export { DEFAULT_LISTENER_START_DEADLINE_MS, SERVICE_STATES };
