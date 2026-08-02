#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R104_NATIVE_USAGE_SYNC_CONTRACT = Object.freeze({
  predecessor_index_sha256: "05efce068cbded0a87d73ad43e061064b40383dac33ff28d377f0240b65c66a2",
  predecessor_panel_name: "router-account-panel-051747e7.js",
  predecessor_panel_sha256: "051747e79df1eda7dbf937ec5b930a7a30aafb97bbafb2a8df09442987fc92cc",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-f9d5a01a.js",
  replacement_panel_sha256: "f9d5a01a6b5c535c3d2f3bcb047464eed7f6d3a9da81977aa2356276de0be3fc",
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
      throw new Error("R104 native-usage replacement option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R104 native-usage replacement command is incomplete");
  }
  return options;
}

export function replaceR104RouterNativeUsageSync(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R104_NATIVE_USAGE_SYNC_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR104RouterNativeUsageSync(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
