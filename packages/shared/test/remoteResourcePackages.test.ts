import { describe, expect, it } from "vitest";
import {
  ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS,
  NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID,
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

  it("prefers nibi-agent and keeps glm as the dual-read fallback", () => {
    // B03：新 id 是 active；旧 id 仍必须可被读取，供旧 manifest 回退。
    expect(NIBI_AGENT_REMOTE_COMPONENT_ID).toBe("nibi-agent");
    expect(NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID).toBe("glm");
    expect(NIBI_AGENT_REMOTE_COMPONENT_IDS).toEqual(["nibi-agent", "glm"]);
    expect(ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS).toContain("nibi-agent");
    expect(ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS as readonly string[]).not.toContain("glm");
    // 旧 id 仍在已知集合里，4.1.3 时代配置与旧 manifest 不能被 schema 拒绝。
    expect(REMOTE_RESOURCE_PACKAGE_IDS).toContain("glm");
    expect(REMOTE_RESOURCE_PACKAGE_IDS).toContain("nibi-agent");
  });

  it("selects the agent component only from ids the manifest actually publishes", () => {
    expect(selectNibiAgentRemoteComponentId(["server-bundle", "glm", "nibi-agent"])).toBe(
      "nibi-agent",
    );
    expect(selectNibiAgentRemoteComponentId(["server-bundle", "glm"])).toBe("glm");
    expect(selectNibiAgentRemoteComponentId(["server-bundle", "node-runtime"])).toBeNull();
    expect(isNibiAgentRemoteComponentId("nibi-agent")).toBe(true);
    expect(isNibiAgentRemoteComponentId("glm")).toBe(true);
    expect(isNibiAgentRemoteComponentId("server-bundle")).toBe(false);
  });

  it("declares the agent's runtime dependency for both ids", () => {
    expect(getRemoteResourcePackageDependencies("nibi-agent")).toEqual(["node-runtime"]);
    expect(getRemoteResourcePackageDependencies("glm")).toEqual(["node-runtime"]);
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

  it("accepts selected SSH resource packages", () => {
    expect(
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
        },
      }),
    ).toMatchObject({
      resourcePackages: {
        selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
      },
    });
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
