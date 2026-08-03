#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceStandaloneRouterPanel } from "./replace-standalone-router-panel.mjs";

export const R114_NATIVE_PROFILE_MENU_CONTRACT = Object.freeze({
  predecessor_index_sha256: "2791f3ad2fa2d761a0484cdb6ae595965dd7d3dc4c222b6b01d76509e86656bf",
  predecessor_panel_name: "router-account-panel-8a5b3659.js",
  predecessor_panel_sha256: "8a5b36594e6fd0c1dce9601d02ddefaa2ba0dc52a14babc2e3d9bd90fee1487d",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-0f9f3a68.js",
  replacement_panel_sha256: "0f9f3a68fd6e26b1070b98ae04df5d044c4b954d1e550b4dbad3c0f32eb19f17",
});

function parseArguments(values) {
  const options = {};
  const names = new Map([["--candidate", "candidate"], ["--panel-module", "panelModule"]]);
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (!key || typeof value !== "string" || options[key] !== undefined) {
      throw new Error("R114 native profile-menu option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R114 native profile-menu command is incomplete");
  }
  return options;
}

export function replaceR114NativeProfileMenu(options) {
  return replaceStandaloneRouterPanel({ ...options, contract: R114_NATIVE_PROFILE_MENU_CONTRACT });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR114NativeProfileMenu(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
