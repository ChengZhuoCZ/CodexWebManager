#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R110_COMPACT_AUTO_FAILOVER_CONTRACT = Object.freeze({
  predecessor_index_sha256: "e177f8f37a19c3a6a803b9b89f41784bb0e8fa2f89147b4ea156cd58a9fa037e",
  predecessor_panel_name: "router-account-panel-9dc6748b.js",
  predecessor_panel_sha256: "9dc6748baa2a059dd1e4655ef25e2b1ef5fa106e6e1db753e04f0752ecd295f5",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-23e50032.js",
  replacement_panel_sha256: "23e5003262db751be029f0a1b32c8945601d1536d8beda8d7457a83367c1d4fe",
});

function parseArguments(values) {
  const options = {};
  const names = new Map([
    ["--candidate", "candidate"],
    ["--panel-module", "panelModule"],
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R110 compact auto-failover option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R110 compact auto-failover command is incomplete");
  }
  return options;
}

export function replaceR110CompactAutoFailover(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R110_COMPACT_AUTO_FAILOVER_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR110CompactAutoFailover(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
