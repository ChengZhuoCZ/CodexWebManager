import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { localStartupRpcResponse } from "../../../integrations/codex-web-upstream/codex-remote-fastpath.mjs";

const precompressedAssetPatch = new URL(
  "../../../integrations/codex-web-upstream/tailnet-precompressed-asset.patch",
  import.meta.url,
);

test("locally terminates only default empty startup catalog reads", () => {
  const cases = [
    [
      { id: "app-1", method: "app/list", params: { cursor: null, limit: 50 } },
      { data: [], nextCursor: null },
    ],
    [
      { id: 2, method: "mcpServerStatus/list", params: {} },
      { data: [], nextCursor: null },
    ],
    [
      { id: "plugin-3", method: "plugin/list" },
      {
        featuredPluginIds: [],
        marketplaceLoadErrors: [],
        marketplaces: [],
      },
    ],
  ];

  for (const [request, expected] of cases) {
    assert.deepEqual(
      JSON.parse(localStartupRpcResponse(JSON.stringify(request))),
      { id: request.id, result: expected },
    );
  }
});

test("forwards explicit refreshes, thread-scoped reads, and every non-catalog method", () => {
  const forwarded = [
    { id: 1, method: "app/list", params: { forceRefetch: true } },
    { id: 2, method: "app/list", params: { threadId: "thread-fixture" } },
    { id: 3, method: "mcpServerStatus/list", params: { threadId: "thread-fixture" } },
    { id: 4, method: "plugin/list", params: { forceRefetch: true } },
    { id: 5, method: "thread/list", params: {} },
    { id: 6, method: "turn/start", params: { input: "secret-canary" } },
  ];
  for (const request of forwarded) {
    assert.equal(localStartupRpcResponse(JSON.stringify(request)), null);
  }
});

test("fails closed for malformed or oversized input without reflecting it", () => {
  assert.equal(localStartupRpcResponse("not-json"), null);
  assert.equal(
    localStartupRpcResponse(
      JSON.stringify({ id: "x", method: "app/list", params: [] }),
    ),
    null,
  );
  assert.equal(
    localStartupRpcResponse(
      JSON.stringify({ id: "x".repeat(257), method: "app/list", params: {} }),
    ),
    null,
  );
  assert.equal(localStartupRpcResponse("x".repeat(1024 * 1024 + 1)), null);
});

test("precompressed asset patch is limited to the pinned content-hashed bundle", async () => {
  const patch = await readFile(precompressedAssetPatch, "utf8");

  assert.match(patch, /app-initial-BTphDPeq\.js/);
  assert.match(patch, /accept-encoding/);
  assert.match(patch, /Content-Encoding/);
  assert.match(patch, /Vary/);
  assert.match(patch, /immutable/);
  assert.doesNotMatch(patch, /backend-api|responses|Authorization|Cookie/);
});
