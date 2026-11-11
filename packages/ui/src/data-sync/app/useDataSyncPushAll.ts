import { useCallback, useRef, useState } from "react";
import {
  DATA_SYNC_CATEGORIES,
  DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
  type DataSyncCategoryPushResult,
  type DataSyncPushAllSummary,
} from "@/data-sync/contract.js";
import type { DataSyncCategoryController } from "@/data-sync/app/useDataSyncCategory.js";
import {
  DATA_SYNC_PUSH_ALL_CONCURRENCY,
  runDataSyncCategoryPushQueue,
  summarizePushAllResults,
} from "@/data-sync/domain/pushQueue.js";

export interface DataSyncPushAllController {
  running: boolean;
  summary?: DataSyncPushAllSummary;
  run(): Promise<void>;
  /** 设备 / 连接换代时丢弃旧汇总；正在跑的推送本身无法取消，但结果不再展示。 */
  reset(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isCapabilityGateCode(code: string | undefined): boolean {
  return (
    code === DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE ||
    code === DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE
  );
}

function emptyResult(category: DataSyncCategoryPushResult["category"]): DataSyncCategoryPushResult {
  return { category, attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: [] };
}

/**
 * 概览「推送全部」的编排 owner。
 *
 * 根因与边界：
 * - 推送状态仍归各分类的 `useDataSyncCategory` 所有，这里只负责排序、限并发与汇总，
 *   不复制勾选 / 批次 / 重试逻辑；成功项在分类 hook 里已被标为不可选，二次推送自然跳过。
 * - 分类顺序固定为 DATA_SYNC_CATEGORIES，最多同时推进 2 类，单类抛错只转成该类的
 *   失败结果，队列继续其它类。
 * - 加载阶段就命中能力门禁的分类没有可推送行，也直接记为分类失败，避免概览静默跳过。
 * - 二次「推送全部」用分类 hook 当前的勾选（失败项）而不是首次快照，已成功的项不会重推。
 */
export function useDataSyncPushAll(
  categories: readonly DataSyncCategoryController[],
  options: { enabled: boolean },
): DataSyncPushAllController {
  const { enabled } = options;
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const runningRef = useRef(false);
  const runVersionRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<DataSyncPushAllSummary | undefined>(undefined);

  const run = useCallback(async () => {
    if (!enabled || runningRef.current) return;
    const byCategory = new Map(
      categoriesRef.current.map((category) => [category.category, category]),
    );
    const targets: Array<{ controller: DataSyncCategoryController; keys: readonly string[] }> = [];
    const gateFailures: DataSyncCategoryPushResult[] = [];
    for (const categoryId of DATA_SYNC_CATEGORIES) {
      const controller = byCategory.get(categoryId);
      if (!controller) continue;
      if (controller.phase === "ready" && !controller.pushing && controller.selectedCount > 0) {
        // 用点击时的勾选快照，避免排队期间分类页或「全选」改变本类待推送集合。
        targets.push({ controller, keys: [...controller.selectedKeys] });
        continue;
      }
      // 加载阶段就确认能力缺失的分类没有 rows / 勾选；直接记录，避免概览看起来「全部成功」。
      if (controller.phase === "error" && isCapabilityGateCode(controller.errorCode)) {
        gateFailures.push({
          ...emptyResult(categoryId),
          ...(controller.errorMessage ? { error: controller.errorMessage } : {}),
          ...(controller.errorCode ? { errorCode: controller.errorCode } : {}),
        });
      }
    }
    if (targets.length === 0 && gateFailures.length === 0) return;

    runningRef.current = true;
    const version = runVersionRef.current;
    setRunning(true);
    setSummary(undefined);
    try {
      const results = await runDataSyncCategoryPushQueue({
        categories: targets.map((target) => target.controller.category),
        concurrency: DATA_SYNC_PUSH_ALL_CONCURRENCY,
        run: async (categoryId) => {
          const target = targets.find((entry) => entry.controller.category === categoryId);
          if (!target) return emptyResult(categoryId);
          try {
            const result = await target.controller.pushSelected(target.keys);
            // 分类在排队期间被 reload / 换代时 pushSelected 会拒绝执行；不要伪造成功。
            return result ?? emptyResult(categoryId);
          } catch (error) {
            // 分类 hook 已把可预期错误转成结果；这里只兜底未捕获异常，保证其它分类继续。
            const message = errorMessage(error);
            const code = errorCode(error);
            return {
              ...emptyResult(categoryId),
              attempted: target.keys.length,
              failed: target.keys.length,
              error: message,
              ...(code ? { errorCode: code } : {}),
            };
          }
        },
      });
      if (runVersionRef.current !== version) return;
      setSummary(summarizePushAllResults([...gateFailures, ...results]));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [enabled]);

  const reset = useCallback(() => {
    runVersionRef.current += 1;
    setSummary(undefined);
  }, []);

  return { running, ...(summary ? { summary } : {}), run, reset };
}
