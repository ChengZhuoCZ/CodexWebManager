import { promises as fs } from "node:fs";

const stalledPath = process.env.CODEX_ROUTER_TEST_STALLED_ACCOUNTS_FILE;
const originalOpen = fs.open.bind(fs);

fs.open = (...arguments_) => {
  if (arguments_[0] !== stalledPath) {
    return originalOpen(...arguments_);
  }
  process.stdout.write('{"event":"fixture_runtime_load_stalled"}\n');
  return new Promise(() => {});
};
