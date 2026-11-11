import { useCallback, useEffect, useRef, useState } from "react";
import type { IDataSyncCategoryService, IServiceAccessor } from "@nibi/services";
import { SKILL_DATA_SYNC_MAX_ITEM_BYTES, type DataSyncBlockedReason } from "@nibi/shared";
import type {
  DataSyncCategoryCounts,
  DataSyncCategoryId,
  DataSyncPagePhase,
  DataSyncPushFailure,
  DataSyncPushOutcome,
  DataSyncPushSummary,
  DataSyncRow,
} from "@/data-sync/contract.js";
import {
  chunkSkillRows,
  compareCategoryRows,
  countRemoteOnlyItems,
  findPushFailures,
  importResultToOutcome,
  mergePushOutcomesIntoRows,
  resolveSkillImportItems,
  selectSkillHashRequests,
  summarizePushOutcomes,
} from "@/data-sync/domain/compare.js";

/** 分类服务只需统一形状；payload 由服务层各自持有，页面按分类分派。 */
export type DataSyncCategoryService = IDataSyncCategoryService<unknown>;

/**
 * 按分类从 accessor 取对应服务。五类都 extends `IDataSyncCategoryService`，
 * 服务名固定在 accessor 上；不存在的 accessor 由页面按「连接中」处理。
 */
export function resolveDataSyncCategoryService(
  accessor: IServiceAccessor | undefined,
  category: DataSyncCategoryId,
): DataSyncCategoryService | undefined {
  if (!accessor) return undefined;
  const service = accessor[category === "skills" ? "skillSyncService" : categoryKey(category)];
  return service as unknown as DataSyncCategoryService;
}

function categoryKey(category: Exclude<DataSyncCategoryId, "skills">) {
  switch (category) {
    case "mcp":
      return "mcpSyncService" as const;
    case "commands":
      return "commandsService" as const;
    case "hooks":
      return "hooksService" as const;
    case "subagents":
      return "subagentsService" as const;
  }
}

export interface DataSyncCategoryState extends DataSyncCategoryCounts {
  category: DataSyncCategoryId;
  phase: DataSyncPagePhase;
  rows: DataSyncRow[];
  selectedKeys: ReadonlySet<string>;
  selectedCount: number;
  remoteOnlyCount: number;
  /** 目标端整类不能导入的原因（例如 MCP 使用兼容配置），有值时整类禁选。 */
  importBlockedReason?: DataSyncBlockedReason;
  pushing: boolean;
  summary?: DataSyncPushSummary;
  failures: DataSyncPushFailure[];
  errorMessage?: string;
  canPush: boolean;
}

export interface DataSyncCategoryController extends DataSyncCategoryState {
  /** 切换单项勾选；旧名保留给技能调用方，`toggleItem` 是同一实现。 */
  toggleSkill(key: string, selected: boolean): void;
  toggleItem(key: string, selected: boolean): void;
  selectAll(): void;
  clearSelection(): void;
  reload(): void;
  push(): Promise<void>;
  retryFailed(): Promise<void>;
}

interface InternalState {
  category: DataSyncCategoryId;
  phase: DataSyncPagePhase;
  rows: DataSyncRow[];
  selectedKeys: Set<string>;
  remoteOnlyCount: number;
  sourceCount: number;
  targetCount: number;
  changedCount: number;
  importBlockedReason?: DataSyncBlockedReason;
  pushing: boolean;
  summary?: DataSyncPushSummary;
  failures: DataSyncPushFailure[];
  errorMessage?: string;
}

function emptyState(category: DataSyncCategoryId): InternalState {
  return {
    category,
    phase: "loading",
    rows: [],
    selectedKeys: new Set(),
    remoteOnlyCount: 0,
    sourceCount: 0,
    targetCount: 0,
    changedCount: 0,
    pushing: false,
    failures: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 数据同步分类页的状态 owner（技能、MCP、命令、钩子、子智能体共用）。
 *
 * 关键语义：
 * - 离线 / 连接中 fail-closed：不读写、清空列表，不展示旧快照。
 * - 每次对比绑定一个 generation（分类、设备或 attachment 换代即作废）；迟到的 list / hash / push 结果一律丢弃。
 * - 版本相同 → 已同步；否则按版本 / contentHash / 签名 + 按需哈希判断差异。
 * - 远端独有以不可勾选行展示，不进入 import items，永不删除。
 * - 目标端整类不能导入（importBlockedReason）时所有行不可选，并在页面上显示原因。
 * - 推送失败按项保留，`retryFailed` 只重试失败项；本批导出/导入失败不影响其他批。
 * - 父子技能同批（`chunkSkillRows` 的 parentKey 分组），技能专属逻辑保留。
 */
export function useDataSyncCategory(params: {
  category: DataSyncCategoryId;
  sourceServices: IServiceAccessor | undefined;
  targetServices: IServiceAccessor | undefined;
  online: boolean;
  attachmentError?: string;
}): DataSyncCategoryController {
  const { category, online, attachmentError } = params;
  const source = resolveDataSyncCategoryService(params.sourceServices, category);
  const target = resolveDataSyncCategoryService(params.targetServices, category);
  const [state, setState] = useState<InternalState>(() => emptyState(category));
  const [reloadVersion, setReloadVersion] = useState(0);
  const generationRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    const stale = () => cancelled || generationRef.current !== generation;
    const reset = (phase: DataSyncPagePhase, message?: string) => {
      if (stale()) return;
      setState({ ...emptyState(category), phase, ...(message ? { errorMessage: message } : {}) });
    };

    if (!online) {
      reset("offline");
      return () => {
        cancelled = true;
      };
    }
    if (attachmentError) {
      reset("error", attachmentError);
      return () => {
        cancelled = true;
      };
    }
    if (!source || !target) {
      reset("connecting");
      return () => {
        cancelled = true;
      };
    }

    setState((current) => ({
      ...current,
      category,
      phase: "loading",
      rows: [],
      selectedKeys: new Set(),
      remoteOnlyCount: 0,
      sourceCount: 0,
      targetCount: 0,
      changedCount: 0,
      importBlockedReason: undefined,
      pushing: false,
      summary: undefined,
      failures: [],
      errorMessage: undefined,
    }));

    void (async () => {
      try {
        const [sourceList, targetList] = await Promise.all([
          source.listSyncItems(),
          target.listSyncItems(),
        ]);
        if (stale()) return;
        const requests = selectSkillHashRequests(
          sourceList.items,
          targetList.items,
          targetList.importBlockedReason,
        );
        const [sourceHashes, targetHashes] = await Promise.all([
          requests.sourceKeys.length > 0
            ? source.getSyncContentHashes({
                keys: requests.sourceKeys,
                // MCP 来源端要按目标端 home 改写后再算哈希，其他分类忽略。
                targetHomeDir: targetList.homeDir,
              })
            : Promise.resolve({ hashes: {} }),
          requests.targetKeys.length > 0
            ? target.getSyncContentHashes({ keys: requests.targetKeys })
            : Promise.resolve({ hashes: {} }),
        ]);
        if (stale()) return;
        const rows = compareCategoryRows({
          category,
          sourceItems: sourceList.items,
          targetItems: targetList.items,
          sourceHashes: sourceHashes.hashes,
          targetHashes: targetHashes.hashes,
          ...(targetList.importBlockedReason
            ? { targetBlockedReason: targetList.importBlockedReason }
            : {}),
        });
        setState({
          category,
          phase: "ready",
          rows,
          selectedKeys: new Set(rows.filter((row) => row.defaultSelected).map((row) => row.key)),
          remoteOnlyCount: countRemoteOnlyItems(sourceList.items, targetList.items),
          sourceCount: sourceList.items.length,
          targetCount: targetList.items.length,
          changedCount: rows.filter((row) => row.selectable).length,
          ...(targetList.importBlockedReason
            ? { importBlockedReason: targetList.importBlockedReason }
            : {}),
          pushing: false,
          failures: [],
        });
      } catch (error) {
        if (stale()) return;
        setState({
          ...emptyState(category),
          phase: "error",
          errorMessage: errorMessage(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attachmentError, category, online, reloadVersion, source, target]);

  const toggleSkill = useCallback((key: string, selected: boolean) => {
    setState((current) => {
      if (!current.rows.some((row) => row.key === key && row.selectable)) return current;
      const next = new Set(current.selectedKeys);
      if (selected) next.add(key);
      else next.delete(key);
      return { ...current, selectedKeys: next };
    });
  }, []);

  const selectAll = useCallback(() => {
    setState((current) => ({
      ...current,
      selectedKeys: new Set(current.rows.filter((row) => row.selectable).map((row) => row.key)),
    }));
  }, []);

  const clearSelection = useCallback(() => {
    setState((current) => ({ ...current, selectedKeys: new Set() }));
  }, []);

  const reload = useCallback(() => {
    if (stateRef.current.pushing) return;
    setReloadVersion((version) => version + 1);
  }, []);

  const push = useCallback(
    async (keysOverride?: readonly string[]): Promise<void> => {
      const current = stateRef.current;
      if (current.phase !== "ready" || current.pushing || !online || !source || !target) return;
      const keys = new Set(keysOverride ?? current.selectedKeys);
      const rows = current.rows.filter((row) => keys.has(row.key) && row.selectable);
      if (rows.length === 0) return;
      const generation = generationRef.current;
      const stale = () => generationRef.current !== generation;
      const outcomes: Record<string, DataSyncPushOutcome> = {};
      const markBatchFailed = (batch: readonly DataSyncRow[], error: unknown) => {
        const message = errorMessage(error);
        for (const row of batch) {
          outcomes[row.key] = { key: row.key, status: "failed", error: message };
        }
      };
      setState((previous) => ({
        ...previous,
        pushing: true,
        failures: [],
        summary: undefined,
        errorMessage: undefined,
      }));
      try {
        const access = await target.checkSyncWriteAccess();
        if (stale()) return;
        if (!access.ok) {
          setState((previous) => ({
            ...previous,
            pushing: false,
            errorMessage: access.error ?? access.path,
          }));
          return;
        }
        const batches = chunkSkillRows(rows, SKILL_DATA_SYNC_MAX_ITEM_BYTES, current.rows);
        for (const batch of batches) {
          const batchKeys = batch.map((row) => row.key);
          let payload: unknown;
          try {
            payload = await source.exportSyncItems({ keys: batchKeys });
          } catch (error) {
            if (stale()) return;
            markBatchFailed(batch, error);
            continue;
          }
          if (stale()) return;
          try {
            const result = await target.importSyncItems({
              payload,
              items: resolveSkillImportItems(batch),
            });
            if (stale()) return;
            for (const item of result.results) {
              outcomes[item.key] = importResultToOutcome(item);
            }
          } catch (error) {
            if (stale()) return;
            markBatchFailed(batch, error);
          }
        }
        if (stale()) return;
        setState((previous) => {
          const nextRows = mergePushOutcomesIntoRows(previous.rows, outcomes);
          const failures = findPushFailures(previous.rows, outcomes);
          // 远端独有项也给出逐项「跳过」结果；它们从不进入 import items。
          const summaryOutcomes = { ...outcomes };
          for (const row of previous.rows) {
            if (row.status === "remoteOnly" && !summaryOutcomes[row.key]) {
              summaryOutcomes[row.key] = { key: row.key, status: "skipped" };
            }
          }
          return {
            ...previous,
            rows: nextRows,
            selectedKeys: new Set(failures.map((failure) => failure.key)),
            changedCount: nextRows.filter((row) => row.selectable).length,
            pushing: false,
            failures,
            summary: summarizePushOutcomes({
              outcomes: summaryOutcomes,
              remoteOnlyCount: previous.remoteOnlyCount,
            }),
          };
        });
      } catch (error) {
        if (stale()) return;
        setState((previous) => ({
          ...previous,
          pushing: false,
          errorMessage: errorMessage(error),
        }));
      }
    },
    [online, source, target],
  );

  const retryFailed = useCallback(async () => {
    await push(stateRef.current.failures.map((failure) => failure.key));
  }, [push]);

  const selectedCount = state.rows.filter(
    (row) => row.selectable && state.selectedKeys.has(row.key),
  ).length;
  return {
    ...state,
    selectedCount,
    canPush: state.phase === "ready" && !state.pushing && selectedCount > 0,
    toggleSkill,
    toggleItem: toggleSkill,
    selectAll,
    clearSelection,
    reload,
    push: () => push(),
    retryFailed,
  };
}
