#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R103_RESET_TIME_CONTRACT = Object.freeze({
  predecessor_index_sha256: "817ba085e976df4a912e86e2bc6117a9f1f3f13ebfe9218bf1bf58df1d02a359",
  predecessor_panel_name: "router-account-panel-131a636e.js",
  predecessor_panel_sha256: "131a636e367e5c2e94958bc293e73738a17b2fea2a8d05af07c8dc78bd98c098",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-051747e7.js",
  replacement_panel_sha256: "051747e79df1eda7dbf937ec5b930a7a30aafb97bbafb2a8df09442987fc92cc",
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
      throw new Error("R103 reset-time replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R103 reset-time replacement command is incomplete");
  }
  return options;
}

export function replaceR103RouterResetTime(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R103_RESET_TIME_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR103RouterResetTime(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
