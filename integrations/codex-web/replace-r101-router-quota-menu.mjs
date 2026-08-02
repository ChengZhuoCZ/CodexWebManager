#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R101_QUOTA_MENU_CONTRACT = Object.freeze({
  predecessor_index_sha256: "3d868b8b58ef8e936e082c481305aeb77a81978623e58063c5f6816309e37ab6",
  predecessor_panel_name: "router-account-panel-559921ae.js",
  predecessor_panel_sha256: "559921aef674c12d7f84279c6153d58b8abe0635a64ae6d9ab786499159a3bcd",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-fb575a57.js",
  replacement_panel_sha256: "fb575a578aedb851e7892be7b1a98e0fc529352e7fd3199c2947acae5688e468",
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
      throw new Error("R101 quota menu replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R101 quota menu replacement command is incomplete");
  }
  return options;
}

export function replaceR101RouterQuotaMenu(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R101_QUOTA_MENU_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR101RouterQuotaMenu(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
