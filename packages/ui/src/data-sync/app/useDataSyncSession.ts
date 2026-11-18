import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import type { DataSyncCategoryController } from "@/data-sync/app/useDataSyncCategory.js";
import { useDataSyncCategory } from "@/data-sync/app/useDataSyncCategory.js";
import { useDataSyncPushAll } from "@/data-sync/app/useDataSyncPushAll.js";
import type {
  DataSyncCategoryId,
  DataSyncCategoryPushResult,
  DataSyncDevice,
  DataSyncPagePhase,
  DataSyncPushAllSummary,
  DataSyncTabId,
} from "@/data-sync/contract.js";

/** 最近一次推送的展示结果；最小化状态条与恢复后的弹窗共用同一份事实。 */
export interface DataSyncPushProgress {
  category?: DataSyncCategoryId;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 分类级失败（写权限 / 能力门禁）即使没有逐项失败也要让状态条显示失败。 */
  failedFlag: boolean;
}

export interface DataSyncSessionController {
  devices: readonly DataSyncDevice[];
  selectedDevice: DataSyncDevice | undefined;
  selectedDeviceId: string | undefined;
  onSelectDevice(sourceServerId: string): void;
  pagePhase: DataSyncPagePhase;
  categories: readonly DataSyncCategoryController[];
  activeTab: DataSyncTabId;
  onSelectCategory(id: DataSyncTabId): void;
  onRefresh(): void;
  attachmentError?: string;
  onRetryAttachment(): void;
  selectedTotal: number;
  canPushAll: boolean;
  pushAllRunning: boolean;
  pushAllSummary?: DataSyncPushAllSummary;
  onSelectAllCategories(): void;
  onClearCategorySelection(): void;
  onPushAll(): void;
  /** 任一分类或「推送全部」正在写入。 */
  pushing: boolean;
  /** 至少完成过一次推送；最小化状态条据此显示「已结束」。 */
  pushFinished: boolean;
  pushFailed: boolean;
  lastPush?: DataSyncPushProgress;
  /** 状态条要展示的分类：当前标签优先，其次在途分类，最后是上次推送分类。 */
  minimizedCategory?: DataSyncCategoryId;
}

export interface DataSyncSessionOptions {
  devices: readonly DataSyncDevice[];
  initialCategory?: DataSyncCategoryId;
  initialDeviceId?: string;
  /**
   * 显式打开同步后才允许申请 source-settings attachment。
   * provider 只在用户打开弹窗时挂载 session；独立分区默认 true，保持既有页面语义。
   */
  active?: boolean;
  /** 单次分类推送或整批「推送全部」结束后只调用一次。 */
  onPushFinished?(): void;
}

function pushProgressFromResult(result: DataSyncCategoryPushResult): DataSyncPushProgress {
  return {
    category: result.category,
    succeeded: result.succeeded,
    failed: result.failed,
    skipped: result.skipped,
    failedFlag: result.failed > 0 || Boolean(result.error),
  };
}

/**
 * 数据同步会话的状态 owner：设备选择、attachment、六个分类与「推送全部」。
 *
 * 根因：这些状态原来直接长在 `DataSyncSection` 里，最小化或离开设置页时组件卸载，
 * 在途推送的 ownership 随之丢失。现在由窗口级 provider 挂载本 hook，最小化只切换
 * 弹窗显示；分类 hook、推送队列和结果版本都保持在同一实例上。
 */
export function useDataSyncSession(options: DataSyncSessionOptions): DataSyncSessionController {
  const { devices, initialCategory, initialDeviceId, active = true } = options;
  const request = useOptionalPlatform()?.requestSourceSettingsAttachment;
  const sourceServices = useBaseWorkspaceServices();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(
    initialDeviceId ?? devices[0]?.sourceServerId,
  );
  const [attachmentError, setAttachmentError] = useState<string>();
  const [attachmentAttempt, setAttachmentAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<DataSyncTabId>(initialCategory ?? "overview");
  const [lastPush, setLastPush] = useState<DataSyncPushProgress | undefined>(undefined);
  const selectedDevice = devices.find((device) => device.sourceServerId === selectedDeviceId);
  const targetServices = useSourceSettingsServices(selectedDevice?.sourceServerId);

  const onPushFinishedRef = useRef(options.onPushFinished);
  onPushFinishedRef.current = options.onPushFinished;
  const finishPush = useCallback((progress: DataSyncPushProgress) => {
    setLastPush(progress);
    onPushFinishedRef.current?.();
  }, []);

  useEffect(() => {
    if (!devices.some((device) => device.sourceServerId === selectedDeviceId)) {
      setSelectedDeviceId(devices[0]?.sourceServerId);
    }
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    setAttachmentError(undefined);
    // 未打开同步前不申请 attachment：入口只展示设备列表，不建立任何连接。
    if (!active || !selectedDevice || targetServices || !request) return;
    let activeRequest = true;
    ensureSourceSettingsServices(selectedDevice.sourceServerId, request).catch((error: unknown) => {
      logger.warn("[data-sync] 申请设备配置连接失败", {
        sourceServerId: selectedDevice.sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (activeRequest) {
        setAttachmentError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      activeRequest = false;
    };
  }, [active, attachmentAttempt, request, selectedDevice, targetServices]);

  const online = active && Boolean(selectedDevice);
  const categoryParams = {
    sourceServices,
    targetServices,
    online,
    ...(attachmentError ? { attachmentError } : {}),
  };
  const skills = useDataSyncCategory({ ...categoryParams, category: "skills" });
  const mcp = useDataSyncCategory({ ...categoryParams, category: "mcp" });
  const commands = useDataSyncCategory({ ...categoryParams, category: "commands" });
  const hooks = useDataSyncCategory({ ...categoryParams, category: "hooks" });
  const subagents = useDataSyncCategory({ ...categoryParams, category: "subagents" });
  const plugins = useDataSyncCategory({ ...categoryParams, category: "plugins" });
  const rawCategories: DataSyncCategoryController[] = [
    skills,
    mcp,
    commands,
    hooks,
    subagents,
    plugins,
  ];

  // 分类页仍直接调用控制器的 push / retryFailed；包一层，让每次用户动作只递增一次结果版本。
  const categories: DataSyncCategoryController[] = rawCategories.map((controller) => ({
    ...controller,
    push: async () => {
      const result = await controller.pushSelected();
      if (result) finishPush(pushProgressFromResult(result));
    },
    retryFailed: async () => {
      const result = await controller.pushSelected(
        controller.failures.map((failure) => failure.key),
      );
      if (result) finishPush(pushProgressFromResult(result));
    },
  }));
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const previousTabRef = useRef<DataSyncTabId>(activeTab);

  const pagePhase: DataSyncPagePhase = !active
    ? "connecting"
    : !selectedDevice
      ? "offline"
      : attachmentError
        ? "error"
        : !sourceServices || !targetServices
          ? "connecting"
          : "ready";

  // 「推送全部」只负责排序、限并发和汇总；勾选 / 推送仍由各分类 hook 持有。
  const pushAll = useDataSyncPushAll(rawCategories, { enabled: pagePhase === "ready" });
  const { reset: resetPushAll } = pushAll;
  const selectedTotal = rawCategories.reduce(
    (total, category) => total + category.selectedCount,
    0,
  );
  const pushing = pushAll.running || rawCategories.some((category) => category.pushing);
  const canPushAll =
    pagePhase === "ready" && !pushing && selectedTotal > 0 && !categories.some((c) => c.pushing);

  // 切换分类时清空旧分类的勾选：分类页只展示当前分类的结果，不回带上一类的选择。
  // 但「进入分类 → 回到概览」必须保留勾选，否则概览刚做的跨分类全选会被查看动作清掉。
  useEffect(() => {
    const previous = previousTabRef.current;
    previousTabRef.current = activeTab;
    if (previous === activeTab || previous === "overview" || activeTab === "overview") return;
    categoriesRef.current.find((category) => category.category === previous)?.clearSelection();
  }, [activeTab]);

  // 设备换代后旧设备的汇总没有意义；正在推进的写入无法取消，但结果不再回填。
  useEffect(() => {
    resetPushAll();
    setLastPush(undefined);
  }, [resetPushAll, selectedDeviceId]);

  const reload = useCallback(() => {
    const targets =
      activeTab === "overview"
        ? categoriesRef.current
        : categoriesRef.current.filter((category) => category.category === activeTab);
    for (const target of targets) target.reload();
  }, [activeTab]);

  const retryAttachment = useCallback(() => {
    setAttachmentError(undefined);
    setAttachmentAttempt((attempt) => attempt + 1);
  }, []);
  const selectDevice = useCallback((sourceServerId: string) => {
    setSelectedDeviceId(sourceServerId);
  }, []);
  const selectCategory = useCallback((id: DataSyncTabId) => {
    setActiveTab(id);
  }, []);
  const selectAllCategories = useCallback(() => {
    if (pushAll.running) return;
    for (const category of categoriesRef.current) category.selectAll();
  }, [pushAll.running]);
  const clearCategorySelection = useCallback(() => {
    if (pushAll.running) return;
    for (const category of categoriesRef.current) category.clearSelection();
  }, [pushAll.running]);
  const pushAllCategories = useCallback(() => {
    void (async () => {
      const summary = await pushAll.run();
      if (!summary) return;
      finishPush({
        succeeded: summary.succeeded,
        failed: summary.failed,
        skipped: summary.skipped,
        failedFlag: summary.failed > 0 || summary.results.some(hasCategoryFailure),
      });
    })();
  }, [finishPush, pushAll.run]);

  const minimizedCategory =
    activeTab !== "overview"
      ? activeTab
      : (rawCategories.find((category) => category.pushing)?.category ?? lastPush?.category);

  return {
    devices,
    selectedDevice,
    selectedDeviceId: selectedDevice?.sourceServerId,
    onSelectDevice: selectDevice,
    pagePhase,
    categories,
    activeTab,
    onSelectCategory: selectCategory,
    onRefresh: reload,
    ...(attachmentError ? { attachmentError } : {}),
    onRetryAttachment: retryAttachment,
    selectedTotal,
    canPushAll,
    pushAllRunning: pushAll.running,
    ...(pushAll.summary ? { pushAllSummary: pushAll.summary } : {}),
    onSelectAllCategories: selectAllCategories,
    onClearCategorySelection: clearCategorySelection,
    onPushAll: pushAllCategories,
    pushing,
    pushFinished: lastPush !== undefined,
    pushFailed: lastPush?.failedFlag ?? false,
    ...(lastPush ? { lastPush } : {}),
    ...(minimizedCategory ? { minimizedCategory } : {}),
  };
}

function hasCategoryFailure(result: { failed: number; error?: string }): boolean {
  return result.failed > 0 || Boolean(result.error);
}
