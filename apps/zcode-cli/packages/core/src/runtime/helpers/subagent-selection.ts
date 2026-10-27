import { createCoreError, CoreErrorType, type ModelSelection } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import type { EffectiveModelSelectionResult } from "@nibi/shared/model-selection";
import type { SubagentSelectionFallbackMode } from "@nibi/shared";

export type { SubagentSelectionFallbackMode };

const SUBAGENT_SELECTION_MESSAGES = {
  "selection-missing": "No model selected / 未选择模型",
  "account-connection-unavailable": "Account connection unavailable / 当前账号连接不可用",
  "provider-not-found": "Provider unavailable / 供应商不存在或不可用",
  "model-not-found": "Model unavailable / 模型不存在或不可用",
  "reasoning-level-missing": "No reasoning level selected / 未选择思考档位",
  "reasoning-level-not-supported": "Reasoning level unsupported / 不支持所选思考档位",
} satisfies Record<NonNullable<EffectiveModelSelectionResult["selectionIssue"]>, string>;

/**
 * 只有这些原因是"本机此刻用不了"，才允许换模型。
 *
 * `reasoning-level-*` 不在其中：那是 pin 本身写错了（档位不存在/没写），换模型会把
 * "配置写错" 伪装成 "跑起来了"，用户永远看不到自己的错误。
 */
const UNAVAILABLE_REASONS: readonly NonNullable<
  EffectiveModelSelectionResult["selectionIssue"]
>[] = ["provider-not-found", "model-not-found", "account-connection-unavailable"];

/** 换模型时对候选的要求。 */
export interface SubagentSelectionCapabilityRequirement {
  /**
   * 这个子代理是否**必须**能读图。
   *
   * `true` 时挑不到能读图的可用模型就照旧抛错 —— 拿一个读不了图的模型去"评审图"，
   * 会产出一份看起来正常、其实没看过图的结论，比直接报错危险得多。
   * `false`（默认）时不强制，但仍**优先**挑能读图的：因为"换模型"这件事在实践中
   * 十有八九正是视觉类子代理遇到的（agent 文件里 pin 了一个本机没有的供应商）。
   */
  readonly requiresImage: boolean;
}

/** 目录里的一条候选（宿主事实，只读）。 */
export interface SubagentSelectionCandidate {
  readonly providerId: string;
  readonly modelId: string;
  readonly supportsImage?: boolean;
  /** 存在即不可选（未配密钥、被策略禁用等）。 */
  readonly disabledReason?: string;
}

export interface SubagentSelectionSubstitution {
  readonly reason: NonNullable<EffectiveModelSelectionResult["selectionIssue"]>;
  readonly mode: Exclude<SubagentSelectionFallbackMode, "fail">;
  readonly from: ModelSelection | null;
  readonly to: ModelSelection;
}

export interface SubagentSelectionResolution {
  readonly hasConcreteModel: boolean;
  readonly selection: ModelSelection;
  /** 发生过替换时在这里说明：从哪个选择换成了哪个、为什么。**必须由调用方报出来**。 */
  readonly substitution?: SubagentSelectionSubstitution;
}

function toSelection(candidate: SubagentSelectionCandidate): ModelSelection {
  return { providerId: candidate.providerId, modelId: candidate.modelId };
}

/**
 * 在可用目录里挑一个替代，四档从优到劣：
 *
 *   1. **会话模型，且能读图**；
 *   2. 目录里第一个**能读图**的可用模型；
 *   3. 会话模型（读不了图也先用它 —— 与用户此刻的观感/成本最接近）；
 *   4. 目录里第一个可用模型。
 *
 * 前两档优先"能读图"不是随手排的：换模型在实践中几乎都发生在视觉类子代理身上
 * （agent 文件 pin 了一个本机没配的供应商），而这类子代理读不了图就等于没干活。
 * 但**只有** `requiresImage: true` 才会在第 2 档落空时抛错；默认档位允许退到第 3/4 档，
 * 条件是**替换必须被报出来**（见 `substitution`），让调用方知道这次结论可能是"没看图"得出的。
 *
 * 候选里带 `disabledReason` 的一律不选：悄悄绕开禁用项，会让用户拿到一个他没要的模型；
 * 而悄悄选中它，要等子代理第一次开口才炸。
 */
export function pickSelectionSubstitute(input: {
  readonly candidates: readonly SubagentSelectionCandidate[];
  readonly parentSelection?: ModelSelection | null;
  readonly requirement: SubagentSelectionCapabilityRequirement;
}): ModelSelection | undefined {
  const usable = input.candidates.filter((candidate) => candidate.disabledReason === undefined);
  const parent = input.parentSelection;
  const session = parent
    ? usable.find(
        (candidate) =>
          candidate.providerId === parent.providerId && candidate.modelId === parent.modelId,
      )
    : undefined;
  const imageCapable = usable.find((candidate) => candidate.supportsImage === true);

  if (input.requirement.requiresImage) {
    const chosen = session?.supportsImage === true ? session : imageCapable;
    return chosen ? toSelection(chosen) : undefined;
  }
  const chosen = (session?.supportsImage === true ? session : undefined) ??
    imageCapable ??
    session ??
    usable[0];
  return chosen ? toSelection(chosen) : undefined;
}

/** 显式 profile 是待解析意图；继承与内部 override 已有执行归属，不重新对应账号。 */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /**
   * 落空策略。**缺席时这里的兜底是 `fail`，不是产品出厂默认** —— 故意的：
   * 产品默认（`capability`）由**读设置那一层**（bootstrap 的 agents-state 读取）给出，
   * 这样"产品口径"只有一个来源；而任何忘了传这一项的调用方，得到的是**最保守**的行为
   * （不换模型），不会因为漏传就悄悄替用户换模型。
   */
  fallbackMode?: SubagentSelectionFallbackMode;
  /** 目录（活视图）。给了才可能走 `capability`；没给则该档位退化为照旧抛错。 */
  candidates?: readonly SubagentSelectionCandidate[];
  capability?: SubagentSelectionCapabilityRequirement;
}): SubagentSelectionResolution {
  const explicit = input.profileSelection;
  const result: EffectiveModelSelectionResult = input.overrideSelection
    ? { effectiveSelection: input.overrideSelection }
    : explicit
      ? input.resolveSelection
        ? input.resolveSelection(cloneModelSelection(explicit))
        : { effectiveSelection: explicit }
      : { effectiveSelection: input.parentSelection ?? null };
  const mode = input.fallbackMode ?? "fail";
  if (!result.effectiveSelection || result.selectionIssue) {
    const reason = result.selectionIssue ?? "selection-missing";
    const requested = input.overrideSelection ?? explicit ?? input.parentSelection;
    // 只有"不可用"才换模型；意图写错（档位）与"压根没选"照旧抛错。
    // Core Server 的 override 也不算显式 pin —— 它本身就是宿主给的执行归属。
    if (
      input.overrideSelection ||
      mode === "fail" ||
      !UNAVAILABLE_REASONS.includes(reason)
    ) {
      throw selectionError(reason, requested, result);
    }
    const substitute = mode === "inherit"
      ? (input.parentSelection ?? undefined)
      : pickSelectionSubstitute({
          candidates: input.candidates ?? [],
          parentSelection: input.parentSelection,
          requirement: input.capability ?? { requiresImage: false },
        });
    if (!substitute) throw selectionError(reason, requested, result);
    return {
      hasConcreteModel: explicit != null,
      selection: cloneModelSelection(substitute),
      substitution: {
        reason,
        mode,
        from: requested ? cloneModelSelection(requested) : null,
        to: cloneModelSelection(substitute),
      },
    };
  }
  return {
    hasConcreteModel: explicit != null,
    selection: cloneModelSelection(result.effectiveSelection),
  };
}

function selectionError(
  reason: NonNullable<EffectiveModelSelectionResult["selectionIssue"]>,
  requested: ModelSelection | null | undefined,
  result: EffectiveModelSelectionResult,
) {
  const identity = requested ? `; selection=${requested.providerId}/${requested.modelId}` : "";
  // 解析失败不能落回父模型，否则会悄悄改变用户显式指定的子任务模型。
  // 公共错误投影不读取结构化字段（只有 selectionIssue 时消费方看不到）；后台也只保留 message。
  // 因此同时给既有 reason 和消息补上原因，两个消费路径都能定位，不增加专用错误协议。
  return createCoreError(
    CoreErrorType.ConfigurationError,
    `Cannot start subagent: ${SUBAGENT_SELECTION_MESSAGES[reason]} [reason=${reason}${identity}]`,
    {
      recoverable: true,
      context: {
        selectionIssue: reason,
        reason,
        ...(result.effectiveSelection
          ? {
              providerId: result.effectiveSelection.providerId,
              modelId: result.effectiveSelection.modelId,
            }
          : {}),
      },
    },
  );
}
