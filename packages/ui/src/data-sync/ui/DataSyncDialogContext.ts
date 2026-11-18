import { createContext, useContext, useEffect, useRef } from "react";
import type { DataSyncDialogRequest } from "@/data-sync/contract.js";

export type OpenDataSyncDialog = (request: DataSyncDialogRequest) => void;

/** `null` 表示当前窗口没有挂载 provider（Web 远控等），入口回退到设置页。 */
export const OpenDataSyncDialogContext = createContext<OpenDataSyncDialog | null>(null);
export const DataSyncResultVersionContext = createContext(0);

export function useOpenDataSyncDialog(): OpenDataSyncDialog | null {
  return useContext(OpenDataSyncDialogContext);
}

/** 推送结束后页面刷新的唯一信号；每次推送动作完成只递增一次。 */
export function useDataSyncResultVersion(): number {
  return useContext(DataSyncResultVersionContext);
}

/**
 * 已挂载页面订阅结果版本：版本变化后刷新一次，新挂载页面自行加载，不重复刷新。
 * 回调放 ref，避免调用方每次 render 生成的函数触发额外刷新。
 */
export function useDataSyncResultRefresh(refresh: () => void): void {
  const version = useDataSyncResultVersion();
  const seenVersionRef = useRef(version);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (seenVersionRef.current === version) return;
    seenVersionRef.current = version;
    refreshRef.current();
  }, [version]);
}
