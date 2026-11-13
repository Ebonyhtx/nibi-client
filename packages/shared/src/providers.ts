import { z } from "zod";

/**
 * Nibi agent 提供方的单一真源。
 *
 * 类型 NibiProvider、运行时 schema nibiProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / nibi-protocol 等无环引用。
 */
export const NIBI_PROVIDERS = ["glm"] as const;

export const nibiProviderSchema = z.enum(NIBI_PROVIDERS);

export type NibiProvider = (typeof NIBI_PROVIDERS)[number];
