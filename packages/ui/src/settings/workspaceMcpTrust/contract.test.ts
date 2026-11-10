import { describe, expect, it } from "vitest";

import { shortenDeclarationDigest } from "./contract.js";
import { uiWorkspaceMcpTrustModule } from "./module.js";

describe("ui-workspace-mcp-trust contract", () => {
  it("declares its module manifest", () => {
    expect(uiWorkspaceMcpTrustModule.id).toBe("ui-workspace-mcp-trust");
  });
  it("truncates the Host digest without recomputing it", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(shortenDeclarationDigest(digest)).toBe("0123456789ab");
    expect(shortenDeclarationDigest("short")).toBe("short");
    expect(shortenDeclarationDigest("  ")).toBe("");
  });
});
