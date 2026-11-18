import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  validateToolParity,
  toolParityCounts,
} from "../check-dual-kernel-parity.mjs";

const CANONICAL_PATH = fileURLToPath(
  new URL("../../packages/shared/src/kernel-contract/tool-parity.json", import.meta.url),
);
const CAPABILITIES_PATH = fileURLToPath(
  new URL("../../packages/shared/src/kernel-contract/capabilities.json", import.meta.url),
);
const SCRIPT_PATH = fileURLToPath(new URL("../check-dual-kernel-parity.mjs", import.meta.url));

const canonical = () => JSON.parse(readFileSync(CANONICAL_PATH, "utf8"));
const capabilities = () => JSON.parse(readFileSync(CAPABILITIES_PATH, "utf8"));

test("canonical registry passes", () => {
  assert.deepEqual(validateToolParity(canonical(), capabilities()), []);
});

test("counts match the arrays", () => {
  const counts = toolParityCounts(canonical(), capabilities());
  assert.equal(counts.tools, 49);
  assert.equal(counts.nodeTools, 43);
  assert.equal(counts.rustTools, 45);
  assert.equal(counts.permissions, 44);
  assert.equal(counts.errorCodes, 29);
  assert.equal(counts.excluded, 7);
});

test("mutation: deleting a tool without updating counts is red", () => {
  const document = canonical();
  document.tools = document.tools.filter((tool) => tool.name !== "Read");
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /counts\.tools 49 != 实际 48/);
});

test("mutation: deleting a single-side tool leaves its stale capability exception red", () => {
  const document = canonical();
  document.tools = document.tools.filter((tool) => tool.name !== "js");
  document.counts.tools -= 1;
  document.counts.nodeTools -= 1;
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /capabilities 例外 tool\.js 未被 canonical 引用/);
});

test("mutation: marking a shared tool single-side without an exception is red", () => {
  const document = canonical();
  const read = document.tools.find((tool) => tool.name === "Read");
  read.side = "node";
  delete read.rustAsks;
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /工具 Read 缺 capabilities 登记 tool\.Read/);
});

test("mutation: registering an exception the canonical does not reference is red", () => {
  const registry = capabilities();
  registry.singleSideExceptions.push({
    capability: "tool.GhostTool",
    side: "node",
    reason: "fixture",
  });
  const errors = validateToolParity(canonical(), registry);
  assert.match(errors.join("\n"), /tool\.GhostTool 未被 canonical 引用/);
});

test("mutation: a readOnly/wrong-type field is red", () => {
  const document = canonical();
  document.tools[0].readOnly = "yes";
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /readOnly 必须是布尔值/);
});

test("mutation: a duplicate tool name is red", () => {
  const document = canonical();
  document.tools.push(structuredClone(document.tools[0]));
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /重复/);
});

test("mutation: an invalid side is red", () => {
  const document = canonical();
  document.tools[0].side = "browser";
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /side 必须是 both \/ node \/ rust/);
});

test("mutation: a shared error code missing its rust name is red", () => {
  const document = canonical();
  const code = document.errorCodes.find((entry) => entry.name === "invalid_input");
  delete code.rust;
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /errorCodes\[\d+\]\.rust 必须是非空字符串/);
});

test("mutation: duplicate permission names are red", () => {
  const document = canonical();
  document.permissions.names.push(document.permissions.names[0]);
  document.counts.permissions += 1;
  const errors = validateToolParity(document, capabilities());
  assert.match(errors.join("\n"), /permissions\.names .* 重复/);
});

test("CLI --json exits 1 with structured errors on a mutated canonical", () => {
  const document = canonical();
  document.tools = document.tools.filter((tool) => tool.name !== "Read");
  const directory = mkdtempSync(join(tmpdir(), "nibi-parity-"));
  const mutatedPath = join(directory, "tool-parity.json");
  writeFileSync(mutatedPath, JSON.stringify(document), "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--json", mutatedPath, CAPABILITIES_PATH],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.errors.some((message) => message.includes("counts.tools")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI --json exits 0 on the real canonical", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.counts.tools, 49);
});