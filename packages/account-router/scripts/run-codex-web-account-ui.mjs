import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(packageDirectory, "../..");
const panelSource = path.join(workspaceRoot, "integrations", "codex-web", "src", "browser", "router-account-panel.ts");
const codexWebRoot = process.env.M4_3_CODEX_WEB_ROOT;
const evidenceDirectory = process.env.M4_3_EVIDENCE_DIR;
const summaryLog = process.env.M4_3_SUMMARY_LOG;
const scenario = process.env.M4_3_SCENARIO ?? "active";
const mode = process.env.M4_3_MODE ?? "smoke";
const timeoutMs = Number.parseInt(process.env.M4_3_TIMEOUT_MS ?? "180000", 10);

if (
  typeof codexWebRoot !== "string" || !path.isAbsolute(codexWebRoot) ||
  typeof evidenceDirectory !== "string" || !path.isAbsolute(evidenceDirectory) ||
  typeof summaryLog !== "string" || !path.isAbsolute(summaryLog) ||
  !new Set(["active", "exhausted", "disabled"]).has(scenario) ||
  !new Set(["smoke", "serve"]).has(mode) ||
  !Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000
) {
  process.stderr.write(
    "M4_3_CODEX_WEB_ROOT, M4_3_EVIDENCE_DIR, M4_3_SUMMARY_LOG, scenario, mode and a bounded timeout are required\n",
  );
  process.exit(2);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m4-3-account-ui-"));
await fs.chmod(temporaryRoot, 0o700);
await fs.mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await fs.chmod(evidenceDirectory, 0o700);
await fs.writeFile(summaryLog, "", { mode: 0o600 });
await fs.chmod(summaryLog, 0o600);
let summaryPending = Promise.resolve();

function emit(record) {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`;
  process.stdout.write(line);
  summaryPending = summaryPending.then(() => fs.appendFile(summaryLog, line, { mode: 0o600 }));
  return summaryPending;
}

function statusFixture() {
  const exhausted = scenario === "exhausted";
  return {
    status: exhausted ? "degraded" : "ready",
    architecture_mode: "LIMITED_MODE",
    cross_account_e2e_verified: false,
    active_streams: scenario === "active" ? 1 : 0,
    current_route: exhausted ? null : { account_alias: "Fixture A", continuity: "new_backend_session" },
    accounts: [
      {
        alias: "Fixture A",
        state: exhausted ? "quota_exhausted" : "healthy",
        enabled: true,
        weekly_remaining_ratio: exhausted ? 0 : null,
        snapshot_observed_at: "2026-07-16T00:00:00.000Z",
        cooldown_until: null,
        last_switch_reason: exhausted ? "quota_exhausted" : "startup",
      },
      {
        alias: "Fixture B",
        state: exhausted ? "quota_exhausted" : "cooling_down",
        enabled: true,
        weekly_remaining_ratio: exhausted ? 0 : 0.5,
        snapshot_observed_at: "2026-07-16T00:00:00.000Z",
        cooldown_until: exhausted ? null : "2026-07-16T01:00:00.000Z",
        last_switch_reason: exhausted ? "quota_exhausted" : "rate_limited",
      },
    ],
  };
}

async function compilePanel() {
  await fs.writeFile(path.join(temporaryRoot, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
  const build = spawnSync(
    process.execPath,
    [
      path.join(codexWebRoot, "node_modules", "typescript", "bin", "tsc"), panelSource,
      "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
      "--lib", "ES2023,DOM", "--strict", "--skipLibCheck",
      "--rootDir", path.dirname(panelSource), "--outDir", temporaryRoot,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (build.status !== 0) throw new Error("account panel build failed");
  return fs.readFile(path.join(temporaryRoot, "router-account-panel.js"));
}

const panelJavaScript = await compilePanel();
const fixtureHtml = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M4.3 account UI fixture</title><style>body{margin:0;min-height:100vh;background:#f4f4f5;color:#18181b;font:14px system-ui,sans-serif}main{padding:32px}</style></head>
<body><main><h1>Codex Web account panel fixture</h1><p>No real account switch is executed in this fixture.</p></main>
<script type="module">import {installRouterAccountPanel} from "/router-account-panel.js";await installRouterAccountPanel();document.body.dataset.fixtureReady="true";</script></body></html>`);

let statusRequests = 0;
let eventRequests = 0;
let switchRequests = 0;
const eventResponses = new Set();
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixtureHtml);
    return;
  }
  if (request.method === "GET" && url.pathname === "/router-account-panel.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(panelJavaScript);
    return;
  }
  if (request.method === "GET" && url.pathname === "/__backend/codex-router/status") {
    statusRequests += 1;
    response.writeHead(scenario === "disabled" ? 404 : 200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(scenario === "disabled" ? { enabled: false } : { enabled: true, router: statusFixture() }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/__backend/codex-router/events") {
    eventRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive" });
    response.write(": connected\n\n");
    eventResponses.add(response);
    response.once("close", () => eventResponses.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/__backend/codex-router/switch") {
    switchRequests += 1;
    request.resume();
    response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ enabled: true, error: "active_semantic_stream" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}');
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture listener is unavailable");
const origin = `http://127.0.0.1:${address.port}`;
await emit({ event: "fixture_started", origin, mode, scenario, implementation_mode: "clean-room", account_switch_scenario_executed: false });

let stopSignal = "smoke";
if (mode === "smoke") {
  const [page, script, status] = await Promise.all([
    fetch(origin), fetch(`${origin}/router-account-panel.js`), fetch(`${origin}/__backend/codex-router/status`),
  ]);
  if (page.status !== 200 || script.status !== 200 || status.status !== (scenario === "disabled" ? 404 : 200)) {
    throw new Error("fixture smoke check failed");
  }
} else {
  stopSignal = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    timeout.unref();
    const stop = (signal) => { clearTimeout(timeout); resolve(signal); };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    server.once("error", reject);
  });
}

for (const response of eventResponses) response.end();
await new Promise((resolve) => server.close(resolve));
await emit({
  event: "fixture_finished", signal: stopSignal, scenario,
  status_request_count: statusRequests, event_request_count: eventRequests,
  switch_request_count: switchRequests, account_switch_scenario_executed: false,
});
await summaryPending;
await fs.rm(temporaryRoot, { recursive: true, force: true });
