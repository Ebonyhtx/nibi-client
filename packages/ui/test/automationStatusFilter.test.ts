import { describe, expect, it } from "vitest";
import {
  filterAutomationsByStatus,
  resolveAutomationStatusFilterKind,
} from "@/settings/automationStatusFilter.js";

describe("automation status filter", () => {
  it("定时任务：卡片显示失败徽章的都归失败，其余按 lifecycle 归组", () => {
    const active = { lifecycleStatus: "active" as const, enabled: true };
    const disabled = { lifecycleStatus: "active" as const, enabled: false };
    const paused = { lifecycleStatus: "paused" as const, enabled: true };
    const completed = { lifecycleStatus: "completed" as const, enabled: true };
    const failedLifecycle = { lifecycleStatus: "failed" as const, enabled: true };
    // 循环任务仍 active，但最近一次运行失败：卡片显示红色失败徽章，应归失败组。
    const activeWithLastError = { ...active, lastError: "boom" };
    const activeDispatchFailed = { ...active, dispatchStatus: "failed_to_dispatch" as const };

    expect(resolveAutomationStatusFilterKind(active)).toBe("inProgress");
    expect(resolveAutomationStatusFilterKind(disabled)).toBe("inProgress");
    expect(resolveAutomationStatusFilterKind(paused)).toBe("inProgress");
    expect(resolveAutomationStatusFilterKind(completed)).toBe("completed");
    expect(resolveAutomationStatusFilterKind(failedLifecycle)).toBe("failed");
    expect(resolveAutomationStatusFilterKind(activeWithLastError)).toBe("failed");
    expect(resolveAutomationStatusFilterKind(activeDispatchFailed)).toBe("failed");

    const all = [active, activeWithLastError, completed, paused];
    expect(filterAutomationsByStatus(all, "all")).toBe(all);
    expect(filterAutomationsByStatus(all, "inProgress")).toEqual([active, paused]);
    expect(filterAutomationsByStatus(all, "failed")).toEqual([activeWithLastError]);
  });
});
