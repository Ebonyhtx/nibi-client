import {
  SessionEventType,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  createChildTraceContext,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalCompletionVerificationAcceptancePrompt,
  GoalCompletionVerificationOutput,
  Model,
  SessionEvent,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import { prepareRuntimeProviderRequest, throwIfTurnAborted } from "../helpers/index.js";
import { projectMessagesForModelMediaPolicy } from "../helpers/media-budget.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { isStartPlanBusyStreamRecoveryFailure } from "./streaming-recovery.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";
import type { TargetAcceptanceEvaluation } from "./target-acceptance.js";
import {
  evaluateTargetAcceptance,
  summarizeAcceptanceEvaluation,
} from "./target-acceptance.js";
import {
  flattenAcceptanceChecks,
  PREREQUISITE_STAGE_ID,
} from "../../plugin-reference/acceptance.js";
import type { ActivePluginAcceptance } from "../../plugin-reference/acceptance.js";

export interface TargetCompletionVerificationResult {
  /** 宿主按插件验收合同得出的裁决；无生效合同或验证器未跑时为 undefined。 */
  acceptance?: TargetAcceptanceEvaluation;
  /** 本次验证的迭代序号，供续跑裁决给"验收阻断"封顶。 */
  goalIteration?: number;
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

const TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);

export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore) return null;
  if (input.target.status !== "active") return null;

  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const verified = await verifyTargetCompletion.call(this, {
      abortSignal: input.abortSignal,
      events,
      target: input.target,
      traceContext: input.traceContext,
    });

    // 验收裁决必须在把目标写成 complete **之前**得出：一旦先落库，
    // 后续读回的目标已不是 active，门禁只能看着一个"已完成"的目标空转。
    if (!verified.verification.passed || verified.acceptance?.blocksCompletion) {
      return {
        ...(verified.acceptance ? { acceptance: verified.acceptance } : {}),
        goalIteration: verified.goalIteration,
        target: input.target,
        verification: verified.verification,
      };
    }

    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const completedTarget =
      (await this.sessionStore!.updateTargetStatus({
        sessionID: this.sessionId,
        status: "complete",
      })) ?? input.target;
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget,
      source: "runtime",
      target: completedTarget,
      traceContext: input.traceContext,
    });

    return {
      ...(verified.acceptance ? { acceptance: verified.acceptance } : {}),
      goalIteration: verified.goalIteration,
      target: completedTarget,
      verification: verified.verification,
    };
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}

async function verifyTargetCompletion(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<{
  acceptance?: TargetAcceptanceEvaluation;
  goalIteration: number;
  verification: GoalCompletionVerificationOutput;
}> {
  // 目标验证期间也允许切换 session 默认模型；请求、重试和 usage 必须共用
  // 验证开始时的模型快照，不能在 provider 返回后重新读取 Session Selection。
  const requestedModelSelection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection: requestedModelSelection });
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      targetId: input.target.targetID,
    },
  });
  const verificationId = modelTraceContext.spanId ?? modelTraceContext.traceId;
  const foregroundExecutionId = this.activeForegroundExecution?.foregroundExecutionId;
  const goalIteration = await getNextTargetCompletionVerificationIteration.call(
    this,
    input.target.targetID,
  );
  const anchor = targetCompletionVerificationAnchor.call(this, input.traceContext);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "started",
        targetId: input.target.targetID,
        verificationId,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  const prepared = prepareRuntimeProviderRequest(this, {
    entries: withoutTrailingPendingAssistantToolCallEntries(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
    ),
    prompt: formatGoalCompletionVerificationPrompt(input.target),
    tools: [],
    applyCacheControl: true,
    model,
  });
  // verifier 直接消费完整历史但曾绕过正常请求的媒体策略；只补 capability
  // 仍会让聚合超限失败进入 fail-open。请求前统一执行能力和预算投影。
  const messages = projectMessagesForModelMediaPolicy(
    prepared.request.messages,
    model.properties.inputFormat,
  ).messages;
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  input.events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = input.events.length;

  try {
    const result = await generateTargetCompletionVerificationText.call(this, {
      abortSignal: input.abortSignal,
      events: input.events,
      request: { ...prepared.request, messages },
      model,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(input.abortSignal);
    const toolCalls = this.extractToolCallsFromResult(result);
    const modelCompleteEvent = this.createEvent(
      SessionEventType.ModelComplete,
      {
        content: result.text,
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: result.finishReason,
        toolCallCount: toolCalls.length,
        usage: result.usage,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelCompleteEvent, modelTraceContext);
    input.events.push(modelCompleteEvent);
    await recordModelUsageFact(this, {
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: toolCalls.length,
      traceContext: modelTraceContext,
    });
    const verification =
      toolCalls.length > 0
        ? failOpenGoalCompletionVerification(
            "The completion verifier attempted to call tools instead of returning a verification result.",
          )
        : parseGoalCompletionVerificationText(result.text);
    const acceptance = evaluateRuntimeAcceptance(this, verification);
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(acceptance ? { acceptance: summarizeAcceptanceEvaluation(acceptance) } : {}),
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          // 验收拒绝完成时，事件状态不能写 completed：界面上"已完成"与
          // "还差验收项"必须一眼分得开。
          status: acceptance?.blocksCompletion ? "failed_closed" : "completed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return {
      ...(acceptance ? { acceptance } : {}),
      goalIteration,
      verification,
    };
  } catch (error) {
    await recordModelUsageFact(this, {
      error,
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: input.abortSignal?.aborted ? "cancelled" : "error",
      traceContext: modelTraceContext,
    });
    if (input.abortSignal?.aborted) {
      const preserveQueueAutoDrainOnCancel =
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      await this.appendEvent(
        this.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            ...anchor,
            ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
            goalIteration,
            status: "cancelled",
            targetId: input.target.targetID,
            ...(preserveQueueAutoDrainOnCancel ? { preserveQueueAutoDrainOnCancel: true } : {}),
            verification: failedGoalCompletionVerification(
              "Completion verifier request was cancelled.",
            ),
            verificationId,
          },
          modelTraceContext,
        ),
        modelTraceContext,
      );
      // 用户 Stop 或队列“立即发送”打断 goal verifier 时，当前没有普通
      // executeTurn 的取消收口路径会暂停 target。如果仍保持 active，后续
      // resumeSession + sendPrompt 会被 agent 当成 goal continuation，普通用户消息会继续输出 checkpoint。
      await this.pauseActiveTargetForCancellation(modelTraceContext);
      throw error;
    }
    this.logger?.warn("Goal completion verification failed open", {
      ...traceContextToLogContext(modelTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.failed_open",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    const verification = failOpenGoalCompletionVerification(
      error instanceof Error
        ? `Completion verifier request failed: ${error.message}`
        : "The completion verifier could not confirm that every goal requirement is complete.",
    );
    // 裁判链路整体失效时验收无从判定。failClosed 的必需检查在这一刻按"缺失"处理——
    // 这正是插件声明它的意思（缺失 = Blocker）；其余检查继续享受 fail-open。
    const acceptance = evaluateRuntimeAcceptance(this, verification);
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(acceptance ? { acceptance: summarizeAcceptanceEvaluation(acceptance) } : {}),
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "failed_closed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return {
      ...(acceptance ? { acceptance } : {}),
      goalIteration,
      verification,
    };
  }
}

/**
 * 用 runtime 配置里的生效合同评估本次裁决。
 *
 * 无合同（插件没装、没启用，或 activation 判据在本工作区不成立）时返回 undefined，
 * 调用方据此走与改动前完全一致的路径。
 */
function evaluateRuntimeAcceptance(
  runtime: AgentRuntimeInternal,
  verification: GoalCompletionVerificationOutput,
): TargetAcceptanceEvaluation | undefined {
  const acceptance = runtime.config.pluginAcceptance ?? [];
  if (acceptance.length === 0) return undefined;
  return evaluateTargetAcceptance({
    acceptance,
    verification,
    // 证据里的 path 引用按工作区解析：只有能落到真实文件上的引用才算确认过。
    workspacePath: runtime.workingDirectory,
  });
}

/**
 * 把本工作区生效的插件验收合同摊平成 prompt 段。
 *
 * 多个插件各带一份合同时全部注入：宿主的语义是「所有 required 检查都得过」，
 * 没有优先级的空间——优先级只会让某个插件的门禁可以被另一个插件绕过。
 * 同名检查按「插件名:检查 id」去重，避免不同插件用通用 id（如 `gate`）互相覆盖。
 */
function formatAcceptancePromptForVerifier(
  runtime: AgentRuntimeInternal,
): GoalCompletionVerificationAcceptancePrompt | undefined {
  return buildAcceptanceVerifierPrompt(runtime.config.pluginAcceptance ?? []);
}

/** 纯函数版本：便于单测与预览直接调用同一份实现（不要在别处重写一遍）。 */
export function buildAcceptanceVerifierPrompt(
  contracts: readonly ActivePluginAcceptance[],
): GoalCompletionVerificationAcceptancePrompt | undefined {
  if (contracts.length === 0) return undefined;
  const checks: GoalCompletionVerificationAcceptancePrompt["checks"][number][] = [];
  const seen = new Set<string>();
  for (const acceptance of contracts) {
    for (const check of flattenAcceptanceChecks(acceptance)) {
      const qualifiedId =
        contracts.length > 1 ? `${acceptance.pluginName}:${check.id}` : check.id;
      if (seen.has(qualifiedId)) continue;
      seen.add(qualifiedId);
      checks.push({
        evidenceRequired: check.requires,
        failClosed: check.failClosed,
        id: qualifiedId,
        kind: check.kind,
        ...(check.note ? { note: check.note } : {}),
        required: check.required,
        stageId: check.stageId,
        // 没挂进任何阶段的必需检查归到 prerequisites 组：给它一个人话标题，
        // 免得 prompt 里出现 `Stage prerequisites:` 这种半英半机器的话。
        stageTitle:
          check.stageTitle ??
          (check.stageId === PREREQUISITE_STAGE_ID ? "Prerequisites" : undefined),
        title: check.title ?? check.id,
      });
    }
  }
  if (checks.length === 0) return undefined;
  const pluginNames = [...new Set(contracts.map((item) => item.pluginName))].join(", ");
  return { checks, pluginName: pluginNames };
}

function targetCompletionVerificationAnchor(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): { anchorAssistantMessageId?: string; anchorTurnId?: string } {  const anchorAssistantMessageId = this.latestAssistantMessageId;
  const anchorTurnId = this.latestAssistantTurnId ?? traceContext.turnId;
  return {
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
  };
}

async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    request: ReturnType<typeof prepareRuntimeProviderRequest>["request"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  const maxAttempts = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const invocationContext = {
        metadata: traceContextToLogContext(input.traceContext),
        modelCall: {
          operation: "goal_completion_verification" as const,
        },
        statusSink: this.createModelStatusSink(input.traceContext, input.events),
        traceContext: input.traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: input.abortSignal,
          model: input.model,
          traceContext: input.traceContext,
        }),
      };
      return await runWithModelInvocationContext(invocationContext, () =>
        input.model.generateText({
          abortSignal: input.abortSignal,
          ...input.request,
          // Verifier 继承已绑定的思考配置，不能套用低成本辅助调用的降档和封顶策略。
          options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
        }),
      );
    } catch (error) {
      const retryDelayMs = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (
        input.abortSignal?.aborted ||
        retryDelayMs === undefined ||
        !isTargetVerifierStartPlanBusyFailure(error, input.model.providerId)
      ) {
        throw error;
      }

      // 目标完成验证发生在用户已看到 assistant 迭代之后；Start Plan busy
      // 是 admission 瞬时并发。先短暂重试，避免直接走 fail-open 把可恢复并发误当完成。
      this.logger?.warn("Goal completion verification retrying after Start Plan busy", {
        ...traceContextToLogContext(input.traceContext),
        attempt,
        event: "target.completion_verification.retry_start_plan_busy",
        maxAttempts,
        module: "core.runtime",
        retryDelayMs,
        status: "waiting",
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      throwIfTurnAborted(input.abortSignal);
    }
  }

  throw new Error("Goal completion verification retry loop exhausted unexpectedly.");
}

function isTargetVerifierStartPlanBusyFailure(error: unknown, providerId: string): boolean {
  return (
    START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS.has(providerId) &&
    isStartPlanBusyStreamRecoveryFailure(error)
  );
}

async function getNextTargetCompletionVerificationIteration(
  this: AgentRuntimeInternal,
  targetId: string,
): Promise<number> {
  const projection = await this.rebuildProjection();
  const targetTimeline = projection.targetCompletionVerificationTimeline.filter(
    (item) => item.targetId === targetId,
  );
  const latestIteration = targetTimeline.reduce(
    (maxIteration, item, index) => Math.max(maxIteration, item.goalIteration ?? index + 1),
    0,
  );
  // goal 迭代由 verifier lifecycle 推进，而不是普通 turn 或用户继续次数。
  // runtime 在 started/completed/failed_closed/cancelled 上固定同一个编号，UI 与 snapshot 才不会各自猜。
  return latestIteration + 1;
}

function withoutTrailingPendingAssistantToolCallEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const last = entries.at(-1);
  if (
    !last ||
    isRuntimeAttachmentEntry(last) ||
    last?.message.role !== "assistant" ||
    !last.message.toolCalls ||
    last.message.toolCalls.length === 0
  ) {
    return entries;
  }
  return entries.slice(0, -1);
}
