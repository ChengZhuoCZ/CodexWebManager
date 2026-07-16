import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractsUrl = new URL("../../../contracts/", import.meta.url);

test("admin OpenAPI contract exposes only sanitized LIMITED_MODE fields", async () => {
  const contract = await readFile(new URL("router.openapi.yaml", contractsUrl), "utf8");
  for (const route of ["/v1/status", "/v1/accounts", "/v1/switch", "/v1/events"]) {
    assert.match(contract, new RegExp(`  ${route.replaceAll("/", "\\/")}:`));
  }
  assert.match(contract, /adminToken/);
  assert.match(contract, /cross_account_e2e_verified: \{const: false\}/);
  assert.match(contract, /continuity: \{const: new_backend_session\}/);
  assert.match(contract, /architecture_mode: \{const: LIMITED_MODE\}/);
  assert.doesNotMatch(
    contract,
    /^\s*(?:credential_ref|secret_provider|authorization|email|access_token|refresh_token):/im,
  );
});

test("router switch event contract matches the sanitized event envelope", async () => {
  const contract = JSON.parse(await readFile(new URL("event.schema.json", contractsUrl), "utf8"));
  assert.deepEqual(contract.required, ["id", "type", "timestamp", "data"]);
  assert.equal(contract.$defs.switchData.additionalProperties, false);
  assert.equal(contract.$defs.switchData.properties.continuity.const, "new_backend_session");
  assert.equal(contract.$defs.switchData.properties.architecture_mode.const, "LIMITED_MODE");
  const serialized = JSON.stringify(contract);
  assert.doesNotMatch(serialized, /credential_ref|secret_provider|authorization|email/i);
});
