import { describe, expect, it } from "vitest";

import { mcpWorkspaceTrustModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("mcp-workspace-trust contract", () => {
  it("declares its module manifest", () => {
    expect(mcpWorkspaceTrustModule.id).toBe("mcp-workspace-trust");
    expect(mcpWorkspaceTrustModule.publicEntrypoints).toContain("index.ts");
    expect(mcpWorkspaceTrustModule.publicEntrypoints).toContain("contract.ts");
  });
});
