import { stringifyLogRecord } from "./redaction.mjs";
import { createRuntimeFromEnvironment } from "./runtime-bootstrap.mjs";

let runtime;
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
    await runtime?.stop();
    process.exitCode = 0;
  } catch {
    writeLog(process.stderr, { event: "router_stop_failed" });
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  runtime = await createRuntimeFromEnvironment();
  const addresses = await runtime.start();
  writeLog(process.stdout, {
    event: "router_started",
    bind_address: addresses.admin.address,
    bind_port: addresses.admin.port,
    model_bind_address: addresses.model.address,
    model_bind_port: addresses.model.port,
    architecture_mode: "LIMITED_MODE",
  });
} catch {
  writeLog(process.stderr, { event: "router_start_failed" });
  process.exitCode = 1;
}
