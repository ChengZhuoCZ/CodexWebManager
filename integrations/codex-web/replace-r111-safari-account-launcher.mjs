#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R111_SAFARI_ACCOUNT_LAUNCHER_CONTRACT = Object.freeze({
  predecessor_index_sha256: "5c74320da619209813e0883a90ab7744864ad2aff886dde44ac7ac5ccfbf9e7f",
  predecessor_panel_name: "router-account-panel-23e50032.js",
  predecessor_panel_sha256: "23e5003262db751be029f0a1b32c8945601d1536d8beda8d7457a83367c1d4fe",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-2043970f.js",
  replacement_panel_sha256: "2043970fdfe436b46f900e7041e8d8c4cbdce019db551b2b0f1517e09013b88a",
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
      throw new Error("R111 Safari account-launcher option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R111 Safari account-launcher command is incomplete");
  }
  return options;
}

export function replaceR111SafariAccountLauncher(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R111_SAFARI_ACCOUNT_LAUNCHER_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR111SafariAccountLauncher(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
