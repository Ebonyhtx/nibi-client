import {
  DATA_SYNC_CATEGORIES,
  type DataSyncCategoryId,
  type DataSyncCategoryPushResult,
  type DataSyncPushAllSummary,
} from "@/data-sync/contract.js";

/** 同时最多推进的分类数：六类一起导出会让远端 RPC 与磁盘排队，限流到 2 个。 */
export const DATA_SYNC_PUSH_ALL_CONCURRENCY = 2;

/**
 * 按分类顺序派发任务，同时最多运行 `concurrency` 个。
 *
 * 根因：概览「推送全部」若一次性并发六类的 export/import，会把同一 attachment 的
 * RPC 通道和远端文件系统同时打满；分类内部的批次顺序仍由 `useDataSyncCategory`
 * 保证，这里只限制分类级并发。`run` 抛错时由调用方转换成失败结果，队列本身不
 * 中断其它分类。结果按入参顺序回填，汇总顺序不受完成先后影响。
 */
export async function runDataSyncCategoryPushQueue<T>(params: {
  categories: readonly DataSyncCategoryId[];
  run(category: DataSyncCategoryId, index: number): Promise<T>;
  concurrency?: number;
}): Promise<T[]> {
  const { categories, run } = params;
  const concurrency = Math.max(1, Math.floor(params.concurrency ?? DATA_SYNC_PUSH_ALL_CONCURRENCY));
  const results: T[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < categories.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(categories[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, categories.length) }, () => worker()),
  );
  return results;
}

/** 汇总各分类结果：只累加逐项结果，分类级失败由结果本身携带原因。 */
export function summarizePushAllResults(
  results: readonly DataSyncCategoryPushResult[],
): DataSyncPushAllSummary {
  const ordered = [...results].sort(
    (left, right) =>
      DATA_SYNC_CATEGORIES.indexOf(left.category) - DATA_SYNC_CATEGORIES.indexOf(right.category),
  );
  return {
    succeeded: ordered.reduce((total, result) => total + result.succeeded, 0),
    failed: ordered.reduce((total, result) => total + result.failed, 0),
    skipped: ordered.reduce((total, result) => total + result.skipped, 0),
    results: ordered,
  };
}

/** 概览只列出真正需要解释的分类：有逐项失败，或有分类级失败原因 / 门禁错误码。 */
export function hasPushAllCategoryFailure(result: DataSyncCategoryPushResult): boolean {
  return result.failed > 0 || Boolean(result.error) || Boolean(result.errorCode);
}
