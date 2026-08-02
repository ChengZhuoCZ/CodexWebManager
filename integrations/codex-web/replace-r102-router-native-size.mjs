#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R102_NATIVE_SIZE_CONTRACT = Object.freeze({
  predecessor_index_sha256: "c506a647624fc65d84de7b2209679c08ad7123d9d84999e65bc8f4acdacae03b",
  predecessor_panel_name: "router-account-panel-fb575a57.js",
  predecessor_panel_sha256: "fb575a578aedb851e7892be7b1a98e0fc529352e7fd3199c2947acae5688e468",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-131a636e.js",
  replacement_panel_sha256: "131a636e367e5c2e94958bc293e73738a17b2fea2a8d05af07c8dc78bd98c098",
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
      throw new Error("R102 native-size replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R102 native-size replacement command is incomplete");
  }
  return options;
}

export function replaceR102RouterNativeSize(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R102_NATIVE_SIZE_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR102RouterNativeSize(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
