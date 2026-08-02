import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createManagerProtocolServer,
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
  for (const value of [
    { operation: "enroll", source_file: "/tmp/auth.json", id: "x", alias: "X" },
    { operation: "enroll", source_file: `${root}/x/auth.json`, id: "x", alias: "person@example.test" },
    { operation: "enroll", source_file: `${root}/x/other.json`, id: "x", alias: "X" },
    { operation: "remove", alias: "X", token: "forbidden" },
  ]) assert.throws(() => parseManagerRequest(value, root));
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
  assert.equal(calls.length, 2);
});

test("manager socket fails closed for malformed and oversized requests", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-account-manager-bad-"));
  const socketPath = path.join(root, "manager.sock");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = createManagerProtocolServer({
    sourceRoot: root,
    enroll: async () => { throw new Error("must not run"); },
    remove: async () => { throw new Error("must not run"); },
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
