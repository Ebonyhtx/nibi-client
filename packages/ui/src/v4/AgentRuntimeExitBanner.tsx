import { memo, useCallback, useEffect, useState } from "react";
import type { NibiAgentRuntimeExitedEvent } from "@nibi/services";
import {
  TID_V4_AGENT_RUNTIME_EXIT_BANNER,
  TID_V4_AGENT_RUNTIME_EXIT_DISMISS,
} from "@nibi/shared/test-ids";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import {
  resolveAgentRuntimeExitBannerModel,
  type AgentRuntimeExitRecovery,
} from "@/v4/agentRuntimeExitNotice.js";

export interface UseAgentRuntimeExitNoticeOptions {
  onRuntimeExited?: (listener: (event: NibiAgentRuntimeExitedEvent) => void) => () => void;
  /** 老 transport / 测试桩没有 lifecycle 时不传：横幅只停在「正在尝试自动重启」。 */
  onRuntimeRestart?: (listener: () => void) => () => void;
}

/**
 * 当前 transport 所属 workspace 的最近一次 runtime 意外退出。
 *
 * 只是展示：进程崩溃时 CLI 来不及写终态，回合/子代理的收口由重连后的投影给出；
 * 这里不改写会话状态，也不阻塞输入。新 runtime spawn 后把横幅切成「已自动重启」。
 */
export function useAgentRuntimeExitNotice({
  onRuntimeExited,
  onRuntimeRestart,
}: UseAgentRuntimeExitNoticeOptions): {
  exit: NibiAgentRuntimeExitedEvent | null;
  recovery: AgentRuntimeExitRecovery;
  dismiss: () => void;
} {
  const [notice, setNotice] = useState<{
    exit: NibiAgentRuntimeExitedEvent;
    recovery: AgentRuntimeExitRecovery;
  } | null>(null);

  useEffect(() => {
    setNotice(null);
    const exitSubscription = onRuntimeExited?.((event) => {
      setNotice({ exit: event, recovery: "pending" });
    });
    const restartSubscription = onRuntimeRestart?.(() => {
      setNotice((current) =>
        current ? { ...current, recovery: "restarted" } : current,
      );
    });
    return () => {
      exitSubscription?.();
      restartSubscription?.();
    };
  }, [onRuntimeExited, onRuntimeRestart]);

  const dismiss = useCallback(() => setNotice(null), []);
  return {
    exit: notice?.exit ?? null,
    recovery: notice?.recovery ?? "pending",
    dismiss,
  };
}

export interface AgentRuntimeExitBannerProps {
  exit: NibiAgentRuntimeExitedEvent;
  recovery: AgentRuntimeExitRecovery;
  onDismiss: () => void;
}

/**
 * 与 PendingCommandRecoveryBanner 同一种非阻断提示，只说明原因。放在 composer 上方的
 * bottom dock，不遮挡输入、不使用模态；用户主动退出或正常重启不会产生退出事件。
 */
export const AgentRuntimeExitBanner = memo(function AgentRuntimeExitBanner({
  exit,
  recovery,
  onDismiss,
}: AgentRuntimeExitBannerProps) {
  const { intl } = useNibiIntl();
  const model = resolveAgentRuntimeExitBannerModel(exit, recovery);
  if (!model) return null;
  return (
    <div
      role="status"
      data-testid={TID_V4_AGENT_RUNTIME_EXIT_BANNER}
      data-exit-category={model.category}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-card-border bg-card/95 px-3.5 py-2.5 text-ui-base text-foreground shadow-[var(--nibi-shadow-card)] backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">{intl.formatMessage({ id: model.messageId })}</p>
      <button
        type="button"
        data-testid={TID_V4_AGENT_RUNTIME_EXIT_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
        onClick={onDismiss}
      >
        {intl.formatMessage({ id: model.dismissLabelId })}
      </button>
    </div>
  );
});
