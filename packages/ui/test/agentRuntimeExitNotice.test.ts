import { describe, expect, it } from "vitest";
import type { NibiAgentRuntimeExitedEvent } from "@nibi/services";
import { resolveAgentRuntimeExitBannerModel } from "@/v4/agentRuntimeExitNotice.js";

function exitEvent(
  overrides: Partial<NibiAgentRuntimeExitedEvent> = {},
): NibiAgentRuntimeExitedEvent {
  return {
    workspacePath: "/repo",
    workspaceKey: "/repo",
    runtimeIdentity: { generation: 1, identity: "runtime-1", workspaceKey: "/repo" },
    exitCode: 1,
    signal: null,
    category: "crash",
    exitedAt: 1,
    ...overrides,
  };
}

describe("resolveAgentRuntimeExitBannerModel", () => {
  it("没有退出事实时不显示横幅", () => {
    expect(resolveAgentRuntimeExitBannerModel(null, "pending")).toBeNull();
    expect(resolveAgentRuntimeExitBannerModel(undefined, "restarted")).toBeNull();
  });

  it("普通崩溃在自动重启前显示 recovering，重启后显示 restarted", () => {
    expect(resolveAgentRuntimeExitBannerModel(exitEvent(), "pending")).toEqual({
      messageId: "chat.runtimeExit.recovering",
      dismissLabelId: "chat.runtimeExit.dismiss",
      category: "crash",
    });
    expect(resolveAgentRuntimeExitBannerModel(exitEvent(), "restarted")?.messageId).toBe(
      "chat.runtimeExit.restarted",
    );
  });

  it("OOM 分类使用内存不足文案，并保留重启状态差异", () => {
    const oom = exitEvent({ category: "oom", exitCode: 0xe0000008 });
    expect(resolveAgentRuntimeExitBannerModel(oom, "pending")?.messageId).toBe(
      "chat.runtimeExit.outOfMemory",
    );
    expect(resolveAgentRuntimeExitBannerModel(oom, "restarted")?.messageId).toBe(
      "chat.runtimeExit.outOfMemoryRestarted",
    );
    expect(resolveAgentRuntimeExitBannerModel(oom, "restarted")?.category).toBe("oom");
  });
});
