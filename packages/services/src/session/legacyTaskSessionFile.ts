import type { NibiSessionFile, NibiTaskMeta } from "@nibi/shared";
import { nibiSessionFileSchema, nibiTaskMetaSchema, nibiTaskModeSchema } from "@nibi/shared";

export type LegacyTaskSessionFile = Omit<NibiSessionFile, "meta"> & {
  meta: Omit<NibiTaskMeta, "mode"> & { mode?: NibiTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = nibiSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: nibiTaskMetaSchema.extend({
    mode: nibiTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
