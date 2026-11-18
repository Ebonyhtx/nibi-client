import { z } from "zod";

/**
 * 工具声明需要的是普通 JSON Schema；模型侧只投影 `tool` 变体（无完整引用、无 requestId）。
 * 用 input IO 投影，避免 `.default()` 字段被算成 required——模型可以省略它们。
 */
export function toToolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

/** 结果 schema 没有默认值语义，按输出投影。 */
export function toOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
