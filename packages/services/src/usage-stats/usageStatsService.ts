import type { AppUsageRequest, AppUsageSnapshot } from "@nibi/shared";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";

interface UsageStatsServiceDependencies {
  /** App Usage 经 NIBI Protocol 读取 agent 数据库真实统计。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage 只读 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
      // 经 NIBI Protocol usage/stats 取回。上游 Coding Plan 的 quota/monitor 链路
      // 已随套餐业务一起移除，这里不再保留回退分支。
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
  };
}
