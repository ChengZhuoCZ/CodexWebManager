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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
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
  getUsableAccountCount = () => 0,
} = {}) {
  const host = assertLoopbackHost(adminHost);
  const port = parsePort(adminPort);
  const server = http.createServer(createHealthHandler({ getUsableAccountCount }));
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
    async start() {
      if (state !== SERVICE_STATES.CREATED) {
        throw new Error(`cannot start service from ${state} state`);
      }
      state = SERVICE_STATES.STARTING;
      try {
        await listen(server, port, host);
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
      await close(server);
      state = SERVICE_STATES.STOPPED;
    },
  };
}

export { SERVICE_STATES };
