import http from "node:http";
import { assertLoopbackHost, defaults, parsePort } from "./config.mjs";
import {
  assertListenerStartDeadline,
  DEFAULT_LISTENER_START_DEADLINE_MS,
  listenWithDeadline,
  SERVICE_STATES,
} from "./service.mjs";

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export function createModelProxyService({
  modelHost = defaults.modelHost ?? "127.0.0.1",
  modelPort = defaults.modelPort ?? 18_317,
  startDeadlineMs = DEFAULT_LISTENER_START_DEADLINE_MS,
  proxyHandler,
} = {}) {
  const host = assertLoopbackHost(modelHost);
  const port = parsePort(modelPort, "model port");
  const listenerStartDeadlineMs = assertListenerStartDeadline(startDeadlineMs);
  if (
    proxyHandler === null ||
    typeof proxyHandler !== "object" ||
    typeof proxyHandler.handleHttp !== "function" ||
    typeof proxyHandler.handleUpgrade !== "function"
  ) {
    throw new TypeError("proxyHandler must provide handleHttp and handleUpgrade");
  }
  const server = http.createServer((request, response) => proxyHandler.handleHttp(request, response));
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => proxyHandler.handleUpgrade(request, socket, head));
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  let state = SERVICE_STATES.CREATED;

  return {
    get state() { return state; },
    get address() {
      const address = server.address();
      if (!address || typeof address === "string") return null;
      return Object.freeze({ address: address.address, family: address.family, port: address.port });
    },
    async start({ signal = null } = {}) {
      if (state !== SERVICE_STATES.CREATED) {
        throw new Error(`cannot start model service from ${state} state`);
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
      if (state === SERVICE_STATES.STOPPED) return;
      if (state === SERVICE_STATES.CREATED) {
        state = SERVICE_STATES.STOPPED;
        return;
      }
      if (state === SERVICE_STATES.STOPPING) return;
      state = SERVICE_STATES.STOPPING;
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await close(server);
      state = SERVICE_STATES.STOPPED;
    },
  };
}
