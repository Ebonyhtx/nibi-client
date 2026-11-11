// ============================================================
// Subagent restart entries
// ============================================================
//
// 子代理重启恢复的持久化事实（docs/subagent-restart-resume.md）：与 Rust 内核同一套
// `subagent_*` entry。Rust 通过 `Fact::Entry` 落库时把 kind 写成 `nibi-kernel/<kind>`，
// 物理 id 写成 `<session>:nibi-kernel/<kind>:<agentId>`（kernel/crates/node-store/src/facts.rs）；
// 这里逐字节沿用同一行形状，两个内核读写同一份数据，切换内核后仍能恢复。
// 读侧同时接受普通 `<kind>` / `<session>:<kind>:<agentId>`（手写/旧数据的降级路径）。
//
// 写失败只记日志：恢复能力是观测与续跑的增强，不能反过来影响正在运行的子代理。

import {
  createTraceId,
  traceContextToLogContext,
  type Logger,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
  type TraceContext,
} from "@nibi/contracts";

/** 子会话里的身份与派生参数（重启后只有它能说明“这个子会话是谁”）。 */
export const SUBAGENT_SPAWN_ENTRY = "subagent_spawn";
/** 子代理一次运行的开始时刻（每次开始/续跑覆盖）。 */
export const SUBAGENT_RUN_ENTRY = "subagent_run";
/** 子代理一次运行的终态（完成、失败、被停止都写）。 */
export const SUBAGENT_RESULT_ENTRY = "subagent_result";
/** 自动续跑的尝试计数（跨重启累计）。 */
export const SUBAGENT_RESUME_ATTEMPT_ENTRY = "subagent_resume_attempt";
/** 结果通知已投递（写在父会话，避免重启后重复补发）。 */
export const SUBAGENT_RESULT_DELIVERED_ENTRY = "subagent_result_delivered";

const KERNEL_ENTRY_PREFIX = "nibi-kernel/";

export type SubagentResultEnding = "completed" | "failed" | "killed";

export interface SubagentSpawnEntryData {
  agentId: string;
  childSessionId: string;
  parentSession: string;
  rootSession: string;
  ownerAgentId?: string;
  depth: number;
  toolUseId?: string;
  description: string;
  agentType: string;
  /** Node 事实：工作目录与工作区根；environment/root 是 Rust `WorkspaceRef` 的跨内核别名。 */
  workspace: {
    workingDirectory: string;
    workspaceRoot: string;
    environment?: string;
    root?: string;
  };
  machine?: string;
  /** 本次运行已知的模型选择；Node 形状 + Rust `ModelSelection` 的 provider/model 别名。 */
  selection?: unknown;
  /** 本次运行声明的权限模式（profile 事实，实际执行模式由父运行收紧后决定）。 */
  execution?: { mode: string; plan: boolean };
  background: boolean;
  fork: boolean;
  createdAtMs: number;
}

export interface SubagentRunEntryData {
  startedAtMs: number;
}

export interface SubagentResultEntryData {
  ending: SubagentResultEnding;
  text: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  toolUseId?: string;
  finishedAtMs: number;
}

export interface SubagentResumeAttemptEntryData {
  count: number;
  lastAtMs: number;
  reason: "process_restart";
}

export interface SubagentResultDeliveredEntryData {
  deliveredAtMs: number;
}

export interface SubagentRestartEntry<T> {
  agentId: string;
  data: T;
}

const CONTINUE_PROMPT_LINES = [
  "Continue the previous task from where it left off. The client restarted while you were running.",
  "Do not start over: first check what you have already done (the messages above and the workspace),",
  "then finish the remaining work and report the result.",
];

/**
 * 续跑消息（与 Rust `restore::CONTINUE` 逐字一致）：要求模型先核对现场，不从头开始。
 */
export const SUBAGENT_RESTART_CONTINUE_PROMPT = CONTINUE_PROMPT_LINES.join("\n");

/** 自动续跑次数上限（跨重启累计；到上限只标记失败，不循环）。 */
export const SUBAGENT_RESTART_MAX_ATTEMPTS = 2;

export const SUBAGENT_RESTART_FORK_BLOCKED_TEXT =
  "This fork subagent was interrupted by a client restart. Its inherited prefix is not persisted, so it cannot be resumed automatically; review its session and handle it manually.";

export function subagentRestartAttemptLimitText(): string {
  return `This subagent was interrupted by client restarts and reached the automatic resume limit (${SUBAGENT_RESTART_MAX_ATTEMPTS} attempts). Review its session and resume it manually.`;
}

export function subagentRestartDefinitionMissingText(agentType: string): string {
  return `Agent type '${agentType}' is no longer available, so this subagent cannot be resumed automatically. Review its session and resume it manually.`;
}

export function subagentRestartResumeFailedText(message: string): string {
  return `This subagent was interrupted by a client restart and could not be resumed: ${message}`;
}

/** Rust `Fact::Entry` 在 Node `session_entry` 里的物理 type。 */
export function subagentRestartEntryType(kind: string): string {
  return `${KERNEL_ENTRY_PREFIX}${kind}`;
}

/** Rust `Fact::Entry` 在 Node `session_entry` 里的物理 id：同一 agentId 的多种 entry 不会互相覆盖。 */
export function subagentRestartEntryId(
  sessionId: SessionId,
  kind: string,
  agentId: string,
): string {
  return `${sessionId}:${subagentRestartEntryType(kind)}:${agentId}`;
}

function logicalAgentId(sessionId: SessionId, kind: string, entryId: string, type: string): string {
  const prefix = `${sessionId}:${type}:`;
  if (entryId.startsWith(prefix)) return entryId.slice(prefix.length);
  // 兼容普通 `<session>:<kind>:<agentId>` 与直接写 agentId 的旧数据。
  const plainPrefix = `${sessionId}:${kind}:`;
  if (entryId.startsWith(plainPrefix)) return entryId.slice(plainPrefix.length);
  return entryId;
}

/**
 * 读一个子会话里的某类恢复 entry；优先 Rust 同形的 `nibi-kernel/<kind>`，没有再读普通 `<kind>`。
 * 结果按 `time_created,rowid` 升序（`sessionEntries` 的顺序），同 agentId 的最后一条是最新一次。
 */
export async function readSubagentRestartEntries<T>(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  kind: string,
): Promise<Array<SubagentRestartEntry<T>>> {
  if (!store?.sessionEntries) return [];
  for (const type of [subagentRestartEntryType(kind), kind]) {
    const entries = await store.sessionEntries({ sessionID: sessionId, type });
    if (entries.length === 0) continue;
    return entries.map((entry) => ({
      agentId: logicalAgentId(sessionId, kind, entry.id, type),
      data: entry.data as T,
    }));
  }
  return [];
}

/** 同一 agentId 的最新一条（没有精确匹配时退回最后一条，与 Rust 的单 agent 子会话兼容）。 */
export function latestSubagentRestartEntry<T>(
  entries: ReadonlyArray<SubagentRestartEntry<T>>,
  agentId: string,
): SubagentRestartEntry<T> | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.agentId === agentId) return entries[index];
  }
  return entries.at(-1);
}

export interface SaveSubagentRestartEntryOptions {
  logger?: Logger;
  traceContext?: TraceContext;
  /** 测试与恢复路径可以显式给定时间；普通运行使用当前时间。 */
  nowMs?: number;
  /** 同一批写入内的 `time.created` 保序；默认取 `nowMs`。 */
  createdAtMs?: number;
}

/**
 * 写一条恢复 entry（同 id 覆盖）。失败只记日志并返回 false，不打断子代理运行。
 * `touchSession: false`：恢复事实不是会话活动。
 */
export async function saveSubagentRestartEntry(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  kind: string,
  agentId: string,
  data: unknown,
  options: SaveSubagentRestartEntryOptions = {},
): Promise<boolean> {
  if (!store?.saveSessionEntry) return false;
  const now = options.nowMs ?? Date.now();
  const entry: SessionEntryInfo = {
    id: subagentRestartEntryId(sessionId, kind, agentId),
    sessionID: sessionId,
    type: subagentRestartEntryType(kind),
    touchSession: false,
    time: { created: options.createdAtMs ?? now, updated: now },
    data,
  };
  try {
    await store.saveSessionEntry(entry);
    return true;
  } catch (error) {
    options.logger?.warn("Subagent restart fact could not be stored", {
      ...traceContextToLogContext(options.traceContext ?? fallbackTrace(sessionId)),
      agentId,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.restart.persist_failed",
      kind,
      module: "core.subagent",
      sessionId,
      status: "failed",
    });
    return false;
  }
}

function fallbackTrace(sessionId: SessionId): TraceContext {
  return { sessionId, spanId: `span_${sessionId}`, traceId: createTraceId() };
}
