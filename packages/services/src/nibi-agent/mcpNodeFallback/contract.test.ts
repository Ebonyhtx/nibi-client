import { describe, expect, it } from "vitest";

import { buildMcpNodeFallbackHostEnv } from "./contract.js";
import { servicesMcpNodeFallbackModule } from "./module.js";

describe("services-mcp-node-fallback contract", () => {
  it("declares its module manifest", () => {
    expect(servicesMcpNodeFallbackModule.id).toBe("services-mcp-node-fallback");
  });
  it("does nothing for the Node kernel", async () => {
    expect(
      await buildMcpNodeFallbackHostEnv({ kernel: "node", execPath: "/app/electron" }),
    ).toEqual({});
  });
});
