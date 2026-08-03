#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const ASSETS_RELATIVE = "scratch/asar/webview/assets";
const APP_INITIAL_NAME = "app-initial-BTphDPeq.js";

export const R129_MATHPROOF_CONTRACT = Object.freeze({
  predecessor_assets_manifest_sha256: "8b3b60ba6abe512145b6d80030092655e575986052de523b21e1bf53daea16a7",
  predecessor_assets_file_count: 4772,
  predecessor_app_initial_name: APP_INITIAL_NAME,
  predecessor_app_initial_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  successor_app_initial_sha256: "30f89afa313226c925e44c4fbfb6518f9c2760eeecc252addc4b0338f0505f7a",
});

const DISABLED_COMMAND_IDS = Object.freeze([
  "globalDictationHold",
  "globalDictationToggle",
  "realtimeVoice",
  "composer.startVoiceMode",
  "realtimeVoice.toggleMicrophoneMute",
  "realtimeVoice.toggleOutputMute",
  "realtimeVoice.endCall",
  "composer.startDictation",
  "composer.captureAppshot",
  "git.createPullRequest",
  "git.openPullRequest",
  "openAvatarOverlay",
  "openBrowserTab",
  "toggleBrowserPanel",
  "focusBrowserAddressBar",
  "navigateBrowserBack",
  "navigateBrowserForward",
  "toggleTraceRecording",
]);

const FEATURE_PATTERNS = Object.freeze([
  /(?:^|[-_])(?:realtime[-_]?voice|voice|dictation|voicemail)(?:[-_.]|$)/iu,
  /(?:^|[-_])(?:computer[-_]?use|browser[-_]?use|record[-_]?and[-_]?replay|trace[-_]?recording|screen[-_]?recording)(?:[-_.]|$)/iu,
  /^(?:browser-sidebar|thread-browser|browser-profile-import|puppet)(?:[-_.]|$)/iu,
  /(?:^|[-_])(?:pet|pets|mascot|spritesheet|mini[-_]?game|gamepad|joystick)(?:[-_.]|$)/iu,
  /^(?:appgen|start-appgen|appshot|appshots|canvas|notebook)(?:[-_.]|$)/iu,
  /^(?:pull-request|git-pull-request|share-invite|referral)(?:[-_.]|$)/iu,
  /(?:^|[-_])team(?:[-_.]|$)/iu,
  /^(?:home-ambient-suggestions|home-suggestion|home-artifact-templates|recommended-skill|codex-home-announcements|knowledge-work-announcement)(?:[-_.]|$)/iu,
  /(?:^|[-_])(?:announcement|onboarding)(?:[-_.]|$)/iu,
]);

const PROOF_LANGUAGE_STEMS = new Set([
  "plaintext", "text", "log", "markdown", "md", "mdx", "latex", "tex", "bibtex",
  "typst", "rst", "asciidoc", "lean", "lean4", "coq", "isabelle", "agda",
  "mathematica", "wolfram", "python", "julia", "r", "matlab", "octave", "sage",
  "haskell", "ocaml", "fsharp", "scheme", "common-lisp", "lisp", "clojure",
  "shellscript", "shellsession", "bash", "powershell", "json", "jsonc", "json5",
  "jsonl", "yaml", "toml", "xml", "csv", "tsv", "sql", "diff", "git-commit",
  "git-rebase", "c", "cpp", "csharp", "java", "javascript", "jsx", "typescript",
  "tsx", "rust", "go", "ruby", "html", "css", "scss", "mermaid", "regex",
  "regexp", "docker", "dockerfile", "make", "cmake", "systemd", "ssh-config",
  "verilog", "system-verilog", "vhdl", "wasm",
]);

const RETAINED_THEME_STEMS = new Set([
  "codex-dark",
  "codex-light",
  "dark-plus",
  "light-plus",
  "github-dark",
  "github-dark-default",
  "github-light",
  "github-light-default",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nameSetSha256(values) {
  return sha256(Buffer.from(`${[...values].sort().join("\n")}\n`));
}

function isCompressed(name) {
  return name.endsWith(".gz") || name.endsWith(".br");
}

function primaryName(name) {
  return name.replace(/\.(?:gz|br)$/u, "");
}

function logicalStem(name) {
  return path.basename(name)
    .replace(/\.map$/u, "")
    .replace(/-[A-Za-z0-9_-]{8}\.js$/u, "")
    .replace(/\.js$/u, "");
}

function matchesDisabledFeature(name) {
  const normalized = primaryName(name).replace(/\.map$/u, "");
  return FEATURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isNonChineseLocale(name, size) {
  if (size < 750_000 || !/^[a-z]{2}(?:-[A-Z0-9]{2,3})?-[A-Za-z0-9_-]+\.js$/u.test(name)) {
    return false;
  }
  return !/^zh-(?:CN|HK|TW)-/u.test(name);
}

function relativeReferences(source) {
  const references = new Set();
  for (const match of source.matchAll(/["'`]\.\/([^"'`?#]+)(?:[?#][^"'`]*)?["'`]/gu)) {
    references.add(match[1]);
  }
  return references;
}

function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\{([^}]*)\}/gu)) {
    for (const entry of match[1].split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const alias = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*|default)$/u);
      const direct = trimmed.match(/^([A-Za-z_$][\w$]*)$/u);
      if (alias) names.add(alias[1]);
      else if (direct) names.add(direct[1]);
      else throw new Error("R129 disabled module export contract changed");
    }
  }
  if (/\bexport\s+default\b/u.test(source)) names.add("default");
  return [...names].sort();
}

function disabledModuleStub(source) {
  const names = exportedNames(source);
  const declaration = "const __r129_disabled=function(){return null};";
  if (names.length === 0) return Buffer.from(`${declaration}export{};\n`);
  return Buffer.from(`${declaration}export{${names.map((name) => `__r129_disabled as ${name}`).join(",")}};\n`);
}

function compress(bytes) {
  return Object.freeze({
    gzip: gzipSync(bytes, { level: 9 }),
    brotli: brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
  });
}

async function replaceRegularFile(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.next`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceTriplet(target, bytes) {
  const compressed = compress(bytes);
  await replaceRegularFile(target, bytes);
  await replaceRegularFile(`${target}.gz`, compressed.gzip);
  await replaceRegularFile(`${target}.br`, compressed.brotli);
}

function removeCommandObject(source, commandId) {
  const anchor = `{id:"${commandId}"`;
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + anchor.length) >= 0) {
    throw new Error(`R129 command anchor changed: ${commandId}`);
  }
  const next = source.indexOf("},{id:", start);
  if (next < 0) throw new Error(`R129 command boundary changed: ${commandId}`);
  return `${source.slice(0, start)}${source.slice(next + 2)}`;
}

function patchAppInitial(bytes) {
  let source = bytes.toString("utf8");
  for (const commandId of DISABLED_COMMAND_IDS) source = removeCommandObject(source, commandId);

  const petMarker = 'id:"codex.profileFooter.showPet"';
  const petMarkerIndex = source.indexOf(petMarker);
  if (petMarkerIndex < 0 || source.indexOf(petMarker, petMarkerIndex + petMarker.length) >= 0) {
    throw new Error("R129 profile pet marker changed");
  }
  const petStart = source.lastIndexOf("d[11]!==g||d[12]!==C?(", petMarkerIndex);
  const petEndAnchor = "):i=d[13]";
  const petEnd = source.indexOf(petEndAnchor, petMarkerIndex);
  if (petStart < 0 || petEnd < 0 || petMarkerIndex - petStart > 1_500 || petEnd - petMarkerIndex > 1_500) {
    throw new Error("R129 profile pet boundary changed");
  }
  source = `${source.slice(0, petStart)}i=null${source.slice(petEnd + petEndAnchor.length)}`;

  const referralGate = "if(h||!0!==p?.should_show)return null;";
  if (source.split(referralGate).length !== 2) throw new Error("R129 referral gate changed");
  source = source.replace(referralGate, "return null;");
  return Buffer.from(source);
}

async function readAssetInventory(assetsRoot) {
  const directory = await fs.lstat(assetsRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("R129 asset directory boundary is invalid");
  }
  const names = (await fs.readdir(assetsRoot)).sort();
  const assets = new Map();
  const manifest = createHash("sha256");
  for (const name of names) {
    const target = path.join(assetsRoot, name);
    const metadata = await fs.lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
      throw new Error("R129 asset input boundary is invalid");
    }
    const bytes = await fs.readFile(target);
    assets.set(name, Object.freeze({ bytes, size: metadata.size }));
    manifest.update(`${sha256(bytes)}  ./${name}\n`);
  }
  return Object.freeze({ assets, manifestSha256: manifest.digest("hex"), names });
}

function classifyAssets(inventory) {
  const primary = new Map([...inventory.assets].filter(([name]) => !isCompressed(name)));
  const sources = new Map(
    [...primary].filter(([name]) => name.endsWith(".js")).map(([name, entry]) => [name, entry.bytes.toString("utf8")]),
  );
  const graph = new Map([...sources].map(([name, source]) => [name, relativeReferences(source)]));
  const directGrammar = new Set(
    [...sources].filter(([, source]) => (
      source.length <= 1_000_000 &&
      source.includes("Object.freeze(JSON.parse") &&
      (source.includes('"scopeName"') || source.includes("'scopeName'")) &&
      /export\{[^}]*\bdefault\b[^}]*\}/u.test(source)
    )).map(([name]) => name),
  );
  const grammar = new Set(directGrammar);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, references] of graph) {
      if (grammar.has(name)) continue;
      const stem = logicalStem(name);
      if ([...references].some((reference) => grammar.has(reference) && logicalStem(reference) === stem)) {
        grammar.add(name);
        changed = true;
      }
    }
  }

  const theme = new Set(
    [...sources].filter(([, source]) => (
      source.length <= 1_000_000 &&
      source.includes("tokenColors") &&
      (source.includes("Object.freeze(JSON.parse") || source.includes("semanticTokenColors")) &&
      /export\{[^}]*\bdefault\b[^}]*\}/u.test(source)
    )).map(([name]) => name),
  );
  changed = true;
  while (changed) {
    changed = false;
    for (const [name, references] of graph) {
      if (theme.has(name)) continue;
      const stem = logicalStem(name);
      if ([...references].some((reference) => theme.has(reference) && logicalStem(reference) === stem)) {
        theme.add(name);
        changed = true;
      }
    }
  }

  const stub = new Set();
  const remove = new Set();
  const orphan = new Set();
  const groups = {
    disabled_feature_modules: 0,
    disabled_feature_static: 0,
    non_chinese_locales: 0,
    uncommon_themes: 0,
    uncommon_grammars: 0,
    orphan_dependencies: 0,
  };
  for (const [name, entry] of primary) {
    if (matchesDisabledFeature(name)) {
      if (name.endsWith(".js")) {
        stub.add(name);
        groups.disabled_feature_modules += entry.size;
      } else {
        remove.add(name);
        groups.disabled_feature_static += entry.size;
      }
      continue;
    }
    if (name.endsWith(".js") && isNonChineseLocale(name, entry.size)) {
      remove.add(name);
      groups.non_chinese_locales += entry.size;
      continue;
    }
    if (theme.has(name) && !RETAINED_THEME_STEMS.has(logicalStem(name))) {
      remove.add(name);
      groups.uncommon_themes += entry.size;
      continue;
    }
    if (grammar.has(name) && !PROOF_LANGUAGE_STEMS.has(logicalStem(name))) {
      remove.add(name);
      groups.uncommon_grammars += entry.size;
    }
  }

  return Object.freeze({ graph, groups: Object.freeze(groups), orphan, primary, remove, stub });
}

function projectedPrimaryBytes(classification, appInitialBytes) {
  let total = 0;
  for (const [name, entry] of classification.primary) {
    if (classification.remove.has(name)) continue;
    if (name === APP_INITIAL_NAME) total += appInitialBytes.length;
    else if (classification.stub.has(name)) total += disabledModuleStub(entry.bytes.toString("utf8")).length;
    else total += entry.size;
  }
  return total;
}

export async function replaceR129MathProofSurface({
  candidate,
  contract = R129_MATHPROOF_CONTRACT,
  dryRun = false,
} = {}) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || typeof dryRun !== "boolean") {
    throw new Error("R129 replacement option is invalid");
  }
  const root = await fs.lstat(candidate);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("R129 candidate root is invalid");
  const assetsRoot = path.join(candidate, ASSETS_RELATIVE);
  const inventory = await readAssetInventory(assetsRoot);
  if (
    inventory.names.length !== contract.predecessor_assets_file_count ||
    inventory.manifestSha256 !== contract.predecessor_assets_manifest_sha256
  ) throw new Error("R129 predecessor asset manifest changed");
  const appInitialEntry = inventory.assets.get(contract.predecessor_app_initial_name);
  if (!appInitialEntry || sha256(appInitialEntry.bytes) !== contract.predecessor_app_initial_sha256) {
    throw new Error("R129 predecessor app initial changed");
  }
  const nextAppInitial = patchAppInitial(appInitialEntry.bytes);
  const nextAppInitialSha256 = sha256(nextAppInitial);
  if (contract.successor_app_initial_sha256 && nextAppInitialSha256 !== contract.successor_app_initial_sha256) {
    throw new Error("R129 successor app initial changed");
  }
  const classification = classifyAssets(inventory);
  if (
    classification.stub.size < 20 || classification.remove.size < 40 ||
    !classification.stub.has("home-ambient-suggestions-content-BxxaJoC6.js") ||
    !classification.stub.has("pull-request-detail-query-tyorX5z0.js") ||
    !classification.stub.has("realtime-voice-launch-surface-C_wjL0B3.js")
  ) throw new Error("R129 disabled surface classification changed");
  const originalPrimaryBytes = [...classification.primary.values()].reduce((total, entry) => total + entry.size, 0);
  const nextPrimaryBytes = projectedPrimaryBytes(classification, nextAppInitial);
  const result = Object.freeze({
    event: dryRun ? "r129_mathproof_surface_planned" : "r129_mathproof_surface_installed",
    predecessor_manifest_sha256: inventory.manifestSha256,
    successor_app_initial_sha256: nextAppInitialSha256,
    original_primary_bytes: originalPrimaryBytes,
    projected_primary_bytes: nextPrimaryBytes,
    projected_primary_bytes_saved: originalPrimaryBytes - nextPrimaryBytes,
    stubbed_module_count: classification.stub.size,
    stubbed_module_names_sha256: nameSetSha256(classification.stub),
    removed_primary_count: classification.remove.size,
    removed_primary_names_sha256: nameSetSha256(classification.remove),
    orphan_dependency_count: classification.orphan.size,
    orphan_dependency_names: [...classification.orphan].sort(),
    groups: classification.groups,
    retained_languages: [...PROOF_LANGUAGE_STEMS].sort(),
    retained_themes: [...RETAINED_THEME_STEMS].sort(),
    retained_locales: ["en (embedded)", "zh-CN", "zh-HK", "zh-TW"],
  });
  if (dryRun) return result;
  if (!contract.successor_app_initial_sha256) throw new Error("R129 successor contract is not pinned");

  await replaceTriplet(path.join(assetsRoot, contract.predecessor_app_initial_name), nextAppInitial);
  for (const name of classification.stub) {
    const entry = inventory.assets.get(name);
    await replaceTriplet(path.join(assetsRoot, name), disabledModuleStub(entry.bytes.toString("utf8")));
    for (const suffix of [".map", ".map.gz", ".map.br"]) {
      await fs.rm(path.join(assetsRoot, `${name}${suffix}`), { force: true });
    }
  }
  for (const name of classification.remove) {
    for (const suffix of ["", ".gz", ".br", ".map", ".map.gz", ".map.br"]) {
      await fs.rm(path.join(assetsRoot, `${name}${suffix}`), { force: true });
    }
  }
  return result;
}

function parseArguments(values) {
  const options = { dryRun: false };
  for (let index = 0; index < values.length;) {
    if (values[index] === "--candidate") {
      options.candidate = values[index + 1];
      index += 2;
    } else if (values[index] === "--dry-run") {
      options.dryRun = true;
      index += 1;
    } else {
      throw new Error("R129 replacement option is invalid");
    }
  }
  if (!options.candidate) throw new Error("R129 replacement command is incomplete");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR129MathProofSurface(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
