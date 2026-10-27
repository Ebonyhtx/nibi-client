import { describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot } from "@nibi/shared";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";

function createAppUsageSnapshot(): AppUsageSnapshot {
  return {
    range: "30d",
    generatedAt: 1_900_000_000_000,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 104,
      inputTokens: 14,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheCreationTokens: 5,
      cacheReadTokens: 80,
      cacheHitRate: 0.8,
      totalSessions: 1,
      totalTurns: 1,
      toolCallCount: 2,
      toolErrorRate: 0.5,
      modelErrorRate: 0.5,
      avgTimeToFirstTokenMs: 100,
      avgTurnDurationMs: 2000,
      activeDays: 2,
      currentStreakDays: 2,
      longestSessionMs: 2000,
      longestStreakDays: 2,
      peakDayTokens: 104,
      favoriteModel: { modelId: "model-a", totalTokens: 104, share: 1 },
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 100, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

function createService(getAppUsageStats: IZCodeAgentService["getAppUsageStats"]) {
  return createUsageStatsService({ zcodeAgentService: { getAppUsageStats } });
}

describe("createUsageStatsService", () => {
  it("App Usage 经 NIBI Protocol 读取 agent 数据库统计", async () => {
    const getAppUsageStats = vi.fn(async () => createAppUsageSnapshot());
    const service = createService(getAppUsageStats);

    const snapshot = await service.getAppUsageSnapshot({ range: "30d", timeZone: "UTC" });

    expect(getAppUsageStats).toHaveBeenCalledWith({ range: "30d", timeZone: "UTC" });
    expect(snapshot.source).toBe("agent-db");
    expect(snapshot.summary.totalSessions).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(104);
  });

  it("App Usage 全量概览用 all range 透传到 agent 数据库统计", async () => {
    const getAppUsageStats = vi.fn(async () => ({
      ...createAppUsageSnapshot(),
      range: "all" as const,
    }));
    const service = createService(getAppUsageStats);

    const snapshot = await service.getAppUsageSnapshot({ range: "all", timeZone: "Asia/Shanghai" });

    expect(getAppUsageStats).toHaveBeenCalledWith({ range: "all", timeZone: "Asia/Shanghai" });
    expect(snapshot.range).toBe("all");
  });
});
