/** 数据同步各分类共用的小工具（Node 侧实现内部使用，不经公共入口导出）。 */

/** 错误转为可写入导入结果的说明文字。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
