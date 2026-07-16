#!/usr/bin/env node

import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.144.5-systemd-fixture\n");
  process.exit(0);
}

const appServerIndex = args.indexOf("app-server");
if (appServerIndex === -1) process.exit(64);

let stopping = false;
function exitCleanly() {
  if (stopping) return false;
  stopping = true;
  return true;
}

if (args[appServerIndex + 1] === "proxy") {
  const socketIndex = args.indexOf("--sock", appServerIndex + 2);
  const socketPath = socketIndex === -1 ? undefined : args[socketIndex + 1];
  if (typeof socketPath !== "string" || !socketPath.startsWith("/run/") || !socketPath.endsWith(".sock")) {
    process.exit(64);
  }
  const client = net.createConnection(socketPath);
  client.on("connect", () => client.resume());
  client.on("error", () => {
    if (!stopping) process.exitCode = 69;
  });
  client.on("close", () => {
    if (!stopping) process.exit(process.exitCode ?? 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (!exitCleanly()) return;
      client.destroy();
      process.exit(0);
    });
  }
} else {
  const listenIndex = args.indexOf("--listen", appServerIndex + 1);
  const listen = listenIndex === -1 ? undefined : args[listenIndex + 1];
  const prefix = "unix://";
  if (typeof listen !== "string" || !listen.startsWith(prefix)) process.exit(64);
  const socketPath = listen.slice(prefix.length);
  const home = process.env.CODEX_HOME;
  if (
    !socketPath.startsWith("/run/") ||
    !socketPath.endsWith(".sock") ||
    typeof home !== "string" ||
    !existsSync(path.join(home, "auth.json"))
  ) {
    process.exit(78);
  }

  const markerPath = path.join(path.dirname(socketPath), "proxy-connected");
  await fs.rm(socketPath, { force: true });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    void fs.writeFile(markerPath, "connected\n", { mode: 0o600 });
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) void fs.rm(markerPath, { force: true });
    });
    socket.resume();
  });
  server.on("error", () => {
    process.exitCode = 70;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);

  async function stop() {
    if (!exitCleanly()) return;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([
      fs.rm(socketPath, { force: true }),
      fs.rm(markerPath, { force: true }),
    ]);
    process.exit(0);
  }
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
