import test from "node:test";
import assert from "node:assert/strict";

import { validateCapabilities } from "../check-kernel-capabilities.mjs";

const valid = () => ({
  version: 1,
  singleSideExceptions: [
    { capability: "cli.memoryDiagnostics", side: "node", reason: "V8 only" },
  ],
  dualImplementation: [{ capability: "promptSnapshot", reason: "both" }],
});

test("valid registry passes", () => {
  assert.deepEqual(validateCapabilities(valid()), []);
});

test("missing version fails", () => {
  const document = valid();
  delete document.version;
  assert.match(validateCapabilities(document).join("\n"), /version 必须是 1/);
});

test("empty single-side registry fails instead of silently passing", () => {
  const document = valid();
  document.singleSideExceptions = [];
  assert.match(validateCapabilities(document).join("\n"), /singleSideExceptions 必须是非空数组/);
});

test("empty dual implementation fails", () => {
  const document = valid();
  document.dualImplementation = [];
  assert.match(validateCapabilities(document).join("\n"), /dualImplementation 必须是非空数组/);
});

test("duplicate capability fails", () => {
  const document = valid();
  document.dualImplementation.push({ capability: "cli.memoryDiagnostics", reason: "dup" });
  assert.match(validateCapabilities(document).join("\n"), /重复登记/);
});

test("unknown side fails", () => {
  const document = valid();
  document.singleSideExceptions[0].side = "browser";
  assert.match(validateCapabilities(document).join("\n"), /side 必须是 rust \/ node \/ host/);
});

test("missing reason fails", () => {
  const document = valid();
  document.singleSideExceptions[0].reason = "  ";
  assert.match(validateCapabilities(document).join("\n"), /reason 必须是非空字符串/);
});
