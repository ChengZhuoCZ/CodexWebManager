import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCircuitBreaker } from "../src/circuit-breaker.mjs";
import { circuitStateFromRuntimeState } from "../src/runtime-state.mjs";
import {
  createCircuitStateStore,
  createRoutingStateStore,
} from "../src/state-store.mjs";

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
  const routingStore = createRoutingStateStore({ directory });
  const before = breaker();
  before.recordFailure("account-a", { kind: "quota_exhausted" });
  await store.save({
    ...before.exportState(),
    weekly_quota: [{
      account_id: "account-a",
      observed_at: "2026-07-16T08:00:00.000Z",
      remaining_ratio: 0,
      resets_at: "2026-07-17T08:00:00.000Z",
    }],
  });
  await routingStore.save({
    version: 1,
    saved_at: "2026-07-16T08:00:00.000Z",
    accounts: [],
    routing: {
      current_account_id: "account-a",
      preferred_account_id: "account-a",
    },
  });

  const path = join(directory, "circuit-state.json");
  const metadata = await lstat(path);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  assert.doesNotMatch(await readFile(path, "utf8"), /"routing"/);
  const routingMetadata = await lstat(join(directory, "routing-state.json"));
  assert.equal(routingMetadata.isFile(), true);
  assert.equal(routingMetadata.mode & 0o077, 0);

  const loaded = await store.load();
  const after = breaker(circuitStateFromRuntimeState(loaded));
  assert.deepEqual(after.snapshot("account-a"), before.snapshot("account-a"));
  assert.equal(loaded.weekly_quota[0].remaining_ratio, 0);
  assert.equal(loaded.routing, undefined);
  const loadedRouting = await routingStore.load();
  assert.deepEqual(loadedRouting.routing, {
    current_account_id: "account-a",
    preferred_account_id: "account-a",
  });
  assert.doesNotMatch(
    JSON.stringify({ circuit: loaded, routing: loadedRouting }),
    /credential|secret|authorization|token|email/i,
  );
});

test("returns null for a missing state file and preserves the last valid file on rejected save", async (context) => {
  const directory = await privateDirectory(context);
  const store = createCircuitStateStore({ directory });
  const routingStore = createRoutingStateStore({ directory });
  assert.equal(await store.load(), null);
  assert.equal(await routingStore.load(), null);

  const source = breaker();
  source.recordFailure("account-a", { kind: "network_error" });
  const valid = source.exportState();
  await store.save(valid);
  const validRouting = {
    version: 1,
    saved_at: "2026-07-16T08:00:00.000Z",
    accounts: [],
    routing: {
      current_account_id: "account-a",
      preferred_account_id: "account-a",
    },
  };
  await routingStore.save(validRouting);
  await assert.rejects(
    store.save({ ...valid, credential_ref: "fixture-private-reference" }),
    /state document/,
  );
  await assert.rejects(
    store.save({
      ...valid,
      weekly_quota: [{
        account_id: "account-a",
        observed_at: "2026-07-16T08:00:00.000Z",
        remaining_ratio: 0,
        resets_at: null,
        credential_ref: "fixture-private-reference",
      }],
    }),
    /state document/,
  );
  await assert.rejects(
    store.save({
      ...valid,
      routing: validRouting.routing,
    }),
    /must not contain routing/,
  );
  await assert.rejects(
    routingStore.save({
      ...validRouting,
      routing: {
        current_account_id: "account-a",
        preferred_account_id: "account-a",
        credential_ref: "fixture-private-reference",
      },
    }),
    /state document/,
  );
  await assert.rejects(
    routingStore.save({
      ...validRouting,
      routing: {
        current_account_id: "bad account id",
        preferred_account_id: null,
      },
    }),
    /state document/,
  );
  assert.deepEqual(await store.load(), valid);
  assert.deepEqual(await routingStore.load(), validRouting);
});

test("rejects pre-cancelled private state loads before filesystem access", async (context) => {
  const directory = await privateDirectory(context);
  const circuitStore = createCircuitStateStore({ directory });
  const routingStore = createRoutingStateStore({ directory });
  const cancellation = new Error("fixture startup state load cancelled");
  const controller = new AbortController();
  controller.abort(cancellation);

  await assert.rejects(
    circuitStore.load({ signal: controller.signal }),
    (error) => error === cancellation,
  );
  await assert.rejects(
    routingStore.load({ signal: controller.signal }),
    (error) => error === cancellation,
  );
});

test("prevents a pre-cancelled route save from replacing durable intent", async (context) => {
  const directory = await privateDirectory(context);
  const routingStore = createRoutingStateStore({ directory });
  const initial = {
    version: 1,
    saved_at: "2026-07-16T08:00:00.000Z",
    accounts: [],
    routing: {
      current_account_id: "account-a",
      preferred_account_id: null,
    },
  };
  await routingStore.save(initial);

  const cancellation = new Error("fixture route save cancelled");
  const controller = new AbortController();
  controller.abort(cancellation);
  await assert.rejects(
    routingStore.save({
      ...initial,
      routing: {
        current_account_id: "account-b",
        preferred_account_id: "account-b",
      },
    }, { signal: controller.signal }),
    /fixture route save cancelled/,
  );
  assert.deepEqual(await routingStore.load(), initial);
});

test("runs a synchronous commit guard before replacing durable route intent", async (context) => {
  const directory = await privateDirectory(context);
  const routingStore = createRoutingStateStore({ directory });
  const initial = {
    version: 1,
    saved_at: "2026-07-16T08:00:00.000Z",
    accounts: [],
    routing: {
      current_account_id: "account-a",
      preferred_account_id: null,
    },
  };
  const candidate = {
    ...initial,
    routing: {
      current_account_id: "account-b",
      preferred_account_id: "account-b",
    },
  };
  await routingStore.save(initial);

  const streamRace = new Error("fixture semantic stream race");
  let guardCalls = 0;
  await assert.rejects(
    routingStore.save(candidate, {
      beforeCommit() {
        guardCalls += 1;
        throw streamRace;
      },
    }),
    (error) => error === streamRace,
  );
  assert.equal(guardCalls, 1);
  assert.deepEqual(await routingStore.load(), initial);

  await assert.rejects(
    routingStore.save(candidate, {
      async beforeCommit() {},
    }),
    /beforeCommit hook must be synchronous/,
  );
  assert.deepEqual(await routingStore.load(), initial);
  await assert.rejects(
    routingStore.save(candidate, { beforeCommit: {} }),
    /beforeCommit hook is invalid/,
  );
  assert.deepEqual(await routingStore.load(), initial);
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
