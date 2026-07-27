import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadTestMatrix,
  validateTestMatrix,
} from "../scripts/run-test-matrix.mjs";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const packageDirectory = path.resolve(testDirectory, "..");
const matrixPath = path.join(packageDirectory, "test-matrix.json");
const requiredFaults = [
  "quota",
  "http_429",
  "auth",
  "network",
  "upstream_5xx",
  "malformed_sse",
];

test("matrix classifies every Node test exactly once and declares all release-gate suites", async () => {
  const matrix = await loadTestMatrix(matrixPath);
  assert.deepEqual(matrix.suites.map(({ id }) => id), ["unit", "integration", "e2e"]);
  assert.deepEqual(
    matrix.e2e_smoke_scenarios.map(({ id, scenario }) => ({ id, scenario })),
    [
      { id: "codex_web_ui_active", scenario: "active" },
      { id: "codex_web_ui_exhausted", scenario: "exhausted" },
      { id: "codex_web_ui_disabled", scenario: "disabled" },
    ],
  );

  const declared = matrix.suites.flatMap(({ test_files: files }) => files);
  assert.equal(new Set(declared).size, declared.length);
  const actual = (await fs.readdir(testDirectory))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `test/${name}`)
    .sort();
  assert.deepEqual([...declared].sort(), actual);
});

test("matrix binds every required failure to an executable named test and both SSE boundaries", async () => {
  const matrix = await loadTestMatrix(matrixPath);
  assert.deepEqual(Object.keys(matrix.failure_injections), requiredFaults);
  for (const [fault, injection] of Object.entries(matrix.failure_injections)) {
    assert.equal(injection.test_file, "test/failure-injection-matrix.test.mjs", fault);
    const source = await fs.readFile(path.join(packageDirectory, injection.test_file), "utf8");
    assert.ok(source.includes(`test("${injection.test_name}"`), fault);
  }
  assert.deepEqual(Object.keys(matrix.sse_safety_boundaries), [
    "before_semantic_output",
    "after_semantic_output",
  ]);
  for (const boundary of Object.values(matrix.sse_safety_boundaries)) {
    const source = await fs.readFile(path.join(packageDirectory, boundary.test_file), "utf8");
    assert.ok(source.includes(`test("${boundary.test_name}"`));
  }
});

test("matrix validation rejects omitted suites, duplicate files, and incomplete fault coverage", async () => {
  const matrix = await loadTestMatrix(matrixPath);
  assert.throws(
    () => validateTestMatrix({ ...matrix, suites: matrix.suites.slice(0, 2) }),
    /suite ids/,
  );
  assert.throws(
    () => validateTestMatrix({
      ...matrix,
      suites: matrix.suites.map((suite, index) => index === 1
        ? { ...suite, test_files: [...suite.test_files, matrix.suites[0].test_files[0]] }
        : suite),
    }),
    /exactly one suite/,
  );
  const incomplete = { ...matrix.failure_injections };
  delete incomplete.malformed_sse;
  assert.throws(
    () => validateTestMatrix({ ...matrix, failure_injections: incomplete }),
    /failure injection ids/,
  );
});

test("matrix runner fails closed before executing tests when a private summary path is absent", () => {
  const result = spawnSync(process.execPath, ["scripts/run-test-matrix.mjs"], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /absolute --summary path/);
  assert.doesNotMatch(result.stderr, /token|cookie|authorization|credential/i);
});
