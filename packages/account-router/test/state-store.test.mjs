import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import { createCircuitStateStore } from "../src/state-store.mjs";

const NOW = Date.parse("2026-07-16T08:00:00.000Z");

async function privateDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-state-"));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function breaker(initialState = undefined) {
  return createCircuitBreaker({ now: () => NOW, initialState });
}

test("atomically persists and restores circuit state across a simulated restart", async (context) => {
  const directory = await privateDirectory(context);
  const store = createCircuitStateStore({ directory });
  const before = breaker();
  before.recordFailure("account-a", { kind: "quota_exhausted" });
  await store.save(before.exportState());

  const path = join(directory, "circuit-state.json");
  const metadata = await lstat(path);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);

  const loaded = await store.load();
  const after = breaker(loaded);
  assert.deepEqual(after.snapshot("account-a"), before.snapshot("account-a"));
  assert.doesNotMatch(JSON.stringify(loaded), /credential|secret|authorization|token|email/i);
});

test("returns null for a missing state file and preserves the last valid file on rejected save", async (context) => {
  const directory = await privateDirectory(context);
  const store = createCircuitStateStore({ directory });
  assert.equal(await store.load(), null);

  const source = breaker();
  source.recordFailure("account-a", { kind: "network_error" });
  const valid = source.exportState();
  await store.save(valid);
  await assert.rejects(
    store.save({ ...valid, credential_ref: "fixture-private-reference" }),
    /state document/,
  );
  assert.deepEqual(await store.load(), valid);
});

test("rejects permissive, symlinked, corrupt, and oversized state files without echoing content", async (context) => {
  const directory = await privateDirectory(context);
  const path = join(directory, "circuit-state.json");
  const store = createCircuitStateStore({ directory, maxBytes: 1_024 });

  await writeFile(path, "{}\n", { mode: 0o644 });
  await assert.rejects(store.load(), /private/);
  await rm(path);

  const target = join(directory, "target.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(store.load(), /symlink/);
  await rm(path);

  const secretCanary = "fixture-corrupt-private-state";
  await writeFile(path, `{not-json:${secretCanary}}`, { mode: 0o600 });
  await assert.rejects(
    store.load(),
    (error) => /invalid state file/.test(error.message) && !error.message.includes(secretCanary),
  );
  await writeFile(path, "x".repeat(2_000), { mode: 0o600 });
  await assert.rejects(store.load(), /too large/);
});

test("rejects unsafe directories and filenames", async (context) => {
  const directory = await privateDirectory(context);
  await chmod(directory, 0o755);
  const store = createCircuitStateStore({ directory });
  await assert.rejects(store.load(), /private/);
  assert.throws(() => createCircuitStateStore({ directory: "relative" }), /absolute/);
  assert.throws(
    () => createCircuitStateStore({ directory, filename: "../escape.json" }),
    /filename/,
  );
});
