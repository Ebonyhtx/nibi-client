// 读取首帧交接登记，并在出现内容行 / 订阅失败时确定性地清掉它。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  MANAGED_WORKTREE_HANDOFF_DELAY_MS,
  managedWorktreeHandoffRegistry,
  shouldShowManagedWorktreeHandoff,
  type ManagedWorktreeHandoffSubscriptionStatus,
} from "./managedWorktreeHandoff.js";

export function useManagedWorktreeHandoff({
  sessionId,
  contentReady,
  subscriptionStatus,
  showDelayMs = MANAGED_WORKTREE_HANDOFF_DELAY_MS,
}: {
  sessionId: string | null;
  /**
   * 会话是否已经有内容行。空 snapshot（rows.window 为空）按未就绪处理：Host 常在导航前
   * 就推一份空 snapshot，只判 snapshot 是否存在会让提示永远不出现。
   */
  contentReady: boolean;
  /**
   * null = pane 还没拿到 conversation lease。useConversationProjection 在无 lease 时
   * 返回 CLOSED_STATE，那不代表会话已释放，必须按 connecting 处理，不能误清交接。
   */
  subscriptionStatus: ManagedWorktreeHandoffSubscriptionStatus | null;
  /** 空白持续多久才显示；本地空白只有 0.1–0.2s，立即显示会闪一下。 */
  showDelayMs?: number;
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
  const [delayElapsed, setDelayElapsed] = useState(false);

  useEffect(() => {
    if (!pending) {
      setDelayElapsed(false);
      return;
    }
    if (showDelayMs <= 0) {
      setDelayElapsed(true);
      return;
    }
    const timer = setTimeout(() => setDelayElapsed(true), showDelayMs);
    return () => clearTimeout(timer);
  }, [pending, showDelayMs]);

  useEffect(() => {
    if (!sessionId) return;
    // 内容行已出现或订阅已失败/释放：提示立即退场，回到正常的 timeline / 错误面板。
    if (contentReady || effectiveStatus === "error" || effectiveStatus === "closed") {
      managedWorktreeHandoffRegistry.settle(sessionId);
    }
  }, [sessionId, contentReady, effectiveStatus]);

  return (
    delayElapsed &&
    shouldShowManagedWorktreeHandoff({
      pending,
      sessionId,
      contentReady,
      subscriptionStatus: effectiveStatus,
    })
  );
}
