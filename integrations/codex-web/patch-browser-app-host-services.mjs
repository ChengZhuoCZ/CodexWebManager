#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

export const APP_HOST_BUNDLE_RELATIVE =
  "scratch/asar/webview/assets/app-initial-BTphDPeq.js";

const APP_HOST_SERVICES_ANCHOR =
  "s6=new class extends R3{#e;get services(){return this.#e}constructor(e){super(),this.#e=e}}({appActions:j5,appUpdates:L5,clientCoordination:V4,downloads:a6})";
const APP_HOST_SERVICES_REPLACEMENT =
  "s6=new class extends R3{#e;get services(){return this.#e}constructor(e){super(),this.#e=e}}({...window.__ELECTRON_SHIM__?.services,appActions:j5,appUpdates:L5,clientCoordination:V4,downloads:a6})";
const APP_HOST_CONNECT_ANCHOR = "async function d6(){var e;u6=function(){";
const APP_HOST_CONNECT_REPLACEMENT =
  "async function d6(){var e;if(window.__ELECTRON_SHIM__!=null){u6=s6,h6=s6.services,h6.devboxService;return}u6=function(){";
const APP_HOST_VERSIONED_URL =
  /\.\/assets\/app-initial-BTphDPeq\.js\?v=[a-f0-9]{16}/gu;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, anchor, replacement) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("browser app host anchor is invalid");
  }
  return (
    source.slice(0, first) + replacement + source.slice(first + anchor.length)
  );
}

export function patchBrowserAppHostSource(source) {
  if (typeof source !== "string" || source.length < 1) {
    throw new Error("browser app host source is invalid");
  }
  const alreadyPatched =
    source.includes(APP_HOST_SERVICES_REPLACEMENT) &&
    source.includes(APP_HOST_CONNECT_REPLACEMENT);
  if (alreadyPatched) {
    if (
      source.includes(APP_HOST_SERVICES_ANCHOR) ||
      source.includes(APP_HOST_CONNECT_ANCHOR)
    ) {
      throw new Error("browser app host source is mixed");
    }
    return Object.freeze({ source, changed: false });
  }
  const withServices = replaceExactlyOnce(
    source,
    APP_HOST_SERVICES_ANCHOR,
    APP_HOST_SERVICES_REPLACEMENT,
  );
  return Object.freeze({
    source: replaceExactlyOnce(
      withServices,
      APP_HOST_CONNECT_ANCHOR,
      APP_HOST_CONNECT_REPLACEMENT,
    ),
    changed: true,
  });
}

export function versionBrowserAppHostIndex(source, version) {
  if (typeof source !== "string" || !/^[a-f0-9]{16}$/u.test(version)) {
    throw new Error("browser app host index input is invalid");
  }
  const matches = [...source.matchAll(APP_HOST_VERSIONED_URL)];
  if (matches.length !== 2) {
    throw new Error("browser app host index anchor is invalid");
  }
  return source.replace(
    APP_HOST_VERSIONED_URL,
    `./assets/app-initial-BTphDPeq.js?v=${version}`,
  );
}

async function writeReleaseFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
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

export async function patchBrowserAppHostServices(root) {
  const target = path.join(root, APP_HOST_BUNDLE_RELATIVE);
  const metadata = await fs.lstat(target);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 16 * 1024 * 1024 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("browser app host bundle boundary is invalid");
  }
  const input = await fs.readFile(target);
  const inputText = input.toString("utf8");
  if (!Buffer.from(inputText).equals(input)) {
    throw new Error("browser app host bundle encoding is invalid");
  }
  const patched = patchBrowserAppHostSource(inputText);
  const output = Buffer.from(patched.source);
  const gzip = gzipSync(output, { level: 9 });
  const brotli = brotliCompressSync(output, {
    params: {
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
  await writeReleaseFile(root, APP_HOST_BUNDLE_RELATIVE, output);
  await writeReleaseFile(root, `${APP_HOST_BUNDLE_RELATIVE}.gz`, gzip);
  await writeReleaseFile(root, `${APP_HOST_BUNDLE_RELATIVE}.br`, brotli);
  return Object.freeze({
    app_host_bundle: path.basename(APP_HOST_BUNDLE_RELATIVE),
    app_host_changed: patched.changed,
    app_host_sha256: sha256(output),
    app_host_version: sha256(output).slice(0, 16),
    app_host_gzip_sha256: sha256(gzip),
    app_host_brotli_sha256: sha256(brotli),
  });
}
