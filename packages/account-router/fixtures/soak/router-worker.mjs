#!/usr/bin/env node

import { createFailoverStateMachine } from "../../src/failover-state-machine.mjs";
import { createModelProxyService } from "../../src/model-service.mjs";
import { createProxyHandler } from "../../src/proxy-handler.mjs";

const upstreamOrigin = process.env.SOAK_UPSTREAM_ORIGIN;
let origin;
try {
  origin = new URL(upstreamOrigin);
} catch {
  process.stderr.write("soak worker configuration is invalid\n");
  process.exit(2);
}
if (
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  origin.port === "" ||
  origin.pathname !== "/" ||
  origin.search !== "" ||
  origin.hash !== ""
) {
  process.stderr.write("soak worker configuration is invalid\n");
  process.exit(2);
}

const accounts = ["fixture-a", "fixture-b", "fixture-c"];
const failureCounts = Object.fromEntries([
  "quota_exhausted",
  "rate_limited",
  "auth_expired",
  "network_error",
  "upstream_5xx",
  "protocol_error",
].map((kind) => [kind, 0]));
let selections = 0;
let releases = 0;
let activeRequests = 0;
let maximumActiveRequests = 0;
let stopping = false;

const machine = createFailoverStateMachine({
  maxAttempts: 3,
  totalDeadlineMs: 5_000,
  baseBackoffMs: 2,
  maxBackoffMs: 8,
});
const proxy = createProxyHandler({
  async resolveUpstream(_route, selection) {
    selections += 1;
    const accountId = accounts.find((candidate) =>
      !selection.excludeAccountIds.includes(candidate));
    if (!accountId) return null;
    return {
      accountId,
      origin: origin.origin,
      headers: { "x-soak-fixture": accountId },
      release() { releases += 1; },
    };
  },
  failoverStateMachine: machine,
  async onAttemptFailure({ kind }) {
    failureCounts[kind] = (failureCounts[kind] ?? 0) + 1;
  },
  requestBodyLimitBytes: 4 * 1024,
  responseBodyLimitBytes: 64 * 1024,
  upstreamHeadersTimeoutMs: 2_000,
  requestTotalTimeoutMs: 5_000,
});

function enterRequest(response) {
  activeRequests += 1;
  maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
  let finished = false;
  const leave = () => {
    if (finished) return;
    finished = true;
    activeRequests -= 1;
  };
  response.once("finish", leave);
  response.once("close", leave);
}

const wrappedProxy = {
  handleHttp(request, response) {
    enterRequest(response);
    proxy.handleHttp(request, response);
  },
  handleUpgrade(request, socket, head) {
    proxy.handleUpgrade(request, socket, head);
  },
};
const service = createModelProxyService({
  modelHost: "127.0.0.1",
  modelPort: 0,
  proxyHandler: wrappedProxy,
});

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function metrics(requestId) {
  const memory = process.memoryUsage();
  send({
    type: "metrics",
    request_id: requestId,
    memory: {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      external_bytes: memory.external,
    },
    active_requests: activeRequests,
    maximum_active_requests: maximumActiveRequests,
    selections,
    releases,
    failure_counts: { ...failureCounts },
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await service.stop();
  process.exit(0);
}

process.on("message", (message) => {
  if (message?.type === "metrics" && Number.isSafeInteger(message.request_id)) {
    metrics(message.request_id);
  } else if (message?.type === "shutdown") {
    void stop();
  }
});
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("uncaughtException", () => {
  send({ type: "fatal", category: "uncaught_exception" });
  process.exit(1);
});
process.once("unhandledRejection", () => {
  send({ type: "fatal", category: "unhandled_rejection" });
  process.exit(1);
});

try {
  const address = await service.start();
  send({ type: "ready", port: address.port });
  process.stdout.write(`${JSON.stringify({
    event: "soak_router_ready",
    bind_host: "127.0.0.1",
    bind_port: address.port,
    real_account_configured: false,
  })}\n`);
} catch {
  send({ type: "fatal", category: "startup_failure" });
  process.exit(1);
}
