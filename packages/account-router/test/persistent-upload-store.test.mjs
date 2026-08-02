import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  BROWSER_UPLOAD_LIMITS,
  BrowserUploadStore,
  isBrowserUploadLimitError,
} = require("../../../integrations/codex-web/browser-upload-store-standalone.cjs");

async function privateRoot(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m69-r108-uploads-"));
  await fs.chmod(root, 0o700);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("persistent upload survives session revocation and store restart", async (context) => {
  const root = await privateRoot(context);
  const environment = {
    CODEX_WEB_UPLOAD_ROOT: root,
    CODEX_WEB_UPLOAD_PERSIST: "1",
  };
  const firstStore = await BrowserUploadStore.create(environment);
  const upload = await firstStore.write(
    "session-a",
    Readable.from([Buffer.from("persistent fixture")]),
    "text/plain",
    BROWSER_UPLOAD_LIMITS.requestBytes,
  );
  assert.equal(path.dirname(upload.path), await fs.realpath(root));
  assert.equal((await fs.stat(upload.path)).mode & 0o777, 0o600);
  await firstStore.removeSession("session-a");
  assert.equal(firstStore.find(upload.path, "session-a"), null);
  assert.equal(await fs.readFile(upload.path, "utf8"), "persistent fixture");
  await firstStore.close();
  assert.equal(await fs.readFile(upload.path, "utf8"), "persistent fixture");

  const secondStore = await BrowserUploadStore.create(environment);
  await secondStore.close();
  assert.equal(await fs.readFile(upload.path, "utf8"), "persistent fixture");
});

test("persistent upload rejects unsafe retained entries and removes interrupted partials", async (context) => {
  const root = await privateRoot(context);
  await fs.writeFile(path.join(root, "unexpected-name"), "unsafe", { mode: 0o600 });
  await assert.rejects(
    BrowserUploadStore.create({
      CODEX_WEB_UPLOAD_ROOT: root,
      CODEX_WEB_UPLOAD_PERSIST: "1",
    }),
    /unsafe entry/,
  );
  await fs.rm(path.join(root, "unexpected-name"));
  const store = await BrowserUploadStore.create({
    CODEX_WEB_UPLOAD_ROOT: root,
    CODEX_WEB_UPLOAD_PERSIST: "1",
  });
  await assert.rejects(
    store.write(
      "session-a",
      Readable.from([Buffer.from("four")]),
      "text/plain",
      3,
    ),
    (error) => isBrowserUploadLimitError(error),
  );
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".part")), false);
  await store.close();
});

test("ephemeral mode keeps the existing cleanup contract", async (context) => {
  const root = await privateRoot(context);
  const store = await BrowserUploadStore.create({ CODEX_WEB_UPLOAD_ROOT: root });
  const upload = await store.write(
    "session-a",
    Readable.from([Buffer.from("ephemeral fixture")]),
    "text/plain",
    BROWSER_UPLOAD_LIMITS.requestBytes,
  );
  await store.removeSession("session-a");
  await assert.rejects(fs.stat(upload.path), { code: "ENOENT" });
  await store.close();
  await assert.rejects(fs.stat(store.root), { code: "ENOENT" });
});
