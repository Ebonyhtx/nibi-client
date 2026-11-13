import { describe, expect, it } from "vitest";
import {
  nibiProtocolMethods,
  nibiWorkspaceHookTrustGrantParamsSchema,
  nibiWorkspaceHookTrustGrantResultSchema,
} from "../src/nibi-protocol/index.js";

describe("workspace Hook Trust workspace protocol", () => {
  it("declares an exact workspace/bundle/declaration grant contract", () => {
    expect(nibiProtocolMethods.workspaceHookTrustGrant).toBe("workspace/hooks/trustGrant");
    expect(
      nibiWorkspaceHookTrustGrantParamsSchema.parse({
        workspace: {
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:host:/repo",
          workspaceKey: "remote:ssh:host:/repo",
        },
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      }),
    ).toEqual(
      expect.objectContaining({
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
      }),
    );
    expect(
      nibiWorkspaceHookTrustGrantResultSchema.parse({
        accepted: false,
        reasonCode: "workspace_hooks_config_unreadable",
      }),
    ).toEqual({ accepted: false, reasonCode: "workspace_hooks_config_unreadable" });
  });

  it("rejects malformed digests and undeclared fields", () => {
    expect(() =>
      nibiWorkspaceHookTrustGrantParamsSchema.parse({
        workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
        bundleDigest: "not-a-digest",
        hookDeclarationDigest: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      nibiWorkspaceHookTrustGrantResultSchema.parse({ accepted: true, bypassed: true }),
    ).toThrow();
    expect(() =>
      nibiWorkspaceHookTrustGrantResultSchema.parse({
        accepted: false,
        reasonCode: "/Users/alice/private/config.json",
      }),
    ).toThrow();
  });
});
