import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchR98BrowserSessionAuth,
} from "../../../integrations/codex-web/patch-r98-browser-session-auth.mjs";

const R98_DEPLOY = path.resolve(
  import.meta.dirname,
  "../../../evidence/M6.9/deploy-router-r98-browser-metadata.sh",
);

const PREDECESSOR = [
  "function requestOriginMatches(request, publicOrigin) {",
  "    return request.headers.origin === publicOrigin.origin;",
  "}",
  "function sameOriginFetch(request) {",
  "    return request.headers[\"sec-fetch-site\"] === \"same-origin\";",
  "}",
  "async function register(config, request, session, reply) {",
  "        if (isUnsafeMethod(request.method) &&",
  "            (!requestOriginMatches(request, config.publicOrigin) ||",
  "                !sameOriginFetch(request) ||",
  "                !validCsrfHeader(request, session))) {",
  "            return reply.code(403).send({ error: \"request_forbidden\" });",
  "        }",
  "}",
  "",
].join("\n");

const SUCCESSOR = [
  "function requestOriginMatches(request, publicOrigin) {",
  "    return request.headers.origin === publicOrigin.origin;",
  "}",
  "function sameOriginFetch(request) {",
  "    return request.headers[\"sec-fetch-site\"] === \"same-origin\";",
  "}",
  "function authenticatedRequestMetadataCompatible(request, publicOrigin) {",
  "    const origin = request.headers.origin;",
  "    const fetchSite = request.headers[\"sec-fetch-site\"];",
  "    return ((origin === undefined || origin === publicOrigin.origin) &&",
  "        (fetchSite === undefined || fetchSite === \"same-origin\"));",
  "}",
  "async function register(config, request, session, reply) {",
  "        if (isUnsafeMethod(request.method) &&",
  "            (!authenticatedRequestMetadataCompatible(request, config.publicOrigin) ||",
  "                !validCsrfHeader(request, session))) {",
  "            return reply.code(403).send({ error: \"request_forbidden\" });",
  "        }",
  "}",
  "",
].join("\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r98-session-auth-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "src/server/browser-session-auth.js");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, PREDECESSOR, { mode: 0o644 });
  return {
    root,
    target,
    contract: {
      predecessor_sha256: sha256(PREDECESSOR),
      successor_sha256: sha256(SUCCESSOR),
    },
  };
}

test("R98 accepts omitted browser metadata only behind the existing CSRF boundary", async (context) => {
  const value = await fixture(context);
  const result = await patchR98BrowserSessionAuth({
    candidate: value.root,
    contract: value.contract,
  });
  const output = await fs.readFile(value.target, "utf8");

  assert.equal(output, SUCCESSOR);
  assert.equal(result.event, "r98_browser_session_auth_patched");
  assert.equal(result.strict_explicit_cross_site_rejection_preserved, true);
  assert.equal(result.csrf_required, true);
  assert.match(output, /origin === undefined \|\| origin === publicOrigin\.origin/u);
  assert.match(output, /fetchSite === undefined \|\| fetchSite === "same-origin"/u);
  assert.match(output, /!validCsrfHeader\(request, session\)/u);
  assert.match(output, /return request\.headers\.origin === publicOrigin\.origin/u);
  assert.match(output, /return request\.headers\["sec-fetch-site"\] === "same-origin"/u);
});

test("R98 fails closed before writing when the predecessor changes", async (context) => {
  const value = await fixture(context);
  await fs.appendFile(value.target, "unexpected\n");
  const before = await fs.readFile(value.target);

  await assert.rejects(
    patchR98BrowserSessionAuth({ candidate: value.root, contract: value.contract }),
    /R98 browser session auth patch failed at validate_predecessor/u,
  );
  assert.deepEqual(await fs.readFile(value.target), before);
});

test("R98 deploys only the browser metadata patch and restarts only routed Web", async () => {
  const source = await fs.readFile(R98_DEPLOY, "utf8");

  assert.match(source, /router-r97-xhr-switch-repair/u);
  assert.match(source, /router-r98-browser-metadata/u);
  assert.match(source, /PREDECESSOR_SESSION_AUTH_SHA256=e8d447df/u);
  assert.match(source, /SUCCESSOR_SESSION_AUTH_SHA256=7c5d0bc8/u);
  assert.match(source, /Sec-Fetch-Site: cross-site/u);
  assert.match(source, /explicit_cross_site_rejection_preserved=true/u);
  assert.match(source, /csrf_required=true/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.match(source, /systemctl restart "\$WEB_SERVICE"/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:restart|stop|start)\s+"?\$(?:APP_SERVICE|ROUTER_SERVICE|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)/u,
  );
});
