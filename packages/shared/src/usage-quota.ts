/**
 * Coding Plan 额度相关的纯类型定义。
 *
 * 从 usage-stats.ts 拆出：MCP 额度接入后该文件超过 oxlint max-lines(400) 门禁，
 * 而额度是可以独立描述的一组类型（不依赖统计聚合结构），拆出后两边都在门禁内。
 * 这里只依赖自身，usage-stats.ts 单向导入并 re-export，不构成循环依赖。
 */

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /** Start Plan 服务端额度桶及周期身份；周期时间为毫秒，供提醒去重。 */
  bucketId?: string;
  userPlanId?: string;
  periodStart?: number;
  periodEnd?: number;
  /** 所属 entitlement 的周期类型，如 daily / one_time。 */
  period?: string;
  meter?: string;
  unitType?: string;
  /** Start Plan bucket 所属套餐身份，仅用于设置页按 plan 分组展示。 */
  planId?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails: UsageQuotaUsageDetail[];
}

export interface UsageQuotaUsageDetail {
  modelCode: string;
  displayName?: string;
  usage: number;
}

