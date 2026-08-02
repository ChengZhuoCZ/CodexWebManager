#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SESSION_AUTH_RELATIVE = "src/server/browser-session-auth.js";
const SHA256 = /^[a-f0-9]{64}$/u;

export const PINNED_R98_BROWSER_SESSION_AUTH_CONTRACT = Object.freeze({
  predecessor_sha256: "e8d447dfad97ddef264d013d67cebeb867588ff1e24bf40193012b32b528a92c",
  successor_sha256: "7c5d0bc866788ea85f7974a786bf272f24798780b6be73b32969411121f587b6",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

function validateContract(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      ["predecessor_sha256", "successor_sha256"].sort().join(",") ||
    !SHA256.test(value.predecessor_sha256) ||
    !SHA256.test(value.successor_sha256) ||
    value.predecessor_sha256 === value.successor_sha256
  ) {
    throw new Error("R98 browser session auth contract is invalid");
  }
  return Object.freeze({ ...value });
}

function decodeUtf8(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new Error("R98 browser session auth encoding is invalid");
  }
  return value;
}

export function patchSessionAuth(input) {
  const helperAnchor = [
    "function sameOriginFetch(request) {",
    "    return request.headers[\"sec-fetch-site\"] === \"same-origin\";",
    "}",
  ].join("\n");
  const helperReplacement = [
    helperAnchor,
    "function authenticatedRequestMetadataCompatible(request, publicOrigin) {",
    "    const origin = request.headers.origin;",
    "    const fetchSite = request.headers[\"sec-fetch-site\"];",
    "    return ((origin === undefined || origin === publicOrigin.origin) &&",
    "        (fetchSite === undefined || fetchSite === \"same-origin\"));",
    "}",
  ].join("\n");
  const guardAnchor = [
    "        if (isUnsafeMethod(request.method) &&",
    "            (!requestOriginMatches(request, config.publicOrigin) ||",
    "                !sameOriginFetch(request) ||",
    "                !validCsrfHeader(request, session))) {",
  ].join("\n");
  const guardReplacement = [
    "        if (isUnsafeMethod(request.method) &&",
    "            (!authenticatedRequestMetadataCompatible(request, config.publicOrigin) ||",
    "                !validCsrfHeader(request, session))) {",
  ].join("\n");
  if (
    input.split(helperAnchor).length - 1 !== 1 ||
    input.split(guardAnchor).length - 1 !== 1 ||
    input.includes("function authenticatedRequestMetadataCompatible")
  ) {
    throw new Error("R98 browser session auth predecessor changed");
  }
  const output = input
    .replace(helperAnchor, helperReplacement)
    .replace(guardAnchor, guardReplacement);
  if (
    output.split("function authenticatedRequestMetadataCompatible").length - 1 !== 1 ||
    output.split("!authenticatedRequestMetadataCompatible(request, config.publicOrigin)").length - 1 !== 1 ||
    output.split("function requestOriginMatches").length - 1 !== 1 ||
    output.split("function sameOriginFetch").length - 1 !== 1 ||
    !output.includes("!validCsrfHeader(request, session)")
  ) {
    throw new Error("R98 browser session auth successor is invalid");
  }
  return output;
}

async function readRegular(target) {
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
    metadata.size > 2 * 1024 * 1024 || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("R98 browser session auth boundary is invalid");
  }
  return fs.readFile(target);
}

async function writeAtomic(target, bytes) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.next`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function patchR98BrowserSessionAuth({
  candidate,
  contract = PINNED_R98_BROWSER_SESSION_AUTH_CONTRACT,
} = {}) {
  let phase = "validate_options";
  try {
    const candidateRoot = absolutePath(candidate, "candidate release");
    const checked = validateContract(contract);
    const root = await fs.lstat(candidateRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("R98 candidate release boundary is invalid");
    }

    phase = "validate_predecessor";
    const target = path.join(candidateRoot, SESSION_AUTH_RELATIVE);
    const predecessor = await readRegular(target);
    if (sha256(predecessor) !== checked.predecessor_sha256) {
      throw new Error("R98 browser session auth predecessor hash changed");
    }

    phase = "prepare_successor";
    const successor = Buffer.from(patchSessionAuth(decodeUtf8(predecessor)));
    if (sha256(successor) !== checked.successor_sha256) {
      throw new Error("R98 browser session auth successor hash changed");
    }

    phase = "write_successor";
    await writeAtomic(target, successor);
    return Object.freeze({
      event: "r98_browser_session_auth_patched",
      strict_explicit_cross_site_rejection_preserved: true,
      csrf_required: true,
      predecessor_sha256: checked.predecessor_sha256,
      successor_sha256: sha256(successor),
    });
  } catch {
    throw new Error(`R98 browser session auth patch failed at ${phase}`);
  }
}

function parseArguments(values) {
  if (values.length !== 2 || values[0] !== "--candidate") {
    throw new Error("R98 browser session auth command is incomplete");
  }
  return { candidate: values[1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchR98BrowserSessionAuth(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
