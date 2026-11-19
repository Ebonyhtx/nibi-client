import type { NibiAgentRuntimeExitedEvent } from "@nibi/services";

/** runtime 退出后 owner 是否已经看到新进程可用（onRuntimeRestart / available）。 */
export type AgentRuntimeExitRecovery = "pending" | "restarted";

export interface AgentRuntimeExitBannerModel {
  messageId:
    | "chat.runtimeExit.outOfMemory"
    | "chat.runtimeExit.outOfMemoryRestarted"
    | "chat.runtimeExit.recovering"
    | "chat.runtimeExit.restarted";
  dismissLabelId: "chat.runtimeExit.dismiss";
  category: NibiAgentRuntimeExitedEvent["category"];
}

/**
 * 退出事实 → 横幅文案的纯函数。
 *
 * 只决定展示层：oom 与其它崩溃分开说明；新 runtime 已经可用时补一句「已自动重启」，
 * 否则保持「正在尝试自动重启」——用户主动退出/正常重启在 Host 侧就不会产生事件。
 */
export function resolveAgentRuntimeExitBannerModel(
  exit: NibiAgentRuntimeExitedEvent | null | undefined,
  recovery: AgentRuntimeExitRecovery,
): AgentRuntimeExitBannerModel | null {
  if (!exit) return null;
  const restarted = recovery === "restarted";
  const messageId =
    exit.category === "oom"
      ? restarted
        ? "chat.runtimeExit.outOfMemoryRestarted"
        : "chat.runtimeExit.outOfMemory"
      : restarted
        ? "chat.runtimeExit.restarted"
        : "chat.runtimeExit.recovering";
  return {
    messageId,
    dismissLabelId: "chat.runtimeExit.dismiss",
    category: exit.category,
  };
}
