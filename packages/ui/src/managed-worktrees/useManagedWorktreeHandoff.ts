// 读取首帧交接登记，并在首份 snapshot / 订阅失败时确定性地清掉它。
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  managedWorktreeHandoffRegistry,
  shouldShowManagedWorktreeHandoff,
  type ManagedWorktreeHandoffSubscriptionStatus,
} from "./managedWorktreeHandoff.js";

export function useManagedWorktreeHandoff({
  sessionId,
  snapshotReady,
  subscriptionStatus,
}: {
  sessionId: string | null;
  snapshotReady: boolean;
  /**
   * null = pane 还没拿到 conversation lease。useConversationProjection 在无 lease 时
   * 返回 CLOSED_STATE，那不代表会话已释放，必须按 connecting 处理，不能误清交接。
   */
  subscriptionStatus: ManagedWorktreeHandoffSubscriptionStatus | null;
}): boolean {
  const effectiveStatus = subscriptionStatus ?? "connecting";
  const subscribe = useCallback(
    (listener: () => void) => managedWorktreeHandoffRegistry.subscribe(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => managedWorktreeHandoffRegistry.isPending(sessionId),
    [sessionId],
  );
  const pending = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!sessionId) return;
    // 首帧已到或订阅已失败/释放：提示立即退场，回到正常的 timeline / 错误面板。
    if (snapshotReady || effectiveStatus === "error" || effectiveStatus === "closed") {
      managedWorktreeHandoffRegistry.settle(sessionId);
    }
  }, [sessionId, snapshotReady, effectiveStatus]);

  return shouldShowManagedWorktreeHandoff({
    pending,
    sessionId,
    snapshotReady,
    subscriptionStatus: effectiveStatus,
  });
}
