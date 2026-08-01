#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyStatusBridge, EXPECTED_CODEX_WEB_REVISION } from "./apply-status-bridge.mjs";
import { buildRoutedWebOverlay } from "./build-routed-overlay.mjs";
import { stageRoutedWebRelease } from "./stage-routed-release.mjs";

const MANIFEST_PATH = fileURLToPath(new URL("./routed-web-overlay-manifest.json", import.meta.url));
const PINNED_BROWSER_INPUT_ROOT = fileURLToPath(
  new URL("./pinned-routed-web-inputs", import.meta.url),
);
const PINNED_BROWSER_INPUTS = Object.freeze([
  Object.freeze({
    path: "scratch/asar/package.json",
    bytes: 5663,
    sha256: "6d704019a44ec7179321be59ac1aee79d5ac96ed5714428fe6ecd6a60a547f38",
  }),
  Object.freeze({
    path: "scratch/asar/.vite/build/preload.js",
    bytes: 3229,
    sha256: "0e27fe62e3ee829b76b7e11ce2e1a8cc917d67f6316311a26159444e8c89d7f5",
  }),
  Object.freeze({
    path: "scratch/asar/webview/index.html",
    bytes: 13748,
    sha256: "a3eb9db8ca315ee8f301e5f26f02bab9c609907bd0a47989bfb961d8ecd181d7",
  }),
]);
const PINNED_BROWSER_OUTPUTS = Object.freeze([
  Object.freeze({
    path: "scratch/asar/webview/assets/preload.js",
    bytes: 361282,
    sha256: "d153ef5adef87db419a7499cd95c01c477d1f5919193398f27f9aed7367047c9",
  }),
]);
const STEP_TIMEOUT_MS = 120_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.normalize(value);
}

function run(executable, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pipeline step timed out"));
    }, STEP_TIMEOUT_MS);
    timer.unref();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error("pipeline step failed"));
    });
  });
}

async function mustNotExist(target) {
  await fs.lstat(target).then(
    () => { throw new Error("pipeline output already exists"); },
    (error) => { if (error?.code !== "ENOENT") throw error; },
  );
}

async function installPinnedBrowserFiles(buildRoot, inputs) {
  for (const input of inputs) {
    const source = path.join(PINNED_BROWSER_INPUT_ROOT, input.path);
    const metadata = await fs.lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== input.bytes ||
        (metadata.mode & 0o022) !== 0) {
      throw new Error("pinned browser build file boundary is invalid");
    }
    const bytes = await fs.readFile(source);
    if (sha256(bytes) !== input.sha256) {
      throw new Error("pinned browser build file digest is invalid");
    }
    const target = path.join(buildRoot, input.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const existing = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error("browser build file target boundary is invalid");
    }
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.next`);
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
      await fs.chmod(temporary, 0o644);
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export async function buildRoutedWebPipeline({ upstream, previous, workRoot, candidate, output } = {}) {
  let workCreated = false;
  let candidateCreated = false;
  let phase = "validate";
  try {
    const upstreamRoot = absolute(upstream, "upstream");
    const previousRoot = absolute(previous, "previous release");
    const buildRoot = absolute(workRoot, "work root");
    const candidateRoot = absolute(candidate, "candidate release");
    const outputFile = absolute(output, "overlay output");
    if (new Set([upstreamRoot, previousRoot, buildRoot, candidateRoot, outputFile]).size !== 5) {
      throw new Error("pipeline paths overlap");
    }
    if (path.dirname(buildRoot) !== os.tmpdir()) {
      throw new Error("work root must be a direct child of the system temporary directory");
    }
    await Promise.all([mustNotExist(buildRoot), mustNotExist(candidateRoot), mustNotExist(outputFile)]);
    phase = "validate_upstream";
    const git = path.join("/usr", "bin", "git");
    await run(git, ["-C", upstreamRoot, "diff", "--quiet", "--exit-code"]);
    const revisionFile = path.join(buildRoot, ".upstream-revision");
    const revisionProcess = await new Promise((resolve, reject) => {
      const child = spawn(git, ["-C", upstreamRoot, "rev-parse", "HEAD"], {
        stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "" },
      });
      let value = "";
      child.stdout.on("data", (chunk) => { value += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(value.trim()) : reject(new Error("revision failed")));
    });
    if (revisionProcess !== EXPECTED_CODEX_WEB_REVISION) throw new Error("upstream revision changed");

    phase = "copy_inputs";
    await fs.mkdir(buildRoot, { mode: 0o700 });
    workCreated = true;
    for (const relativePath of ["package.json", "vite.browser.config.ts"]) {
      await fs.copyFile(path.join(upstreamRoot, relativePath), path.join(buildRoot, relativePath));
    }
    await fs.cp(path.join(upstreamRoot, "src"), path.join(buildRoot, "src"), { recursive: true });
    await fs.cp(path.join(upstreamRoot, "scratch"), path.join(buildRoot, "scratch"), { recursive: true });
    await fs.symlink(path.join(upstreamRoot, "node_modules"), path.join(buildRoot, "node_modules"));
    await fs.writeFile(revisionFile, `${revisionProcess}\n`, { mode: 0o600 });

    phase = "pin_browser_inputs";
    await installPinnedBrowserFiles(buildRoot, PINNED_BROWSER_INPUTS);
    phase = "apply_overlay";
    await applyStatusBridge({ codexWebRoot: buildRoot, revision: revisionProcess });
    phase = "compile_server";
    await run(process.execPath, [path.join(upstreamRoot, "node_modules/typescript/bin/tsc")], {
      cwd: path.join(buildRoot, "src/server"),
    });
    phase = "compile_browser";
    await run(process.execPath, [
      path.join(upstreamRoot, "node_modules/vite/bin/vite.js"), "build", "--config",
      path.join(buildRoot, "vite.browser.config.ts"),
    ], { cwd: buildRoot });
    phase = "pin_browser_output";
    await installPinnedBrowserFiles(buildRoot, PINNED_BROWSER_OUTPUTS);
    phase = "stage_candidate";
    await stageRoutedWebRelease({
      previous: previousRoot,
      candidate: candidateRoot,
      serverBuild: buildRoot,
      browserBuild: buildRoot,
    });
    candidateCreated = true;
    phase = "build_archive";
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    const overlay = await buildRoutedWebOverlay({ candidate: candidateRoot, output: outputFile, manifest });
    return Object.freeze({
      ...overlay,
      upstream_revision: revisionProcess,
      real_model_request_sent: false,
      account_switch_tested: false,
    });
  } catch (error) {
    if (candidateCreated) {
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(output, { force: true }).catch(() => undefined);
    const detail = phase === "build_archive" && /^overlay build failed at [a-z0-9._~/: -]+$/u.test(error?.message)
      ? ` (${error.message})`
      : "";
    throw new Error(`routed Web build pipeline failed at ${phase}${detail}`);
  } finally {
    if (workCreated) await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [upstream, previous, workRoot, candidate, output] = process.argv.slice(2);
  buildRoutedWebPipeline({ upstream, previous, workRoot, candidate, output }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
