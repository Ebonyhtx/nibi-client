import { expect, it } from "vitest";
import { NIBI_SESSION_TOOL_NAMES } from "@nibi/shared";
import { isSessionToolName } from "./contract.js";
import { sessionRendererExample } from "./contract.example.js";

it("八个会话工具名都走会话卡，其他工具仍按原分流", () => {
  for (const name of NIBI_SESSION_TOOL_NAMES) {
    expect(isSessionToolName(name)).toBe(true);
    expect(sessionRendererExample(name)).toBeDefined();
  }
  expect(isSessionToolName("Read")).toBe(false);
  expect(isSessionToolName(undefined)).toBe(false);
  expect(sessionRendererExample("Read")).toBeUndefined();
});