import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  createFileSecretProvider,
  createSystemdCredentialSecretProvider,
  defineSecretProvider,
  SecretLease,
  SecretProviderRegistry,
} from "../src/secrets.mjs";

async function temporarySecretDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "account-router-secrets-"));
  await fs.chmod(directory, 0o700);
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("registry supports pluggable providers and disposes leases after use", async () => {
  let acquiredReference = null;
  let lease = null;
  const registry = new SecretProviderRegistry();
  registry.register(
    defineSecretProvider({
      name: "fixture",
      async acquire(reference) {
        acquiredReference = reference;
        lease = SecretLease.fromUtf8("fixture-secret-value");
        return lease;
      },
    }),
  );

  const result = await registry.withSecret("fixture", "slot-a", async (secret) => {
    assert.equal(secret, "fixture-secret-value");
    return "used";
  });
  assert.equal(result, "used");
  assert.equal(acquiredReference, "slot-a");
  assert.equal(lease.disposed, true);
  assert.throws(() => lease.use(() => undefined), /disposed/);
});

test("registry disposes a lease when the consumer throws", async () => {
  let lease;
  const registry = new SecretProviderRegistry();
  registry.register(
    defineSecretProvider({
      name: "fixture",
      async acquire() {
        lease = SecretLease.fromUtf8("fixture-secret-value");
        return lease;
      },
    }),
  );
  await assert.rejects(
    registry.withSecret("fixture", "slot-a", async () => {
      throw new Error("fixture consumer failure");
    }),
    /fixture consumer failure/,
  );
  assert.equal(lease.disposed, true);
});

test("SecretLease redacts string, JSON, and inspection forms", () => {
  const lease = SecretLease.fromUtf8("fixture-secret-value");
  assert.equal(String(lease), "[REDACTED SecretLease]");
  assert.equal(JSON.stringify({ lease }), '{"lease":"[REDACTED SecretLease]"}');
  assert.doesNotMatch(inspect(lease), /fixture-secret-value/);
  assert.match(inspect(lease), /REDACTED/);
  lease.dispose();
});

test("file provider reads a private regular file through a lease", async (context) => {
  const directory = await temporarySecretDirectory(context);
  const secretPath = path.join(directory, "slot-a");
  await fs.writeFile(secretPath, "fixture-file-secret", { mode: 0o600 });
  await fs.chmod(secretPath, 0o600);
  const provider = createFileSecretProvider({ rootDirectory: directory });
  const lease = await provider.acquire("slot-a");
  assert.equal(lease.use((secret) => secret), "fixture-file-secret");
  lease.dispose();
});

test("file provider rejects permissive directory and file modes", async (context) => {
  const directory = await temporarySecretDirectory(context);
  const secretPath = path.join(directory, "slot-a");
  await fs.writeFile(secretPath, "fixture-file-secret", { mode: 0o600 });
  const provider = createFileSecretProvider({ rootDirectory: directory });

  await fs.chmod(secretPath, 0o644);
  await assert.rejects(provider.acquire("slot-a"), /credential file permissions/);
  await fs.chmod(secretPath, 0o600);
  await fs.chmod(directory, 0o755);
  await assert.rejects(provider.acquire("slot-a"), /credential directory permissions/);
});

test("file provider rejects symlinks, traversal, empty, and oversized files", async (context) => {
  const directory = await temporarySecretDirectory(context);
  const target = path.join(directory, "target");
  await fs.writeFile(target, "fixture-file-secret", { mode: 0o600 });
  await fs.symlink(target, path.join(directory, "linked"));
  const provider = createFileSecretProvider({ rootDirectory: directory, maxBytes: 32 });

  await assert.rejects(provider.acquire("linked"), /regular credential file/);
  await assert.rejects(provider.acquire("../target"), /credential reference/);
  await fs.writeFile(path.join(directory, "empty"), "", { mode: 0o600 });
  await assert.rejects(provider.acquire("empty"), /credential file size/);
  await fs.writeFile(path.join(directory, "large"), "x".repeat(33), { mode: 0o600 });
  await assert.rejects(provider.acquire("large"), /credential file size/);
});

test("systemd credential provider is limited to the exact runtime credential directory", () => {
  const credentialsDirectory = "/run/credentials/codex-account-router.service";
  assert.doesNotThrow(() =>
    createSystemdCredentialSecretProvider({
      rootDirectory: credentialsDirectory,
      credentialsDirectory,
    }),
  );
  for (const options of [
    {
      rootDirectory: "/etc/codex-account-router/credentials",
      credentialsDirectory: "/etc/codex-account-router/credentials",
    },
    {
      rootDirectory: credentialsDirectory,
      credentialsDirectory: "/run/credentials/other.service",
    },
    {
      rootDirectory: "/run/credentials/codex-account-router.service/nested",
      credentialsDirectory: "/run/credentials/codex-account-router.service/nested",
    },
  ]) {
    assert.throws(
      () => createSystemdCredentialSecretProvider(options),
      /systemd credential directory/i,
    );
  }
});

test("registry rejects invalid providers and never includes references in lookup errors", async () => {
  const registry = new SecretProviderRegistry();
  assert.throws(() => registry.register({ name: "fixture" }), /provider/);
  registry.register(
    defineSecretProvider({
      name: "fixture",
      async acquire() {
        return SecretLease.fromUtf8("fixture");
      },
    }),
  );
  assert.throws(() => registry.register(defineSecretProvider({ name: "fixture", acquire() {} })), /already registered/);
  const reference = "do-not-echo-this-reference";
  await assert.rejects(registry.acquire("missing", reference), (error) => {
    assert.doesNotMatch(error.message, new RegExp(reference));
    return true;
  });

  const failing = new SecretProviderRegistry();
  failing.register(
    defineSecretProvider({
      name: "fixture",
      async acquire() {
        throw new Error(`upstream mentioned ${reference}`);
      },
    }),
  );
  await assert.rejects(failing.acquire("fixture", "slot-a"), (error) => {
    assert.equal(error.message, "secret provider acquisition failed");
    assert.doesNotMatch(error.message, new RegExp(reference));
    return true;
  });
});
