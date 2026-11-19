import { describe, expect, it } from "vitest";
import {
  ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS,
  NIBI_AGENT_REMOTE_COMPONENT_ID,
  REMOTE_RESOURCE_PACKAGE_IDS,
  getRemoteRuntimeToolsForPlatform,
  normalizeRemoteResourcePackageSelection,
  remoteTargetSchema,
} from "@nibi/shared";

describe("remote resource packages", () => {
  it("ignores historical selections and always returns active packages", () => {
    expect(
      normalizeRemoteResourcePackageSelection({
        selectedPackageIds: ["glm"],
      }),
    ).toEqual(["server-bundle", "node-runtime", "node-pty", "glm", "bfs", "ripgrep", "ugrep"]);
  });

  it("pins the agent component id to the currently deployed CDN alias", () => {
    // 部署耦合：CDN 尚未发布 `nibi-agent/<arch>` 组件，active 集合必须继续用旧 id。
    // 切换时同批改 NIBI_AGENT_REMOTE_COMPONENT_ID 与 ACTIVE 列表，并先完成服务端双发。
    expect(NIBI_AGENT_REMOTE_COMPONENT_ID).toBe("glm");
    expect(ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS).toContain("glm");
    expect(ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS as readonly string[]).not.toContain("nibi-agent");
    // 下一版 id 已在已知集合里预留，但不在 active 集合里。
    expect(REMOTE_RESOURCE_PACKAGE_IDS).toContain("nibi-agent");
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
