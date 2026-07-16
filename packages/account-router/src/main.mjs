import { loadRuntimeConfig } from "./config.mjs";
import { stringifyLogRecord } from "./redaction.mjs";
import { createRouterService } from "./service.mjs";

const config = loadRuntimeConfig();
const service = createRouterService(config);
let stopping = false;

function writeLog(stream, record) {
  stream.write(`${stringifyLogRecord(record)}\n`);
}

async function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  writeLog(process.stdout, { event: "router_stopping", signal });
  try {
    await service.stop();
    process.exitCode = 0;
  } catch {
    writeLog(process.stderr, { event: "router_stop_failed" });
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  const address = await service.start();
  writeLog(process.stdout, {
    event: "router_started",
    bind_address: address.address,
    bind_port: address.port,
    architecture_mode: "LIMITED_MODE",
  });
} catch {
  writeLog(process.stderr, { event: "router_start_failed" });
  process.exitCode = 1;
}
