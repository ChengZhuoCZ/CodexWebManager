#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceStandaloneRouterPanel,
} from "./replace-standalone-router-panel.mjs";

export const R107_DEVICE_CODE_COPY_CONTRACT = Object.freeze({
  predecessor_index_sha256: "a3109809feaad204f764b98034657ff336438723526402b182a1940c48a0d45a",
  predecessor_panel_name: "router-account-panel-6c92b532.js",
  predecessor_panel_sha256: "6c92b5320a91dcd76508552bb93ab75b1a57cb7dfd98503a5740166ec6cc7b4a",
  qualified_app_sha256: "e2d356e06763a8287003e5a087acb09a09160a1d6bc8fbf9cecccdfdaf82b6b0",
  qualified_preload_name: "preload-65708a1c.js",
  qualified_preload_sha256: "65708a1c2c053568691f6691b76290a6bd07df09ea84ef1186ac77090649fc5a",
  replacement_panel_name: "router-account-panel-8324c7ac.js",
  replacement_panel_sha256: "8324c7accea08eda67fb023abef04ba100093a88f62755e8f0231f1e89f569b8",
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
      throw new Error("R107 device-code copy option is invalid");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 2) {
    throw new Error("R107 device-code copy command is incomplete");
  }
  return options;
}

export function replaceR107DeviceCodeCopy(options) {
  return replaceStandaloneRouterPanel({
    ...options,
    contract: R107_DEVICE_CODE_COPY_CONTRACT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replaceR107DeviceCodeCopy(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
