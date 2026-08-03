import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { replaceR129MathProofSurface } from "../../../integrations/codex-web/replace-r129-mathproof-surface.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

const disabledCommands = [
  "globalDictationHold",
  "globalDictationToggle",
  "realtimeVoice",
  "composer.startVoiceMode",
  "realtimeVoice.toggleMicrophoneMute",
  "realtimeVoice.toggleOutputMute",
  "realtimeVoice.endCall",
  "composer.startDictation",
  "composer.captureAppshot",
  "git.createPullRequest",
  "git.openPullRequest",
  "openAvatarOverlay",
  "openBrowserTab",
  "toggleBrowserPanel",
  "focusBrowserAddressBar",
  "navigateBrowserBack",
  "navigateBrowserForward",
  "toggleTraceRecording",
];

function appInitialFixture() {
  const commands = [...disabledCommands, "survivingCommand"]
    .map((id) => `{id:"${id}",enabled:true}`)
    .join(",");
  return Buffer.from(`
const commands=[${commands}];
function profile(d,g,C){let i;d[11]!==g||d[12]!==C?(i={id:"codex.profileFooter.showPet"},d[11]=g,d[12]=C,d[13]=i):i=d[13];return i}
function referral(h,p){if(h||!0!==p?.should_show)return null;return {id:"codex.profileDropdown.inviteFriend"}}
export{commands};
`);
}

async function manifestFor(directory) {
  const names = (await fs.readdir(directory)).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    const bytes = await fs.readFile(path.join(directory, name));
    hash.update(`${digest(bytes)}  ./${name}\n`);
  }
  return { count: names.length, sha256: hash.digest("hex") };
}

async function createFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r129-mathproof-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const assets = path.join(candidate, "scratch/asar/webview/assets");
  await fs.mkdir(assets, { recursive: true });
  const appInitial = appInitialFixture();
  const files = new Map([
    ["app-initial-BTphDPeq.js", appInitial],
    ["home-ambient-suggestions-content-BxxaJoC6.js", Buffer.from('import "./shared-proof-runtime-12345678.js";export{feature as HomeAmbientSuggestionsContent};const feature=()=>"home";')],
    ["pull-request-detail-query-tyorX5z0.js", Buffer.from('import "./private-pr-runtime-12345678.js";const a=()=>"pr";export{a as C,a as n,a as default};')],
    ["realtime-voice-launch-surface-C_wjL0B3.js", Buffer.from('const voice=()=>"voice";export{voice as RealtimeVoiceLaunchSurface};')],
    ["private-pr-runtime-12345678.js", Buffer.from("export const privatePr=true;")],
    ["shared-proof-runtime-12345678.js", Buffer.from("export const proof=true;")],
    ["proof-chat-12345678.js", Buffer.from('import "./shared-proof-runtime-12345678.js";export const chat=true;')],
    ["zh-CN-12345678.js", Buffer.alloc(760_000, 90)],
    ["zh-TW-12345678.js", Buffer.alloc(760_000, 84)],
    ["latex-12345678.js", Buffer.from('const g=Object.freeze(JSON.parse(`{"scopeName":"text.tex.latex"}`));export{g as default};')],
    ["codex-dark-12345678.js", Buffer.from('const t={tokenColors:[],semanticTokenColors:{}};export{t as default};')],
  ]);
  for (let index = 0; index < 17; index += 1) {
    files.set(`voice-disabled-${String(index).padStart(2, "0")}-12345678.js`, Buffer.from(`const x=()=>${index};export{x as n};`));
  }
  for (let index = 0; index < 28; index += 1) {
    files.set(`pet-spritesheet-${String(index).padStart(2, "0")}-12345678.webp`, Buffer.from(`sprite-${index}`));
  }
  for (const locale of ["fr-FR", "de-DE", "ja-JP", "ko-KR", "es-419"]) {
    files.set(`${locale}-12345678.js`, Buffer.alloc(760_000, locale.charCodeAt(0)));
  }
  for (const language of ["abap", "ada", "apl", "cobol", "solidity"]) {
    files.set(`${language}-12345678.js`, Buffer.from(`const g=Object.freeze(JSON.parse(\`{"scopeName":"source.${language}"}\`));export{g as default};`));
  }
  for (const theme of ["ayu-dark", "catppuccin-mocha", "rose-pine", "tokyo-night", "vesper"]) {
    files.set(`${theme}-12345678.js`, Buffer.from("const t={tokenColors:[],semanticTokenColors:{}};export{t as default};"));
  }
  for (const [name, bytes] of files) await fs.writeFile(path.join(assets, name), bytes, { mode: 0o644 });
  const manifest = await manifestFor(assets);
  const contract = {
    predecessor_assets_manifest_sha256: manifest.sha256,
    predecessor_assets_file_count: manifest.count,
    predecessor_app_initial_name: "app-initial-BTphDPeq.js",
    predecessor_app_initial_sha256: digest(appInitial),
    successor_app_initial_sha256: null,
  };
  return { assets, candidate, contract };
}

test("R129 installs a hash-pinned MathProof surface without breaking retained proof assets", async (context) => {
  const previousUmask = process.umask(0o077);
  context.after(() => process.umask(previousUmask));
  const fixture = await createFixture(context);
  const plan = await replaceR129MathProofSurface({
    candidate: fixture.candidate,
    contract: fixture.contract,
    dryRun: true,
  });
  assert.equal(plan.event, "r129_mathproof_surface_planned");
  assert.ok(plan.projected_primary_bytes_saved > 3_800_000);
  assert.ok(plan.stubbed_module_count >= 20);
  assert.ok(plan.removed_primary_count >= 40);

  const result = await replaceR129MathProofSurface({
    candidate: fixture.candidate,
    contract: { ...fixture.contract, successor_app_initial_sha256: plan.successor_app_initial_sha256 },
  });
  assert.equal(result.event, "r129_mathproof_surface_installed");
  const appInitial = await fs.readFile(path.join(fixture.assets, "app-initial-BTphDPeq.js"), "utf8");
  for (const commandId of disabledCommands) assert.doesNotMatch(appInitial, new RegExp(`\\{id:\"${commandId.replaceAll(".", "\\.")}\"`, "u"));
  assert.doesNotMatch(appInitial, /codex\.profileFooter\.showPet/u);
  assert.doesNotMatch(appInitial, /if\(h\|\|!0!==p\?\.should_show\)return null/u);
  assert.match(appInitial, /survivingCommand/u);

  const stubPath = path.join(fixture.assets, "pull-request-detail-query-tyorX5z0.js");
  const stub = await fs.readFile(stubPath);
  assert.match(stub.toString("utf8"), /__r129_disabled as C/u);
  assert.match(stub.toString("utf8"), /__r129_disabled as default/u);
  assert.deepEqual(gunzipSync(await fs.readFile(`${stubPath}.gz`)), stub);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${stubPath}.br`)), stub);
  assert.equal((await fs.lstat(path.join(fixture.assets, "private-pr-runtime-12345678.js"))).isFile(), true);
  assert.equal((await fs.lstat(path.join(fixture.assets, "shared-proof-runtime-12345678.js"))).isFile(), true);

  for (const removed of [
    "fr-FR-12345678.js",
    "abap-12345678.js",
    "ayu-dark-12345678.js",
    "pet-spritesheet-00-12345678.webp",
  ]) await assert.rejects(fs.lstat(path.join(fixture.assets, removed)), /ENOENT/u);
  for (const retained of [
    "zh-CN-12345678.js",
    "zh-TW-12345678.js",
    "latex-12345678.js",
    "codex-dark-12345678.js",
    "proof-chat-12345678.js",
  ]) assert.equal((await fs.lstat(path.join(fixture.assets, retained))).isFile(), true);
});

test("R129 fails closed when the predecessor manifest drifts", async (context) => {
  const fixture = await createFixture(context);
  await fs.appendFile(path.join(fixture.assets, "proof-chat-12345678.js"), "// drift");
  await assert.rejects(
    replaceR129MathProofSurface({ candidate: fixture.candidate, contract: fixture.contract, dryRun: true }),
    /predecessor asset manifest changed/u,
  );
});

test("R129 deployment restarts only routed 8216 Web and protects both account stacks", async () => {
  const deployment = new URL("../../../evidence/M6.9/deploy-router-r129-mathproof-surface.sh", import.meta.url);
  const deploymentPath = fileURLToPath(deployment);
  const source = await fs.readFile(deployment, "utf8");
  const syntax = spawnSync("bash", ["-n", deploymentPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /TRANSFORMER_SHA256=b3007ea39b354d4227af727f726caea745cae7c63c4ac80bcdfd564ecf32fa03/u);
  assert.match(source, /verify_8215/u);
  assert.match(source, /verify_8216_core/u);
  assert.match(source, /active_requests_nonzero/u);
  assert.match(source, /active_streams_nonzero/u);
  assert.match(source, /SESSION_STATUS==="401"/u);
  assert.match(source, /authentication_required/u);
  assert.match(source, /systemctl restart "\$WEB_SERVICE"/u);
  assert.doesNotMatch(source, /systemctl restart "\$(?:ROUTER_SERVICE|MANAGER_SERVICE|APP_SERVICE|STANDALONE_WEB_SERVICE|STANDALONE_APP_SERVICE)"/u);
  assert.match(source, /model_request_sent=false/u);
  assert.match(source, /account_switch_sent=false/u);
  assert.match(source, /semantic_output_replayed=false/u);
});
