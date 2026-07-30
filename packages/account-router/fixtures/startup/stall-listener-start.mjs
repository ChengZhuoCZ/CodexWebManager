import http from "node:http";

if (process.env.CODEX_ROUTER_TEST_STALL_LISTENER_START !== "1") {
  throw new Error("synthetic listener-start stall is not enabled");
}

const createServer = http.createServer.bind(http);
let markerWritten = false;

http.createServer = (...arguments_) => {
  const server = createServer(...arguments_);
  server.listen = () => {
    if (!markerWritten) {
      markerWritten = true;
      process.stdout.write('{"event":"fixture_listener_start_stalled"}\n');
    }
    return server;
  };
  return server;
};
