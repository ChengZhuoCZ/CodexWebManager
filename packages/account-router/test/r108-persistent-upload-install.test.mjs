import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { installPersistentUploads } from "../../../integrations/codex-web/replace-r108-persistent-uploads.mjs";

const temporaryUploadImplementation = "    R107_TEMPORARY_UPLOAD_IMPLEMENTATION";
const fixture = [
  'const node_crypto_1 = require("node:crypto");',
  'const browser_session_auth_1 = require("./browser-session-auth");',
  '    await (0, browser_session_auth_1.registerBrowserSessionAuth)(app, process.env);',
  temporaryUploadImplementation,
].join("\n");

test("R108 replaces the R107 temporary upload path with bounded persistent storage", () => {
  const options = { temporaryUploadImplementation };
  const output = installPersistentUploads(fixture, options);
  assert.match(output, /BrowserUploadStore\.create\(process\.env\)/);
  assert.match(output, /BROWSER_UPLOAD_LIMITS\.requestBytes/);
  assert.match(output, /browserUploadStore\.removeSession/);
  assert.match(output, /createReadStream/);
  assert.doesNotMatch(output, /mkdtemp\([^\n]+codex-web-uploads-/);
  assert.doesNotMatch(output, /\.toBuffer\(\)/);
  assert.throws(
    () => installPersistentUploads(output, options),
    /anchor is unavailable/,
  );
});

test("R108 deployment inputs are scoped to 8216 persistent upload files", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const [webDropIn, appDropIn, storeSource] = await Promise.all([
    fs.readFile(path.join(root, "systemd/8216-fixture/codex-web-router.service.d/upload-persistence.conf"), "utf8"),
    fs.readFile(path.join(root, "systemd/8216-fixture/codex-web-router-app-server.service.d/upload-persistence.conf"), "utf8"),
    fs.readFile(path.join(root, "integrations/codex-web/browser-upload-store-standalone.cjs"), "utf8"),
  ]);
  assert.match(webDropIn, /CODEX_WEB_UPLOAD_ROOT=\/var\/lib\/codex-web-router\/uploads/);
  assert.match(webDropIn, /CODEX_WEB_UPLOAD_PERSIST=1/);
  assert.match(appDropIn, /ReadOnlyPaths=\/var\/lib\/codex-web-router\/uploads/);
  assert.match(storeSource, /globalBytes: 256 \* 1024 \* 1024/);
  assert.doesNotMatch(`${webDropIn}\n${appDropIn}`, /codex-web-upstream|8215/);
});

test("R108 deployment is rollback-capable and leaves 8215, router, and App Server running", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const source = await fs.readFile(
    path.join(root, "evidence/M6.9/deploy-router-r108-persistent-uploads.sh"),
    "utf8",
  );
  assert.match(source, /deployment_status=rolled_back/);
  assert.match(source, /persistent_across_web_restart=true/);
  assert.match(source, /nsenter -t "\$ROUTED_APP_PID_BEFORE" -m/);
  assert.match(source, /standalone_8215_unchanged=true/);
  assert.match(source, /routed_8216_app_server_unchanged=true/);
  assert.match(source, /model_request_sent=false/);
  assert.match(source, /account_switch_sent=false/);
  assert.doesNotMatch(
    source,
    /systemctl (?:restart|stop|start) "?\$(?:APP_SERVICE|ROUTER_SERVICE|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)"?/,
  );
});
