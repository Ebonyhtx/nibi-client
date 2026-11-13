import { describe, expect, it } from "vitest";

import { applyMcpNodeFallbackEnv } from "./contract.js";
import { adaptersMcpNodeFallbackModule } from "./module.js";

describe("adapters-mcp-node-fallback contract", () => {
  it("declares its module manifest", () => {
    expect(adaptersMcpNodeFallbackModule.id).toBe("adapters-mcp-node-fallback");
  });
  it("is a no-op when the provider degraded to undefined", () => {
    const env = { PATH: "/usr/bin:/bin" };
    expect(applyMcpNodeFallbackEnv(env, undefined, "linux")).toBe(env);
  });
});
