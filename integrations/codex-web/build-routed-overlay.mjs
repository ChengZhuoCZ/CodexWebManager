#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const DEFAULT_MANIFEST = fileURLToPath(new URL("./routed-web-overlay-manifest.json", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH = /^(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u;
const BLOCK = 512;

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function octal(buffer, offset, length, value) {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
function header(entry) {
  if (Buffer.byteLength(entry.path) > 100) throw new Error("overlay path is too long");
  const value = Buffer.alloc(BLOCK);
  value.write(entry.path, 0, 100, "utf8");
  octal(value, 100, 8, 0o644);
  octal(value, 108, 8, 0);
  octal(value, 116, 8, 0);
  octal(value, 124, 12, entry.bytes.length);
  octal(value, 136, 12, 0);
  value.fill(0x20, 148, 156);
  value.write("0", 156, 1, "ascii");
  value.write("ustar\0", 257, 6, "ascii");
  value.write("00", 263, 2, "ascii");
  value.write("root", 265, 32, "ascii");
  value.write("root", 297, 32, "ascii");
  octal(value, 329, 8, 0);
  octal(value, 337, 8, 0);
  const checksum = value.reduce((total, byte) => total + byte, 0);
  value.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return value;
}
function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(header(entry), entry.bytes);
    const padding = (BLOCK - entry.bytes.length % BLOCK) % BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}
function validateManifest(value) {
  if (value?.schema_version !== 1 || !Array.isArray(value.files) ||
      value.files.length < 1 || value.files.length > 64) {
    throw new Error("overlay manifest is invalid");
  }
  const seen = new Set();
  for (const entry of value.files) {
    if (Object.keys(entry).join(",") !== "path,sha256" || !SAFE_PATH.test(entry.path) ||
        !SHA256.test(entry.sha256) || seen.has(entry.path)) {
      throw new Error("overlay manifest entry is invalid");
    }
    seen.add(entry.path);
  }
  return value;
}

export async function buildRoutedWebOverlay({ candidate, output, manifest } = {}) {
  let temporary = null;
  let phase = "validate";
  try {
    if (!path.isAbsolute(candidate ?? "") || !path.isAbsolute(output ?? "") || candidate === output) {
      throw new Error("overlay paths are invalid");
    }
    const checked = validateManifest(manifest);
    const root = await fs.lstat(candidate);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("candidate is invalid");
    const entries = [];
    for (const expected of checked.files) {
      phase = expected.path;
      const target = path.join(candidate, expected.path);
      const metadata = await fs.lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
          metadata.size > 64 * 1024 * 1024 || (metadata.mode & 0o022) !== 0) {
        throw new Error("overlay input is invalid");
      }
      const bytes = await fs.readFile(target);
      const actualSha256 = digest(bytes);
      if (actualSha256 !== expected.sha256) {
        phase = `${expected.path}:${actualSha256}`;
        throw new Error("overlay input hash changed");
      }
      entries.push({ path: expected.path, bytes });
    }
    const archive = gzipSync(tar(entries), { level: 9, mtime: 0 });
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
    temporary = path.join(path.dirname(output), `.${path.basename(output)}.${randomUUID()}.next`);
    await fs.writeFile(temporary, archive, { flag: "wx", mode: 0o644 });
    await fs.rename(temporary, output);
    temporary = null;
    return Object.freeze({
      event: "routed_web_overlay_built",
      archive_sha256: digest(archive),
      archive_bytes: archive.length,
      files: entries.length,
    });
  } catch {
    throw new Error(`overlay build failed at ${phase}`);
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidate, output, manifestPath = DEFAULT_MANIFEST] = process.argv.slice(2);
  Promise.all([fs.readFile(manifestPath, "utf8").then(JSON.parse)]).then(
    ([manifest]) => buildRoutedWebOverlay({ candidate, output, manifest }),
  ).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => { process.stderr.write("overlay build failed\n"); process.exitCode = 1; },
  );
}
