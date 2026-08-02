#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R100_PROFILE_MENU_CONTRACT = Object.freeze({
  predecessor_index_sha256: "4d2a99f1e45f2145aea2023b8602b533b0e22093e0a51abc2c832faff2b41f59",
  predecessor_panel_name: "router-account-panel-d562ebb2.js",
  predecessor_panel_sha256: "d562ebb2617c2dd5abee9dc9933275eb6f2ece54f8612b41959de725574fdfbe",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-559921ae.js",
  replacement_panel_sha256: "559921aef674c12d7f84279c6153d58b8abe0635a64ae6d9ab786499159a3bcd",
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
      throw new Error("R100 profile menu replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R100 profile menu replacement command is incomplete");
  }
  return options;
}

export function replaceR100RouterProfileMenu(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R100_PROFILE_MENU_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR100RouterProfileMenu(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
