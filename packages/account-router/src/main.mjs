import { loadRuntimeConfig } from "./config.mjs";
import { createRouterService } from "./service.mjs";

const config = loadRuntimeConfig();
const service = createRouterService(config);
let stopping = false;

async function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  process.stdout.write(`${JSON.stringify({ event: "router_stopping", signal })}\n`);
  try {
    await service.stop();
    process.exitCode = 0;
  } catch {
    process.stderr.write(`${JSON.stringify({ event: "router_stop_failed" })}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  const address = await service.start();
  process.stdout.write(
    `${JSON.stringify({
      event: "router_started",
      bind_address: address.address,
      bind_port: address.port,
      architecture_mode: "LIMITED_MODE",
    })}\n`,
  );
} catch {
  process.stderr.write(`${JSON.stringify({ event: "router_start_failed" })}\n`);
  process.exitCode = 1;
}
