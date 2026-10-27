import type { GoalCompletionVerificationOutput, SessionGoal } from "../deps.js";
import type { TargetAcceptanceEvaluation } from "./target-acceptance.js";
import {
  formatAcceptanceBlockNextAction,
  formatAcceptanceBlockReason,
} from "./target-acceptance.js";

// 目标续跑门禁的唯一裁决点。
// 单独成文件的理由：这是"目标算不算完成"的唯一决策点，插件声明的验收合同
// （阶段门、fail-closed 分级）也落在这里。把它从 runtime 的副作用里剥出来，
// 才能在不搭一整套 runtime 的前提下把行为固定住。
export type TargetContinuationStopReason =
  | "acceptance_blocked_exhausted"
  | "complete"
  | "target_changed"
  | "verifier_failed_without_next_action";

export type TargetContinuationDecision =
  | { kind: "continue"; verification: GoalCompletionVerificationOutput | null }
  | { kind: "stop"; reason: TargetContinuationStopReason };

/**
 * 验收阻断最多允许重试几轮。
 *
 * 为什么需要上限：验收未过会合成 nextAction 让循环继续，而验证器是模型——
 * 万一某个检查在原理上就过不去，没有上限的话这里正是"把内部错误变成无限目标迭代"
 * 的那条路，跟 `verifier_failed_without_next_action` 要防的是同一件事。
 * 到顶后目标保持 active（未完成），把"没通过"如实留在界面上。
 *
 * 为什么要有环境变量出口：这个数原本写死。验收合同是**插件**写的，而"几轮算够"取决于
 * 合同的规模（九道门 vs 两三道门差很远）：写死 3 会让大合同的插件在差一项时被提前收手。
 * 宿主不该替插件猜这个数，所以给一个显式、可审计的覆盖口（`NIBI_ACCEPTANCE_BLOCKED_MAX_ITERATIONS`），
 * 缺省仍是 3（行为逐字不变）。
 */
export const DEFAULT_MAX_ACCEPTANCE_BLOCKED_ITERATIONS = 3;

export function resolveMaxAcceptanceBlockedIterations(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.NIBI_ACCEPTANCE_BLOCKED_MAX_ITERATIONS?.trim();
  if (!raw) return DEFAULT_MAX_ACCEPTANCE_BLOCKED_ITERATIONS;
  const parsed = Number.parseInt(raw, 10);
  // 非法值一律回落到缺省：配置错误不该变成"无限迭代"或"立刻收手"。
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return DEFAULT_MAX_ACCEPTANCE_BLOCKED_ITERATIONS;
  }
  return parsed;
}

export const MAX_ACCEPTANCE_BLOCKED_ITERATIONS = DEFAULT_MAX_ACCEPTANCE_BLOCKED_ITERATIONS;

export function decideTargetContinuation(input: {
  /** 插件验收合同的裁决；无合同或未生效时为 undefined。 */
  acceptance?: TargetAcceptanceEvaluation | null;
  /** 本次验证的迭代序号（1 起）。用于给验收阻断封顶。 */
  goalIteration?: number;
  /** 验收阻断的重试上限；缺省读环境变量（见 resolveMaxAcceptanceBlockedIterations）。 */
  maxAcceptanceBlockedIterations?: number;
  latestTarget: SessionGoal | null;
  verification: GoalCompletionVerificationOutput | null;
  verifiedTargetId: string;
}): TargetContinuationDecision {
  const { verification } = input;

  // 验收先于一切：验证器说"通过"也不够，插件声明的强制检查说了才算。
  const acceptance = input.acceptance;
  if (acceptance?.blocksCompletion) {
    const iteration = input.goalIteration ?? 1;
    const maxIterations = input.maxAcceptanceBlockedIterations ?? resolveMaxAcceptanceBlockedIterations();
    if (iteration > maxIterations) {
      return { kind: "stop", reason: "acceptance_blocked_exhausted" };
    }
    const nextAction =
      verification?.nextAction?.trim() ||
      formatAcceptanceBlockNextAction(acceptance.blockingChecks);
    const reason = verification?.reason
      ? `${verification.reason} / ${formatAcceptanceBlockReason(acceptance.blockingChecks)}`
      : formatAcceptanceBlockReason(acceptance.blockingChecks);
    return {
      kind: "continue",
      // 事件里记的仍是验证器的原话（见 target-completion-verification.ts），
      // 这里只把续跑提示改写成"缺哪几项"。把 passed 翻成 false 是因为对续跑
      // 这一轮而言目标确实没完成——否则续跑提示会说"已验证通过"。
      verification: { passed: false, reason, nextAction },
    };
  }

  if (verification?.passed) {
    return { kind: "stop", reason: "complete" };
  }
  // 没有 nextAction 的失败结果来自 verifier 自身失败或无效输出，
  // 不是模型确认的下一步工作；继续自动续跑会把内部错误变成无限目标迭代。
  if (verification && !verification.nextAction?.trim()) {
    return { kind: "stop", reason: "verifier_failed_without_next_action" };
  }

  const latest = input.latestTarget;
  // 目标校验请求可能在用户点击 Stop 后才返回；队列会保持 stopRequested，
  // 但 verifier 拿到的是校验开始前的 active target。这里必须用重读后的状态，避免用旧对象继续续跑。
  if (!latest || latest.status !== "active" || latest.targetID !== input.verifiedTargetId) {
    return { kind: "stop", reason: "target_changed" };
  }

  return { kind: "continue", verification: verification ?? null };
}
