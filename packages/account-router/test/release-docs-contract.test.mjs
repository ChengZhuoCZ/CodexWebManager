import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const operatorGuidePath = path.join(repositoryRoot, "docs", "operator-guide.md");
const releaseStatusPath = path.join(repositoryRoot, "docs", "release-status.md");

async function read(pathname) {
  return fs.readFile(pathname, "utf8");
}

test("operator guide covers the complete M6.4 lifecycle without public listeners", async () => {
  const guide = await read(operatorGuidePath);
  for (const heading of [
    "Release boundary",
    "Prerequisites",
    "Install and verify",
    "Configure accounts and credentials",
    "Private remote access",
    "Monitor",
    "Rotate credentials",
    "Backup",
    "Upgrade and rollback",
    "Incident response",
  ]) {
    assert.match(guide, new RegExp(`^## ${heading}$`, "m"), heading);
  }
  for (const required of [
    "127.0.0.1:8214",
    "127.0.0.1:18317",
    "127.0.0.1:18318",
    "/healthz",
    "/readyz",
    "journalctl",
    "systemctl",
    "codex-stack-deploy backup",
    "codex-stack-deploy rollback",
    "ssh -L",
    "LimitCORE=0",
  ]) {
    assert.ok(guide.includes(required), required);
  }
  assert.doesNotMatch(guide, /(?:0\.0\.0\.0|\[::\]):(?:8214|18317|18318)/);
  assert.doesNotMatch(guide, /(?:password|token|authorization)\s*[:=]\s*[A-Za-z0-9._~+/-]{12,}/i);
});

test("release status is fail-closed about skipped and deferred gates", async () => {
  const status = await read(releaseStatusPath);
  assert.match(status, /^# Release status$/m);
  assert.match(status, /not production-release qualified/i);
  assert.match(status, /M6\.2.*rejected/i);
  assert.match(status, /24-hour soak[\s\S]{0,80}not (?:completed|qualified)/i);
  assert.match(status, /real-account.*deferred/i);
  assert.match(status, /LIMITED_MODE/);
  assert.match(status, /new backend session/i);
  assert.doesNotMatch(status, /24-hour soak (?:passed|qualified)/i);
  assert.doesNotMatch(status, /seamless (?:account )?continuity (?:is|has been) (?:verified|proven)/i);
});

test("operator and release docs link the security, license, and detailed Linux runbooks", async () => {
  const combined = `${await read(operatorGuidePath)}\n${await read(releaseStatusPath)}`;
  for (const relativePath of [
    "../SECURITY.md",
    "../LICENSE_BOUNDARY.md",
    "linux-headless-release.md",
    "linux-systemd.md",
    "linux-upgrade-rollback.md",
    "soak-test.md",
  ]) {
    assert.ok(combined.includes(`](${relativePath})`), relativePath);
    await fs.access(path.resolve(path.dirname(operatorGuidePath), relativePath));
  }
});
