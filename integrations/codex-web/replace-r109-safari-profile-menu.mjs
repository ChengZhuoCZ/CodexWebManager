#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R109_SAFARI_PROFILE_MENU_CONTRACT = Object.freeze({
  predecessor_index_sha256: "9e1c07a125878072ea1112c1401d2541295fe8595e2ae0f21ce041365eba11ef",
  predecessor_panel_name: "router-account-panel-8324c7ac.js",
  predecessor_panel_sha256: "8324c7accea08eda67fb023abef04ba100093a88f62755e8f0231f1e89f569b8",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-9dc6748b.js",
  replacement_panel_sha256: "9dc6748baa2a059dd1e4655ef25e2b1ef5fa106e6e1db753e04f0752ecd295f5",
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
      throw new Error("R109 Safari profile-menu option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R109 Safari profile-menu command is incomplete");
  }
  return options;
}

export function replaceR109SafariProfileMenu(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R109_SAFARI_PROFILE_MENU_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR109SafariProfileMenu(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
