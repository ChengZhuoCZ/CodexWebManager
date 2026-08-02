#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R99_PROFILE_MENU_CONTRACT = Object.freeze({
  predecessor_index_sha256: "ea7d3df45107de1d3326643cff399b4f4d76483e4d4d771e1bed0844261f8b09",
  predecessor_panel_name: "router-account-panel-9db9de1e.js",
  predecessor_panel_sha256: "9db9de1e0f47a36888ef74fb0a30f5bad52ab31768bd96824131bfca80e21ab2",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-d562ebb2.js",
  replacement_panel_sha256: "d562ebb2617c2dd5abee9dc9933275eb6f2ece54f8612b41959de725574fdfbe",
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
      throw new Error("R99 profile menu replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R99 profile menu replacement command is incomplete");
  }
  return options;
}

export function replaceR99RouterProfileMenu(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R99_PROFILE_MENU_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR99RouterProfileMenu(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
