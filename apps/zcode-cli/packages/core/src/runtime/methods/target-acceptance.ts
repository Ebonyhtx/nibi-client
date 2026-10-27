// 插件验收合同 × 验证器裁决 → 宿主门禁裁决。
//
// 这里回答一个问题：验证器说了「通过」，宿主凭什么也认为可以收工？
// 规则来自计划文档 §3 阶段 3，两条：
//   ① required 检查被明确报告为未通过 → 不得判定完成（哪怕 passed: true）；
//   ② required + failClosed 的检查**没被确认通过**（没报、或验证器整体失效）→ 闭合失败。
//
// 第 ② 条是插件真正要的那条：插件文档写的是「缺失 = Blocker，不降级静默替代」，
// 而宿主的既有语义是 fail-open（裁判链路故障不该把已交付的目标卡死）。两者冲突时
// 由插件逐条声明 failClosed 来分级——没声明的继续享受 fail-open，声明了的按声明执行。
import type { GoalCompletionVerificationEvidence, GoalCompletionVerificationOutput } from "../deps.js";
import type { ActivePluginAcceptance } from "../../plugin-reference/acceptance.js";
import { flattenAcceptanceChecks } from "../../plugin-reference/acceptance.js";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

/** 验收被阻断的检查为什么算没通过。 */
export type AcceptanceBlockKind =
  /** 验证器明确报告它没通过。 */
  | "reported_failed"
  /** 验证器给了裁决但没提这条检查（没跑、或整段裁决是 fail-open 兜底）。 */
  | "not_reported"
  /** 报告通过了，但引用的产物在工作区里不存在。 */
  | "missing_artifact"
  /** 报告通过了，却没给出任何证据。 */
  | "without_evidence";

export interface AcceptanceBlock {
  failClosed: boolean;
  id: string;
  kind: AcceptanceBlockKind;
  /** 检查自己声明的说明，缺省时回退成 id。 */
  title: string;
  /** 该检查要求跑的命令 / 要求的证据，用于合成可执行的 nextAction。 */
  run?: string;
  requires?: string[];
  /** 触发阻断的具体引用（缺失的产物路径、缺失的证据），供 nextAction 与界面定位。 */
  detail?: string;
}

export interface TargetAcceptanceEvaluation {
  /** 所有 required 且未确认通过的检查（含不阻断完成的那些）。 */
  blocks: AcceptanceBlock[];
  /** 是否因此拒绝本次完成。 */
  blocksCompletion: boolean;
  /** 会阻断完成的检查：reported_failed 的，或 failClosed 且 not_reported 的。 */
  blockingChecks: AcceptanceBlock[];
  /** 合同里有没有 failClosed 的必需检查；用于区分"插件没要求"与"插件要求了但都通过了"。 */
  hasFailClosedRequirement: boolean;
}

const EMPTY_EVALUATION: TargetAcceptanceEvaluation = {
  blocks: [],
  blockingChecks: [],
  blocksCompletion: false,
  hasFailClosedRequirement: false,
};

/** 多份合同共存时给检查 id 加插件前缀，避免不同插件用通用 id 互相覆盖。 */
export function qualifyAcceptanceCheckId(pluginName: string, checkId: string, multiple: boolean) {
  return multiple ? `${pluginName}:${checkId}` : checkId;
}

export function evaluateTargetAcceptance(input: {
  acceptance: readonly ActivePluginAcceptance[];
  verification: GoalCompletionVerificationOutput | null;
  /**
   * 工作区根，用于核对 `kind: "path"` 证据是否真的存在。
   * 缺省＝跳过核对（仍然要求 fail-closed 检查给出证据，只是不查文件）。
   */
  workspacePath?: string | null;
}): TargetAcceptanceEvaluation {
  const { acceptance } = input;
  if (acceptance.length === 0) return EMPTY_EVALUATION;

  const required = new Map<
    string,
    {
      block: AcceptanceBlock;
      evidence: GoalCompletionVerificationEvidence[];
      reported: boolean;
      passed: boolean;
    }
  >();
  const multiple = acceptance.length > 1;
  for (const contract of acceptance) {
    for (const check of flattenAcceptanceChecks(contract)) {
      if (!check.required) continue;
      required.set(qualifyAcceptanceCheckId(contract.pluginName, check.id, multiple), {
        block: {
          failClosed: check.failClosed,
          id: check.id,
          kind: "not_reported",
          title: check.title ?? check.id,
          ...(check.run ? { run: check.run } : {}),
          ...(check.requires ? { requires: check.requires } : {}),
        },
        evidence: [],
        passed: false,
        reported: false,
      });
    }
  }
  if (required.size === 0) return EMPTY_EVALUATION;

  for (const reported of input.verification?.checks ?? []) {
    const entry = required.get(reported.id);
    if (!entry) continue;
    entry.reported = true;
    entry.passed = reported.passed === true;
    entry.evidence = reported.evidence ?? [];
  }

  const blocks: AcceptanceBlock[] = [];
  const blockingChecks: AcceptanceBlock[] = [];
  for (const entry of required.values()) {
    if (entry.reported && entry.passed) {
      const evidenceBlock = evidenceBlockForCheck(entry, input.workspacePath);
      if (!evidenceBlock) continue;
      blocks.push(evidenceBlock);
      // evidenceBlockForCheck 只会为 fail-closed 的检查产出证据问题。
      if (evidenceBlock.failClosed) blockingChecks.push(evidenceBlock);
      continue;
    }
    const block: AcceptanceBlock = {
      ...entry.block,
      kind: entry.reported ? "reported_failed" : "not_reported",
    };
    blocks.push(block);
    if (block.kind === "reported_failed" || block.failClosed) blockingChecks.push(block);
  }

  return {
    blocks,
    blockingChecks,
    blocksCompletion: blockingChecks.length > 0,
    hasFailClosedRequirement: [...required.values()].some((entry) => entry.block.failClosed),
  };
}

/**
 * 核对"报告通过了"的检查所引的证据。
 *
 * 只做两件机械可查的事，别的都交给插件自己的 gate 命令：
 *   ① fail-closed 的检查报告通过却一条证据都没有 → 未确认；
 *   ② `kind: "path"` 的引用在工作区里不存在 → 与自己给的证据矛盾。
 * 有意不猜自由文本里的路径：命令里也带斜杠，猜错会把正常的一轮判成造假。
 */
function evidenceBlockForCheck(
  entry: {
    block: AcceptanceBlock;
    evidence: GoalCompletionVerificationEvidence[];
  },
  workspacePath: string | undefined | null,
): AcceptanceBlock | null {
  if (entry.evidence.length === 0) {
    // 报告通过却一条证据都不给：对 fail-closed 的检查就是"未确认"。
    return entry.block.failClosed
      ? { ...entry.block, detail: "报告通过但未给出任何证据", kind: "without_evidence" }
      : null;
  }
  if (!workspacePath) return null;
  const missing = entry.evidence
    .filter((item) => item.kind === "path")
    .map((item) => item.value)
    .filter((value) => !isWorkspacePathPresent(value, workspacePath));
  const first = missing[0];
  if (!first) return null;
  return {
    ...entry.block,
    detail: `引用的产物在工作区里不存在：${missing.join(", ")}`,
    kind: "missing_artifact",
  };
}

/**
 * 引用是不是工作区里真实存在的路径。
 *
 * 只核对**相对路径**：绝对路径（`/opt/...`、`C:\...`、UNC）与含 `..` 的引用一律放行，
 * 因为插件可以合法地引用工作区外的产物，宿主不该因为核对不了就判它造假。
 * 相对引用是唯一无歧义的形态——`kind: "path"` 已经声明了它是路径，不需要再猜。
 */
function isWorkspacePathPresent(citation: string, workspacePath: string): boolean {
  const normalized = citation.replaceAll("\\", "/").trim();
  if (!normalized) return false;
  if (normalized.startsWith("/")) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  const segments = normalized.split("/");
  if (segments.includes("..")) return true;
  const root = resolve(workspacePath);
  const target = resolve(root, normalized);
  if (!isInsideRoot(root, target)) return false;
  return existsSync(target);
}

function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 把验收阻断翻译成下一轮迭代要做的事。
 *
 * 只有在验证器自己没给出 nextAction 时才合成：验证器读过完整会话，
 * 它指出的下一步通常比这里按声明拼出来的更具体。
 */
export function formatAcceptanceBlockNextAction(blocks: readonly AcceptanceBlock[]): string {
  const first = blocks[0];
  if (!first) return "";
  const parts: string[] = [];
  if (first.run) {
    parts.push(`运行验收检查 ${first.id}：${first.run}`);
  } else if (first.requires?.length) {
    parts.push(`为 ${first.id} 补上所需证据：${first.requires.join(", ")}`);
  } else {
    parts.push(`让验收检查 ${first.id}（${first.title}）通过`);
  }
  if (blocks.length > 1) {
    parts.push(`（同批未过的还有 ${blocks.length - 1} 项）`);
  }
  return parts.join("");
}

/** 验收阻断时给验证器裁决的人话理由，写进续跑提示与日志。 */
export function formatAcceptanceBlockReason(blocks: readonly AcceptanceBlock[]): string {
  const ids = blocks.map((block) => block.id).join(", ");
  return `Plugin acceptance checks did not pass: ${ids}`;
}

/** 供事件与日志使用的精简形态。 */
export function summarizeAcceptanceEvaluation(evaluation: TargetAcceptanceEvaluation) {
  return {
    blocked: evaluation.blocks.map((block) => ({
      ...(block.detail ? { detail: block.detail } : {}),
      failClosed: block.failClosed,
      id: block.id,
      kind: block.kind,
      title: block.title,
    })),
    blockedCompletion: evaluation.blocksCompletion,
    hasFailClosedRequirement: evaluation.hasFailClosedRequirement,
  };
}
