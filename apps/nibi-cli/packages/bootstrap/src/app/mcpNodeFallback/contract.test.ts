import { describe, expect, it } from "vitest";

import { resolveMcpNodeFallbackProvider } from "./contract.js";
import { cliMcpNodeFallbackModule } from "./module.js";

describe("cli-mcp-node-fallback contract", () => {
  it("declares its module manifest", () => {
    expect(cliMcpNodeFallbackModule.id).toBe("cli-mcp-node-fallback");
  });
  it("is disabled outside Electron Node", () => {
    expect(
      resolveMcpNodeFallbackProvider({
        cliStorageRoot: "/tmp",
        runtime: {
          baseDirs: ["/app"],
          electronVersion: undefined,
          execPath: "/usr/bin/node",
        },
      }),
    ).toBeUndefined();
  });
});
