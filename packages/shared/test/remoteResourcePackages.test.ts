import { describe, expect, it } from "vitest";
import {
  ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS,
  NIBI_AGENT_REMOTE_COMPONENT_ID,
  NIBI_AGENT_REMOTE_COMPONENT_IDS,
  REMOTE_RESOURCE_PACKAGE_IDS,
  getRemoteResourcePackageDependencies,
  getRemoteRuntimeToolsForPlatform,
  isNibiAgentRemoteComponentId,
  normalizeRemoteResourcePackageSelection,
  remoteTargetSchema,
  selectNibiAgentRemoteComponentId,
} from "@nibi/shared";

describe("remote resource packages", () => {
  it("ignores historical selections and always returns active packages", () => {
    expect(
      normalizeRemoteResourcePackageSelection({
        selectedPackageIds: ["glm"],
      }),
    ).toEqual([
      "server-bundle",
      "node-runtime",
      "node-pty",
      "nibi-agent",
      "bfs",
      "ripgrep",
      "ugrep",
    ]);
  });

  it("uses nibi-agent as the only agent component id", () => {
    expect(NIBI_AGENT_REMOTE_COMPONENT_ID).toBe("nibi-agent");
    expect(NIBI_AGENT_REMOTE_COMPONENT_IDS).toEqual(["nibi-agent"]);
    expect(ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS).toContain("nibi-agent");
    expect(REMOTE_RESOURCE_PACKAGE_IDS).toContain("nibi-agent");
    expect(REMOTE_RESOURCE_PACKAGE_IDS).not.toContain("glm");
  });

  it("selects the agent component only from ids the manifest actually publishes", () => {
    expect(selectNibiAgentRemoteComponentId(["server-bundle", "nibi-agent"])).toBe("nibi-agent");
    expect(selectNibiAgentRemoteComponentId(["server-bundle", "glm"])).toBeNull();
    expect(selectNibiAgentRemoteComponentId(["server-bundle", "node-runtime"])).toBeNull();
    expect(isNibiAgentRemoteComponentId("nibi-agent")).toBe(true);
    expect(isNibiAgentRemoteComponentId("glm")).toBe(false);
    expect(isNibiAgentRemoteComponentId("server-bundle")).toBe(false);
  });

  it("declares the agent's runtime dependency", () => {
    expect(getRemoteResourcePackageDependencies("nibi-agent")).toEqual(["node-runtime"]);
  });

  it("Linux remote 使用 native-search 三工具，Darwin 保留 legacy ripgrep", () => {
    expect(getRemoteRuntimeToolsForPlatform("linux")).toEqual([
      expect.objectContaining({ toolId: "bfs", version: "v4.1.1-2" }),
      expect.objectContaining({ toolId: "ripgrep", version: "v14.1.1-1" }),
      expect.objectContaining({ toolId: "ugrep", version: "v7.8.4-1" }),
    ]);
    expect(getRemoteRuntimeToolsForPlatform("darwin")).toEqual([
      expect.objectContaining({ toolId: "ripgrep", version: "v13.0.0-10" }),
    ]);
  });

  it("accepts the current SSH resource package selection", () => {
    expect(
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "node-runtime", "nibi-agent"],
        },
      }),
    ).toMatchObject({
      resourcePackages: {
        selectedPackageIds: ["server-bundle", "node-runtime", "nibi-agent"],
      },
    });
  });

  it("rejects the removed glm package id", () => {
    expect(() =>
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
        },
      }),
    ).toThrow();
  });

  it("rejects unknown SSH resource packages", () => {
    expect(() =>
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "unknown-runtime"],
        },
      }),
    ).toThrow();
  });
});
