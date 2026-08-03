import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertAuthSourceBoundary,
  createManagerProtocolServer,
  isDirectManagerInvocation,
  parseManagerRequest,
} from "../bin/codex-router-account-manager.mjs";

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    socket.once("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
  });
}

test("manager protocol accepts only bounded public metadata and a private auth path", () => {
  const root = "/var/lib/codex-web-router-account-auth";
  assert.deepEqual(parseManagerRequest({
    operation: "enroll",
    source_file: `${root}/operation-1/auth.json`,
    id: "web-0123456789abcdef",
    alias: "Research 2",
  }, root), {
    operation: "enroll",
    sourceFile: `${root}/operation-1/auth.json`,
    id: "web-0123456789abcdef",
    alias: "Research 2",
    priority: 0,
    maxConcurrency: 1,
  });
  assert.deepEqual(parseManagerRequest({ operation: "remove", alias: "Research 2" }, root), {
    operation: "remove",
    alias: "Research 2",
  });
  assert.deepEqual(parseManagerRequest({ operation: "switch", alias: "Research 2" }, root), {
    operation: "switch",
    alias: "Research 2",
  });
  assert.deepEqual(parseManagerRequest({ operation: "observe" }, root), {
    operation: "observe",
  });
  for (const value of [
    { operation: "enroll", source_file: "/tmp/auth.json", id: "x", alias: "X" },
    { operation: "enroll", source_file: `${root}/x/auth.json`, id: "x", alias: "person@example.test" },
    { operation: "enroll", source_file: `${root}/x/other.json`, id: "x", alias: "X" },
    { operation: "remove", alias: "X", token: "forbidden" },
    { operation: "switch", alias: "X", command: "systemctl restart anything" },
    { operation: "observe", alias: "X" },
  ]) assert.throws(() => parseManagerRequest(value, root));
});

test("manager accepts only a same-owner private non-symlink auth source", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-account-source-"));
  const operation = path.join(root, "operation");
  const authFile = path.join(operation, "auth.json");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  await fs.mkdir(operation, { mode: 0o700 });
  await fs.writeFile(authFile, "fixture", { mode: 0o600 });
  await assert.doesNotReject(assertAuthSourceBoundary(root, authFile));
  await fs.chmod(authFile, 0o640);
  await assert.rejects(assertAuthSourceBoundary(root, authFile));
  await fs.chmod(authFile, 0o600);
  const link = path.join(operation, "linked.json");
  await fs.symlink(authFile, link);
  await assert.rejects(assertAuthSourceBoundary(root, link));
});

test("manager recognizes a symlinked release entrypoint", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-account-manager-entrypoint-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = fileURLToPath(new URL("../bin/codex-router-account-manager.mjs", import.meta.url));
  const link = path.join(root, "codex-router-account-manager.mjs");
  await fs.symlink(target, link);
  assert.equal(isDirectManagerInvocation(pathToFileURL(target).href, link), true);
  assert.equal(isDirectManagerInvocation(pathToFileURL(target).href, ""), false);
});

test("manager socket returns only a sanitized operation result", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-account-manager-"));
  const socketPath = path.join(root, "manager.sock");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const server = createManagerProtocolServer({
    sourceRoot: root,
    enroll: async (value) => {
      calls.push(value);
      return { event: "router_account_enrolled", configured_accounts: 3 };
    },
    remove: async (value) => {
      calls.push(value);
      return { event: "router_account_removed", configured_accounts: 2 };
    },
    switchAccount: async (value) => {
      calls.push(value);
      return {
        event: "router_account_switched",
        configured_accounts: 3,
        account_alias: value.alias,
        native_identity_rebound: true,
        web_restart_required: true,
      };
    },
    observe: async (value) => {
      calls.push(value);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        event: "router_account_observer_ready",
        configured_accounts: 3,
        account_alias: "Research 2",
      };
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const sourceFile = path.join(root, "operation", "auth.json");
  const enrolled = await request(socketPath, {
    operation: "enroll",
    source_file: sourceFile,
    id: "web-0123456789abcdef",
    alias: "Research 2",
  });
  const removed = await request(socketPath, { operation: "remove", alias: "Research 2" });
  const switched = await request(socketPath, { operation: "switch", alias: "Research 2" });
  const observed = await request(socketPath, { operation: "observe" });
  assert.deepEqual(enrolled, {
    ok: true,
    event: "router_account_enrolled",
    configured_accounts: 3,
    credentials_exposed: false,
  });
  assert.deepEqual(removed, {
    ok: true,
    event: "router_account_removed",
    configured_accounts: 2,
    credentials_exposed: false,
  });
  assert.deepEqual(switched, {
    ok: true,
    event: "router_account_switched",
    configured_accounts: 3,
    credentials_exposed: false,
    account_alias: "Research 2",
    continuity: "new_backend_session",
    architecture_mode: "LIMITED_MODE",
    native_identity_rebound: true,
    web_restart_required: true,
  });
  assert.deepEqual(observed, {
    ok: true,
    event: "router_account_observer_ready",
    configured_accounts: 3,
    credentials_exposed: false,
    account_alias: "Research 2",
  });
  assert.equal(calls.length, 4);
});

test("manager socket fails closed for malformed and oversized requests", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-account-manager-bad-"));
  const socketPath = path.join(root, "manager.sock");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = createManagerProtocolServer({
    sourceRoot: root,
    enroll: async () => { throw new Error("must not run"); },
    remove: async () => { throw new Error("must not run"); },
    switchAccount: async () => { throw new Error("must not run"); },
    observe: async () => { throw new Error("must not run"); },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  assert.deepEqual(await request(socketPath, { operation: "remove", alias: "person@example.test" }), {
    ok: false,
    error: "account_operation_failed",
  });
});

test("Web manager clients keep the response half of the socket open", async () => {
  const repository = path.resolve(import.meta.dirname, "../../..");
  for (const relative of [
    "integrations/codex-web/src/server/router-status-bridge.ts",
    "integrations/codex-web/router-status-bridge-standalone.js",
    "integrations/codex-web/src/server/router-account-management.ts",
    "integrations/codex-web/router-account-management-standalone.js",
  ]) {
    const source = await fs.readFile(path.join(repository, relative), "utf8");
    assert.match(source, /socket\.once\("connect", \(\) => socket\.write\(/u);
    assert.doesNotMatch(source, /socket\.once\("connect", \(\) => socket\.end\(/u);
  }
});
