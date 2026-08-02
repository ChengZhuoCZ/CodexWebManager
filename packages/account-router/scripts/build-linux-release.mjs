#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const TAR_BLOCK_SIZE = 512;
const MAX_TAR_NUMBER = 0o77777777777;
const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeSourceDateEpoch(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_TAR_NUMBER) {
    throw new Error(`source date epoch must be an integer from 0 to ${MAX_TAR_NUMBER}`);
  }
  return parsed;
}

function assertArchitecture(architecture) {
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error("architecture must be x64 or arm64");
  }
}

function writeText(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) {
    throw new Error(`tar header field is too long: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) {
    throw new Error(`tar numeric field is too large: ${value}`);
  }
  writeText(buffer, offset, length, `${encoded}\0`);
}

function splitTarPath(entryPath) {
  const direct = Buffer.byteLength(entryPath);
  if (direct <= 100) {
    return { name: entryPath, prefix: "" };
  }

  for (let index = entryPath.lastIndexOf("/"); index > 0; index = entryPath.lastIndexOf("/", index - 1)) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`tar path is too long: ${entryPath}`);
}

function createTarHeader(entry, sourceDateEpoch) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(entry.path);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.content.length);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, entry.type === "directory" ? "5" : "0");
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "root");
  writeText(header, 297, 32, "root");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeText(header, 345, 155, prefix);

  const checksum = header.reduce((total, byte) => total + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeText(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function directoryEntriesFor(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file.path);
    while (directory !== ".") {
      directories.add(`${directory}/`);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories]
    .sort(compareAscii)
    .map((directoryPath) => ({
      path: directoryPath,
      type: "directory",
      mode: 0o755,
      content: Buffer.alloc(0),
    }));
}

function createTar(entries, sourceDateEpoch) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(createTarHeader(entry, sourceDateEpoch));
    if (entry.content.length > 0) {
      chunks.push(entry.content);
      const paddingLength =
        (TAR_BLOCK_SIZE - (entry.content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      if (paddingLength > 0) {
        chunks.push(Buffer.alloc(paddingLength));
      }
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createDeterministicGzip(content) {
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])];
  for (let offset = 0; offset < content.length; offset += 0xffff) {
    const length = Math.min(0xffff, content.length - offset);
    const final = offset + length === content.length;
    const header = Buffer.alloc(5);
    header[0] = final ? 0x01 : 0x00;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE((~length) & 0xffff, 3);
    chunks.push(header, content.subarray(offset, offset + length));
  }

  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(content), 0);
  trailer.writeUInt32LE(content.length >>> 0, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

function readNullTerminatedText(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readOctal(buffer, offset, length) {
  const text = readNullTerminatedText(buffer, offset, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

export function readLinuxReleaseArchive(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const expectedChecksum = readOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((total, byte) => total + byte, 0);
    if (actualChecksum !== expectedChecksum) {
      throw new Error("tar header checksum mismatch");
    }

    const name = readNullTerminatedText(header, 0, 100);
    const prefix = readNullTerminatedText(header, 345, 155);
    const entryPath = prefix === "" ? name : `${prefix}/${name}`;
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const contentOffset = offset + TAR_BLOCK_SIZE;
    const content = Buffer.from(tar.subarray(contentOffset, contentOffset + size));
    entries.push({
      path: entryPath,
      type: typeFlag === "5" ? "directory" : "file",
      mode: readOctal(header, 100, 8),
      content,
    });
    offset = contentOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return entries;
}

function launcher(relativeEntrypoint) {
  return Buffer.from(`#!/bin/sh
set -eu
release_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "\${NODE_BINARY:-node}" "$release_root/${relativeEntrypoint}" "$@"
`);
}

function installer({ architecture, releaseName, version }) {
  const machineArchitecture = architecture === "x64" ? "x86_64" : "aarch64";
  return Buffer.from(`#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "This release can only be installed on Linux." >&2
  exit 1
fi
if [ "$(uname -m)" != "${machineArchitecture}" ]; then
  echo "This release requires Linux ${machineArchitecture}." >&2
  exit 1
fi

node_binary=\${NODE_BINARY:-node}
"$node_binary" -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { process.exit(1); }' || {
  echo "Node.js 22 or newer is required." >&2
  exit 1
}

release_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=\${PREFIX:-/opt/codex-account-router}
case "$prefix" in
  /*) ;;
  *) echo "PREFIX must be an absolute path." >&2; exit 1 ;;
esac

umask 022
releases="$prefix/releases"
target="$releases/${releaseName}"
staging="$releases/.${releaseName}.tmp.$$"
temporary_link="$prefix/.current.tmp.$$"
cleanup() {
  rm -rf -- "$staging"
  rm -f -- "$temporary_link"
}
trap cleanup EXIT HUP INT TERM
mkdir -p -- "$releases"

if [ -e "$target" ]; then
  if ! cmp -s -- "$release_root/manifest.json" "$target/manifest.json"; then
    echo "Existing ${version} release does not match this artifact." >&2
    exit 1
  fi
else
  mkdir -- "$staging"
  cp -R -- "$release_root/." "$staging/"
  mv -- "$staging" "$target"
fi

ln -s -- "releases/${releaseName}" "$temporary_link"
mv -Tf -- "$temporary_link" "$prefix/current"
trap - EXIT HUP INT TERM
printf '%s\n' "Installed ${releaseName} at $target"
`);
}

async function fileEntry(relativePath, sourcePath, mode = 0o644) {
  return {
    path: relativePath,
    type: "file",
    mode,
    content: await fs.readFile(sourcePath),
  };
}

async function runtimePackageEntry(releaseName) {
  const packageDocument = JSON.parse(
    await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  if (
    Object.keys(packageDocument.dependencies ?? {}).length > 0 ||
    Object.keys(packageDocument.optionalDependencies ?? {}).length > 0
  ) {
    throw new Error("the headless release does not permit production package dependencies");
  }
  const runtimeDocument = {
    name: packageDocument.name,
    version: packageDocument.version,
    type: "module",
    description: packageDocument.description,
    engines: packageDocument.engines,
    exports: packageDocument.exports,
    bin: packageDocument.bin,
    release: releaseName,
  };
  return Buffer.from(`${JSON.stringify(runtimeDocument, null, 2)}\n`);
}

async function collectPayload({ architecture, releaseName, version }) {
  const payload = [
    {
      path: "bin/codex-account-router",
      type: "file",
      mode: 0o755,
      content: launcher("lib/account-router/src/main.mjs"),
    },
    {
      path: "bin/codex-router-cli",
      type: "file",
      mode: 0o755,
      content: launcher("lib/account-router/bin/codex-router-cli.mjs"),
    },
    {
      path: "bin/codex-router-account",
      type: "file",
      mode: 0o755,
      content: launcher("lib/account-router/bin/codex-router-account.mjs"),
    },
    {
      path: "bin/codex-router-account-manager",
      type: "file",
      mode: 0o755,
      content: launcher("lib/account-router/bin/codex-router-account-manager.mjs"),
    },
    {
      path: "bin/codex-stack-deploy",
      type: "file",
      mode: 0o755,
      content: launcher("lib/account-router/bin/codex-stack-deploy.mjs"),
    },
    {
      path: "install.sh",
      type: "file",
      mode: 0o755,
      content: installer({ architecture, releaseName, version }),
    },
    {
      path: "lib/account-router/package.json",
      type: "file",
      mode: 0o644,
      content: await runtimePackageEntry(releaseName),
    },
    await fileEntry(
      "lib/account-router/bin/codex-router-cli.mjs",
      path.join(PACKAGE_ROOT, "bin/codex-router-cli.mjs"),
      0o755,
    ),
    await fileEntry(
      "lib/account-router/bin/codex-router-account.mjs",
      path.join(PACKAGE_ROOT, "bin/codex-router-account.mjs"),
      0o755,
    ),
    await fileEntry(
      "lib/account-router/bin/codex-router-account-manager.mjs",
      path.join(PACKAGE_ROOT, "bin/codex-router-account-manager.mjs"),
      0o755,
    ),
    await fileEntry(
      "lib/account-router/bin/codex-stack-deploy.mjs",
      path.join(PACKAGE_ROOT, "bin/codex-stack-deploy.mjs"),
      0o755,
    ),
    await fileEntry(
      "share/doc/codex-account-router/README.md",
      path.join(PACKAGE_ROOT, "README.md"),
    ),
    await fileEntry(
      "share/doc/codex-account-router/LICENSE_BOUNDARY.md",
      path.join(REPOSITORY_ROOT, "LICENSE_BOUNDARY.md"),
    ),
  ];

  const sourceDirectory = path.join(PACKAGE_ROOT, "src");
  const sourceFiles = (await fs.readdir(sourceDirectory))
    .filter((fileName) => fileName.endsWith(".mjs"))
    .sort(compareAscii);
  for (const fileName of sourceFiles) {
    payload.push(
      await fileEntry(
        `lib/account-router/src/${fileName}`,
        path.join(sourceDirectory, fileName),
      ),
    );
  }

  const forbiddenPath = payload.find((entry) =>
    /(^|\/)(node_modules|electron)(\/|$)/i.test(entry.path),
  );
  if (forbiddenPath) {
    throw new Error(`desktop or dependency payload is forbidden: ${forbiddenPath.path}`);
  }
  return payload.sort((left, right) => compareAscii(left.path, right.path));
}

async function atomicWrite(filePath, content, mode) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, content, { mode });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, mode);
}

export async function buildLinuxRelease({
  architecture,
  outputDirectory,
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH ?? 0,
}) {
  assertArchitecture(architecture);
  const normalizedEpoch = normalizeSourceDateEpoch(sourceDateEpoch);
  if (typeof outputDirectory !== "string" || outputDirectory.trim() === "") {
    throw new Error("output directory is required");
  }

  const packageDocument = JSON.parse(
    await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  const version = packageDocument.version;
  const releaseName = `codex-account-router-${version}-linux-${architecture}`;
  const payload = await collectPayload({ architecture, releaseName, version });
  const manifest = {
    schema_version: 1,
    name: packageDocument.name,
    version,
    target: { os: "linux", architecture },
    schemas: {
      accounts: 1,
      circuit_state: 1,
    },
    runtime: {
      node: packageDocument.engines.node,
      electron_required: false,
      display_server_required: false,
      native_package_dependencies: [],
    },
    reproducibility: {
      source_date_epoch: normalizedEpoch,
      archive_format: "ustar+gzip-stored",
    },
    files: payload.map((entry) => ({
      path: entry.path,
      mode: entry.mode.toString(8).padStart(4, "0"),
      size: entry.content.length,
      sha256: sha256(entry.content),
    })),
  };
  const manifestEntry = {
    path: "manifest.json",
    type: "file",
    mode: 0o644,
    content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  const rootedFiles = [...payload, manifestEntry]
    .map((entry) => ({ ...entry, path: `${releaseName}/${entry.path}` }))
    .sort((left, right) => compareAscii(left.path, right.path));
  const archiveEntries = [...directoryEntriesFor(rootedFiles), ...rootedFiles].sort((left, right) =>
    compareAscii(left.path, right.path),
  );
  const archive = createDeterministicGzip(createTar(archiveEntries, normalizedEpoch));
  const digest = sha256(archive);
  const resolvedOutput = path.resolve(outputDirectory);
  const artifactPath = path.join(resolvedOutput, `${releaseName}.tar.gz`);
  const checksumPath = `${artifactPath}.sha256`;
  await fs.mkdir(resolvedOutput, { recursive: true });
  await atomicWrite(artifactPath, archive, 0o644);
  await atomicWrite(
    checksumPath,
    Buffer.from(`${digest}  ${path.basename(artifactPath)}\n`),
    0o644,
  );
  return { artifactPath, checksumPath, releaseName, sha256: digest, manifest };
}

function parseArguments(argumentsList) {
  const options = {
    architecture: process.arch,
    outputDirectory: path.join(PACKAGE_ROOT, "dist"),
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? 0,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--arch") {
      options.architecture = argumentsList[++index];
    } else if (argument === "--output") {
      options.outputDirectory = argumentsList[++index];
    } else if (argument === "--source-date-epoch") {
      options.sourceDateEpoch = argumentsList[++index];
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: node scripts/build-linux-release.mjs [options]

Options:
  --arch x64|arm64          Target Linux architecture (default: current Node architecture)
  --output DIRECTORY        Artifact output directory (default: packages/account-router/dist)
  --source-date-epoch EPOCH Reproducible tar timestamp (default: SOURCE_DATE_EPOCH or 0)
  --help                    Show this help
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await buildLinuxRelease(options);
  process.stdout.write(
    `${JSON.stringify({
      event: "linux_release_built",
      target: result.manifest.target,
      artifact: result.artifactPath,
      checksum: result.checksumPath,
      sha256: result.sha256,
    })}\n`,
  );
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`linux release build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
