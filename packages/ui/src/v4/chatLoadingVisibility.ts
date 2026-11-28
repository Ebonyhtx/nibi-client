import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@nibi/shared/nibi-protocol-v4";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

/**
 * 等待用户操作时，弹窗/问答卡已经是唯一进度反馈，不能再显示 loading。
 * 这里只识别权限确认与 AskUserQuestion；ExitPlanMode 等其它 userInput 语义保持独立。
 * 软门禁后 workspaceHookReview 不再阻塞聊天。
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

export type TurnWorkingPhase = "starting" | "thinking" | "tooling" | "generating";
export type TurnWorkingToolSubPhase =
  | "reading"
  | "editing"
  | "executing"
  | "browsing"
  | "delegating"
  | "tooling";

export interface TurnWorkingActivity {
  phase: TurnWorkingPhase;
  toolSubPhase?: TurnWorkingToolSubPhase;
}

function resolveRunningToolSubPhase(
  toolName: string,
  input: unknown,
): TurnWorkingToolSubPhase {
  const normalizedToken = toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
  // WebSearch 在共享身份表里归入 "search" 族；必须先于 search 判断，以免误归类成读源码。
  if (
    normalizedToken === "web_search" ||
    normalizedToken === "websearch" ||
    normalizedToken === "web_fetch" ||
    normalizedToken === "webfetch" ||
    normalizedToken.includes("browser")
  ) {
    return "browsing";
  }

  const identity = resolveToolCallIdentity({ toolName, input });
  switch (identity.family) {
    case "web-fetch":
      return "browsing";
    case "agent":
      return "delegating";
    case "file-read":
    case "search":
    case "explore":
      return "reading";
    case "file-write":
      return "editing";
    case "shell":
    case "node-repl":
      return "executing";
    default:
      return "tooling";
  }
}

/**
 * 从当前轮的运行时消息行推导即时工作阶段与细粒度工具子阶段，
 * 保留底层 `TurnWorkingPhase` 兼容 CSS 动效与旧契约，同时让 UI 展示更精准的行动语义。
 */
export function resolveTurnWorkingActivity(
  rows: readonly ConversationRow[],
): TurnWorkingActivity {
  let hasWorkRow = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "subagent" && row.status === "running") {
      return { phase: "tooling", toolSubPhase: "delegating" };
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "running" || row.status === "inputStreaming")
    ) {
      return {
        phase: "tooling",
        toolSubPhase: resolveRunningToolSubPhase(row.toolName, row.input),
      };
    }
    if (row.kind === "reasoning" && row.state === "streaming") {
      return { phase: "thinking" };
    }
    if (row.kind === "assistantText" && row.state === "streaming") {
      return { phase: "generating" };
    }
    if (
      row.kind === "toolCall" ||
      row.kind === "subagent" ||
      row.kind === "reasoning" ||
      row.kind === "assistantText"
    ) {
      hasWorkRow = true;
    }
  }
  // 工具或思考块已结束但轮次仍在运行，代表模型正在衔接推理下一动作。
  return { phase: hasWorkRow ? "thinking" : "starting" };
}

/**
 * 从当前轮的运行时消息行推导即时工作阶段，用于驱动「羽汐掠墨」指示器的
 * 波浪相位与状态语义语；始终优先以尾部仍在运行/流式的最新活动为准。
 */
export function resolveTurnWorkingPhase(rows: readonly ConversationRow[]): TurnWorkingPhase {
  return resolveTurnWorkingActivity(rows).phase;
}

export function shouldShowTurnChatLoading({
  blockedByActiveWork,
  blockedByInteraction,
  isLastTurn,
  isRunning,
  rows,
}: {
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  isLastTurn: boolean;
  isRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !isRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions / activeWorks 是权威事实源，但恢复或乱序窗口
  // 可能先只有行状态；行级 fallback 避免权限、compact、goal verifier 已出现时
  // 底部 loading 短暂闪回。
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}
