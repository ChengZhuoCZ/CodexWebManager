#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R113_NATIVE_SIDEBAR_LAUNCHER_CONTRACT = Object.freeze({
  predecessor_index_sha256: "2791f3ad2fa2d761a0484cdb6ae595965dd7d3dc4c222b6b01d76509e86656bf",
  predecessor_panel_name: "router-account-panel-8a5b3659.js",
  predecessor_panel_sha256: "8a5b36594e6fd0c1dce9601d02ddefaa2ba0dc52a14babc2e3d9bd90fee1487d",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-8102f632.js",
  replacement_panel_sha256: "8102f63226b9b0bdb36a6fd0ec34d9313122aa4b10058ec6c970b5dc9c45c1b7",
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
      throw new Error("R113 native sidebar-launcher option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R113 native sidebar-launcher command is incomplete");
  }
  return options;
}

export function replaceR113NativeSidebarLauncher(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R113_NATIVE_SIDEBAR_LAUNCHER_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR113NativeSidebarLauncher(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
