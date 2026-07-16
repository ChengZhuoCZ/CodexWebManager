import { createObserver } from "./observer.mjs";

const upstreamOrigin = process.env.UPSTREAM_ORIGIN;
const logPath = process.env.OBSERVATION_LOG;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "18319", 10);

if (!upstreamOrigin || !logPath || !Number.isInteger(port)) {
  process.stderr.write("UPSTREAM_ORIGIN, OBSERVATION_LOG, and a valid PORT are required\n");
  process.exitCode = 2;
} else {
  const observer = await createObserver({ upstreamOrigin, logPath, host, port });
  process.stderr.write(
    `${JSON.stringify({ status: "listening", host, port: observer.address?.port, logPath })}\n`,
  );

  const shutdown = async () => {
    await observer.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
