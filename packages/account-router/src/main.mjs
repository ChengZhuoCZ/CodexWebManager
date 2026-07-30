import { stringifyLogRecord } from "./redaction.mjs";
import { startRuntimeFromEnvironment } from "./runtime-bootstrap.mjs";

let runtime;
let stopping = false;
let stopPromise = null;
const startupController = new AbortController();

function writeLog(stream, record) {
  stream.write(`${stringifyLogRecord(record)}\n`);
}

function stop(signal) {
  if (stopPromise !== null) return stopPromise;
  stopping = true;
  writeLog(process.stdout, { event: "router_stopping", signal });
  startupController.abort(new Error("runtime startup interrupted"));
  stopPromise = (async () => {
    try {
      await runtime?.stop();
      process.exitCode = 0;
    } catch {
      writeLog(process.stderr, { event: "router_stop_failed" });
      process.exitCode = 1;
    }
  })();
  return stopPromise;
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  const { addresses } = await startRuntimeFromEnvironment({
    signal: startupController.signal,
    onRuntimeCreated(createdRuntime) {
      runtime = createdRuntime;
    },
  });
  if (stopping) {
    await stopPromise;
  } else {
    writeLog(process.stdout, {
      event: "router_started",
      bind_address: addresses.admin.address,
      bind_port: addresses.admin.port,
      model_bind_address: addresses.model.address,
      model_bind_port: addresses.model.port,
      architecture_mode: "LIMITED_MODE",
    });
  }
} catch {
  if (stopping) {
    await stopPromise;
  } else {
    writeLog(process.stderr, { event: "router_start_failed" });
    process.exitCode = 1;
  }
}
