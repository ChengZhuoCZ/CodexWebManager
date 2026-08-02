#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R105_NATIVE_USAGE_DOM_CONTRACT = Object.freeze({
  predecessor_index_sha256: "eeb15b26ec72cc2df4428fac0e30c9993b7f79d4bbe693539093dc7923ca4720",
  predecessor_panel_name: "router-account-panel-f9d5a01a.js",
  predecessor_panel_sha256: "f9d5a01a6b5c535c3d2f3bcb047464eed7f6d3a9da81977aa2356276de0be3fc",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-673d9a21.js",
  replacement_panel_sha256: "673d9a21fce3b64cea49605958d0d92fd7c4d1974f5f1e3415126a2b6d1f6214",
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
      throw new Error("R105 native-usage DOM replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R105 native-usage DOM replacement command is incomplete");
  }
  return options;
}

export function replaceR105RouterNativeUsageDom(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R105_NATIVE_USAGE_DOM_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR105RouterNativeUsageDom(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
