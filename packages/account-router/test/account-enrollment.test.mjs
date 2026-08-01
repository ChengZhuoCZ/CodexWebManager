import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  isDirectCliInvocation,
  parseAccountCommand,
} from "../bin/codex-router-account.mjs";
import { createAccountEnrollmentManager } from "../src/account-enrollment.mjs";

function fixtureAuth() {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    tokens: {
      access_token: "fixture-access-token-value",
      account_id: "fixture-upstream-account-id",
      id_token: "fixture-id-token-value",
      refresh_token: "fixture-refresh-token-value",
    },
  };
}

function initialAccounts() {
  return {
    version: 1,
    accounts: [
      {
        id: "primary",
        alias: "Primary",
        enabled: true,
        priority: 100,
        max_concurrency: 1,
        provider: "openai-codex",
        secret_provider: "codex-auth",
        credential_ref: "codex-account-router.auth.primary",
      },
    ],
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-enrollment-"));
  const configDirectory = path.join(root, "config");
  const credentialStoreDirectory = path.join(root, "credstore");
  const sourceDirectory = path.join(root, "source");
  await Promise.all([
    fs.mkdir(configDirectory, { mode: 0o700 }),
    fs.mkdir(credentialStoreDirectory, { mode: 0o700 }),
    fs.mkdir(sourceDirectory, { mode: 0o700 }),
  ]);
  const accountsFile = path.join(configDirectory, "accounts.json");
  const sourceFile = path.join(sourceDirectory, "auth.json");
  await fs.writeFile(accountsFile, `${JSON.stringify(initialAccounts(), null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.writeFile(sourceFile, JSON.stringify(fixtureAuth()), { mode: 0o600 });
  await Promise.all([fs.chmod(accountsFile, 0o600), fs.chmod(sourceFile, 0o600)]);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { accountsFile, credentialStoreDirectory, sourceFile };
}

function enrollment() {
  return {
    sourceFile: undefined,
    id: "secondary",
    alias: "Secondary",
    priority: 90,
    maxConcurrency: 1,
  };
}

test("atomically enrolls a private Codex credential without copying it into public configuration", async (context) => {
  const setup = await fixture(context);
  let restarts = 0;
  const manager = createAccountEnrollmentManager({
    accountsFile: setup.accountsFile,
    credentialStoreDirectory: setup.credentialStoreDirectory,
    restartRouter: async () => {
      restarts += 1;
    },
    routerReady: async () => true,
  });

  const result = await manager.enroll({
    ...enrollment(),
    sourceFile: setup.sourceFile,
  });

  assert.deepEqual(result, {
    event: "router_account_enrolled",
    configured_accounts: 2,
    credentials_exposed: false,
  });
  assert.equal(restarts, 1);

  const document = JSON.parse(await fs.readFile(setup.accountsFile, "utf8"));
  assert.equal(document.accounts.length, 2);
  assert.deepEqual(document.accounts[1], {
    id: "secondary",
    alias: "Secondary",
    enabled: true,
    priority: 90,
    max_concurrency: 1,
    provider: "openai-codex",
    secret_provider: "codex-auth",
    credential_ref: "codex-account-router.auth.secondary",
  });
  const publicText = JSON.stringify(document);
  assert.doesNotMatch(publicText, /access-token|refresh-token|upstream-account-id/);

  const installedCredential = path.join(
    setup.credentialStoreDirectory,
    "codex-account-router.auth.secondary",
  );
  assert.deepEqual(
    await fs.readFile(installedCredential),
    await fs.readFile(setup.sourceFile),
  );
  assert.equal((await fs.stat(installedCredential)).mode & 0o777, 0o600);
});

test("rejects unsafe sources and duplicate public bindings before changing service state", async (context) => {
  const setup = await fixture(context);
  let restarts = 0;
  const manager = createAccountEnrollmentManager({
    accountsFile: setup.accountsFile,
    credentialStoreDirectory: setup.credentialStoreDirectory,
    restartRouter: async () => {
      restarts += 1;
    },
    routerReady: async () => true,
  });
  const original = await fs.readFile(setup.accountsFile);
  const permissive = path.join(path.dirname(setup.sourceFile), "permissive.json");
  const symlink = path.join(path.dirname(setup.sourceFile), "linked.json");
  await fs.writeFile(permissive, JSON.stringify(fixtureAuth()), { mode: 0o644 });
  await fs.chmod(permissive, 0o644);
  await fs.symlink(setup.sourceFile, symlink);

  for (const request of [
    { ...enrollment(), sourceFile: permissive },
    { ...enrollment(), sourceFile: symlink },
    { ...enrollment(), sourceFile: setup.sourceFile, id: "primary" },
    { ...enrollment(), sourceFile: setup.sourceFile, alias: "person@example.test" },
  ]) {
    await assert.rejects(manager.enroll(request), /account enrollment failed/);
  }

  assert.equal(restarts, 0);
  assert.deepEqual(await fs.readFile(setup.accountsFile), original);
  assert.deepEqual(await fs.readdir(setup.credentialStoreDirectory), []);
});

test("rolls back both files when the restarted router does not become ready", async (context) => {
  const setup = await fixture(context);
  const readiness = [false, true];
  let restarts = 0;
  const manager = createAccountEnrollmentManager({
    accountsFile: setup.accountsFile,
    credentialStoreDirectory: setup.credentialStoreDirectory,
    restartRouter: async () => {
      restarts += 1;
    },
    routerReady: async () => readiness.shift() ?? true,
  });
  const original = await fs.readFile(setup.accountsFile);

  await assert.rejects(
    manager.enroll({ ...enrollment(), sourceFile: setup.sourceFile }),
    /account enrollment failed/,
  );

  assert.equal(restarts, 2);
  assert.deepEqual(await fs.readFile(setup.accountsFile), original);
  assert.deepEqual(await fs.readdir(setup.credentialStoreDirectory), []);
});

test("account CLI accepts only public metadata and a private source path", () => {
  assert.deepEqual(
    parseAccountCommand([
      "enroll",
      "--source-file",
      "/private/source/auth.json",
      "--id",
      "secondary",
      "--alias",
      "Secondary",
      "--priority",
      "90",
      "--max-concurrency",
      "2",
    ]),
    {
      command: "enroll",
      sourceFile: "/private/source/auth.json",
      id: "secondary",
      alias: "Secondary",
      priority: 90,
      maxConcurrency: 2,
    },
  );
  for (const argumentsList of [
    ["enroll", "--id", "secondary", "--alias", "Secondary"],
    ["enroll", "--source-file", "/private/auth.json", "--id", "secondary", "--alias"],
    ["enroll", "--source-file", "/private/auth.json", "--id", "secondary", "--alias", "Secondary", "--token", "forbidden"],
    ["enroll", "--source-file", "/private/auth.json", "--id", "secondary", "--alias", "Secondary", "--priority", "1001"],
  ]) {
    assert.throws(() => parseAccountCommand(argumentsList));
  }
});

test("account CLI recognizes a symlinked direct entrypoint", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "router-cli-entrypoint-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "codex-router-account.mjs");
  const symlink = path.join(root, "current-account-cli.mjs");
  await fs.writeFile(target, "// fixture\n", { mode: 0o600 });
  await fs.symlink(target, symlink);

  const targetUrl = pathToFileURL(await fs.realpath(target)).href;
  assert.equal(isDirectCliInvocation(targetUrl, symlink), true);
  assert.equal(isDirectCliInvocation(targetUrl, path.join(root, "missing.mjs")), false);
});
