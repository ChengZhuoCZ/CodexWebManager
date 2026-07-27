#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, "../..");
const defaultPolicyPath = path.join(packageDirectory, "security-audit.json");
const controlIds = [
  "logs",
  "crash_dumps",
  "api_responses",
  "ui",
  "admin_authorization",
  "path_and_open_proxy",
  "ssrf_boundary",
];
const testPathPattern = /^test\/[a-z0-9-]+\.test\.mjs$/;
const repositoryPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const forbiddenBasenames = new Set([
  ".env",
  "auth.json",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);
const forbiddenExtensionPattern = /\.(?:core|crash|dmp|key|p12|pfx|pem)$/i;
const secretRules = [
  {
    id: "known_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
  },
  {
    id: "private_key",
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    id: "bearer_value",
    pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{12,}=*)/gi,
    valueGroup: 1,
  },
  {
    id: "sensitive_assignment",
    pattern:
      /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie)\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
    valueGroup: 1,
  },
];

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRepositoryPath(value) {
  return typeof value === "string" && repositoryPathPattern.test(value);
}

function validateTestFiles(value, label) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some((entry) => typeof entry !== "string" || !testPathPattern.test(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} test reference is invalid`);
  }
}

export function validateSecurityAuditPolicy(policy) {
  if (
    !plainObject(policy) ||
    policy.schema_version !== 1 ||
    policy.task !== "M6.3" ||
    !Number.isSafeInteger(policy.max_file_bytes) ||
    policy.max_file_bytes < 1_024 ||
    policy.max_file_bytes > 16 * 1024 * 1024 ||
    !Array.isArray(policy.ignored_paths) ||
    policy.ignored_paths.some((entry) => !validRepositoryPath(entry)) ||
    !Array.isArray(policy.synthetic_markers) ||
    policy.synthetic_markers.length < 1 ||
    policy.synthetic_markers.some((entry) => typeof entry !== "string" || entry.length < 4)
  ) {
    throw new Error("security audit policy envelope is invalid");
  }
  if (
    !plainObject(policy.controls) ||
    JSON.stringify(Object.keys(policy.controls)) !== JSON.stringify(controlIds)
  ) {
    throw new Error(`security control ids must be exactly ${controlIds.join(", ")}`);
  }
  for (const [id, control] of Object.entries(policy.controls)) {
    if (!plainObject(control) || Object.keys(control).length !== 1) {
      throw new Error(`${id} control is invalid`);
    }
    validateTestFiles(control.test_files, id);
  }
  validateTestFiles(policy.audit_test_files, "audit");
  const baseline = policy.strict_ci_baseline;
  if (
    !plainObject(baseline) ||
    !validRepositoryPath(baseline.evidence_file) ||
    !/^[0-9a-f]{40}$/.test(baseline.head_sha) ||
    !Array.isArray(baseline.protected_paths) ||
    baseline.protected_paths.length < 1 ||
    baseline.protected_paths.some((entry) => !validRepositoryPath(entry))
  ) {
    throw new Error("strict CI baseline is invalid");
  }
  return policy;
}

export async function loadSecurityAuditPolicy(policyPath = defaultPolicyPath) {
  if (typeof policyPath !== "string" || !path.isAbsolute(policyPath)) {
    throw new Error("security audit policy path must be absolute");
  }
  let text;
  try {
    text = await fs.readFile(policyPath, "utf8");
  } catch {
    throw new Error("security audit policy is unavailable");
  }
  if (Buffer.byteLength(text) > 128 * 1024) {
    throw new Error("security audit policy is too large");
  }
  try {
    return validateSecurityAuditPolicy(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("security audit policy JSON is invalid");
    throw error;
  }
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function isSynthetic(value, markers) {
  const normalized = value.toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

export function scanTextForSecrets(relativePath, text, policy) {
  if (!validRepositoryPath(relativePath) || typeof text !== "string") {
    throw new Error("secret scan input is invalid");
  }
  const markers = Array.isArray(policy?.synthetic_markers) ? policy.synthetic_markers : [];
  const findings = [];
  for (const rule of secretRules) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match !== null; match = rule.pattern.exec(text)) {
      const value = match[rule.valueGroup ?? 0];
      if (rule.valueGroup !== undefined && isSynthetic(value, markers)) continue;
      findings.push(Object.freeze({
        path: relativePath,
        line: lineNumber(text, match.index),
        rule: rule.id,
      }));
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
  return findings;
}

function git(arguments_, options = {}) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("repository metadata is unavailable");
  return result.stdout;
}

async function repositoryFiles() {
  const output = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "buffer",
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

export async function scanRepository(policy) {
  validateSecurityAuditPolicy(policy);
  const ignored = new Set(policy.ignored_paths);
  const findings = [];
  let filesScanned = 0;
  for (const relativePath of await repositoryFiles()) {
    if (!validRepositoryPath(relativePath)) {
      findings.push({ path: "[invalid-path]", line: 0, rule: "unsafe_path" });
      continue;
    }
    if ([...ignored].some((prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
      continue;
    }
    const basename = path.posix.basename(relativePath);
    if (forbiddenBasenames.has(basename) || forbiddenExtensionPattern.test(basename)) {
      findings.push({ path: relativePath, line: 0, rule: "forbidden_secret_file" });
      continue;
    }
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      findings.push({ path: relativePath, line: 0, rule: "non_regular_file" });
      continue;
    }
    if (stat.size > policy.max_file_bytes) {
      findings.push({ path: relativePath, line: 0, rule: "oversized_unscanned_file" });
      continue;
    }
    const bytes = await fs.readFile(absolutePath);
    if (bytes.includes(0)) {
      findings.push({ path: relativePath, line: 0, rule: "binary_unscanned_file" });
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      findings.push({ path: relativePath, line: 0, rule: "invalid_utf8_unscanned_file" });
      continue;
    }
    filesScanned += 1;
    findings.push(...scanTextForSecrets(relativePath, text, policy));
  }
  return Object.freeze({
    files_scanned: filesScanned,
    findings: Object.freeze(findings),
  });
}

function tapCount(output, label) {
  const match = new RegExp(`^# ${label} ([0-9]+)$`, "m").exec(output);
  if (!match) throw new Error("security test summary is unavailable");
  return Number(match[1]);
}

function runSecurityTests(testFiles) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...testFiles],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60_000,
    },
  );
  if (result.error?.code === "ETIMEDOUT") throw new Error("security tests timed out");
  const output = result.stdout ?? "";
  const summary = {
    test_files: testFiles.length,
    tests: tapCount(output, "tests"),
    passed: tapCount(output, "pass"),
    failed: tapCount(output, "fail"),
    skipped: tapCount(output, "skipped"),
  };
  if (
    result.status !== 0 ||
    summary.failed !== 0 ||
    summary.skipped !== 0 ||
    summary.passed !== summary.tests
  ) {
    throw new Error("security tests failed");
  }
  return summary;
}

async function verifyStrictCiBaseline(baseline) {
  const evidence = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, baseline.evidence_file), "utf8"),
  );
  if (
    evidence.conclusion !== "success" ||
    evidence.head_sha !== baseline.head_sha ||
    !Array.isArray(evidence.jobs) ||
    evidence.jobs.length < 2 ||
    evidence.jobs.some((job) =>
      job.conclusion !== "success" ||
      job.failed !== 0 ||
      job.skipped !== 0 ||
      job.passed !== job.tests)
  ) {
    throw new Error("strict CI baseline is not qualified");
  }
  const changed = git([
    "diff",
    "--name-only",
    baseline.head_sha,
    "--",
    ...baseline.protected_paths,
  ]).trim();
  if (changed !== "") throw new Error("strict CI protected paths changed after qualification");
  return {
    evidence_file: baseline.evidence_file,
    head_sha: baseline.head_sha,
    jobs: evidence.jobs.length,
    tests: evidence.jobs.reduce((total, job) => total + job.tests, 0),
    passed: evidence.jobs.reduce((total, job) => total + job.passed, 0),
    failed: 0,
    skipped: 0,
    protected_paths_unchanged: true,
  };
}

function parseArguments(argv) {
  let summaryPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--summary" && argv[index + 1] !== undefined) {
      summaryPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("unsupported security audit option");
  }
  if (typeof summaryPath !== "string" || !path.isAbsolute(summaryPath)) {
    throw new Error("an absolute --summary path is required");
  }
  return { summaryPath };
}

async function writePrivateJson(destination, value) {
  const parent = path.dirname(destination);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("security summary directory is invalid");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, destination);
  await fs.chmod(destination, 0o600);
}

async function run() {
  const { summaryPath } = parseArguments(process.argv.slice(2));
  const policy = await loadSecurityAuditPolicy();
  const [scan, strictCi] = await Promise.all([
    scanRepository(policy),
    verifyStrictCiBaseline(policy.strict_ci_baseline),
  ]);
  const tests = runSecurityTests(policy.audit_test_files);
  const revision = git(["rev-parse", "HEAD"]).trim();
  const summary = {
    schema_version: 1,
    task: "M6.3",
    generated_at: new Date().toISOString(),
    input_revision: revision,
    branch: git(["branch", "--show-current"]).trim(),
    implementation_mode: "clean-room",
    qualified: scan.findings.length === 0,
    secret_scan: scan,
    focused_security_tests: tests,
    strict_ui_evidence: strictCi,
    controls: Object.fromEntries(
      Object.entries(policy.controls).map(([id, control]) => [
        id,
        { qualified: true, test_files: control.test_files },
      ]),
    ),
    real_account_configured: false,
    account_switch_tested: false,
    seamless_account_continuity_claimed: false,
  };
  await writePrivateJson(summaryPath, summary);
  if (!summary.qualified) throw new Error("repository secret scan failed");
  process.stdout.write("security audit passed\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : "security audit failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
