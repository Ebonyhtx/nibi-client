import {
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  countContextPrefixMessages,
  traceContextToLogContext,
} from "../deps.js";
import type { EnvInfo, ExecutionShellSelection, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  buildShellEnvironmentResumeNotice,
  getShellEnvironmentResumeNoticeKind,
} from "./shell-environment.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

type SessionShellConfig = Pick<AgentRuntimeConfig, "bashShellSelection">;

export type SessionShellEnvironmentCandidate =
  | ExecutionShellSelection
  | (() => ExecutionShellSelection);

export interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellSelectionFromConfig(
  config: SessionShellConfig,
): ExecutionShellSelection | undefined {
  return config.bashShellSelection;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined {
  const selection = getSessionShellSelectionFromConfig(runtime.config);
  if (!selection) return undefined;
  return {
    promptShell: selection.display.name,
    selection,
  };
}

export function getSessionShellSelection(
  runtime: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return getSessionShellEnvironment(runtime)?.selection;
}

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined {
  return getSessionShellEnvironment(runtime)?.promptShell;
}

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: SessionShellEnvironmentCandidate,
): boolean {
  if (getSessionShellEnvironment(runtime)) {
    return false;
  }

  // Bash shell 是 session-start 快照。所有入口都只表达“当前候选值”，
  // runtime 统一负责首次真实用户执行前初始化一次。candidate 可以是 lazy resolver，
  // 这样已有 snapshot 的 session 不会在外层重复探测 shell。
  applySessionShellEnvironment(runtime, resolveSessionShellCandidate(candidate), {
    refreshPreConversationContext: true,
  });
  return true;
}

export function applySessionShellEnvironment(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
  options: { refreshPreConversationContext?: boolean } = {},
): void {
  runtime.config.bashShellSelection = selection;
  refreshBranchAwareBuiltInTools(runtime);

  if (options.refreshPreConversationContext !== false) {
    refreshPreConversationShellContext(runtime, selection);
  }
}

function resolveSessionShellCandidate(
  candidate: SessionShellEnvironmentCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T,
  selection: ExecutionShellSelection | undefined,
): T;
export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined;
export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined {
  if (!envInfo || !selection?.display.name) {
    return envInfo;
  }
  return {
    ...envInfo,
    shell: selection.display.name,
  };
}

/**
 * 旧版本会把 Bash shell 选择持久化成 `runtime:bash_shell_selection` entry。升级后 shell
 * 每会话只读当前设置，这些 entry 允许残留在历史里但不再生效；首次遇到时记一次日志，
 * 说明旧快照已被忽略，便于排查“升级后 Bash 用的 shell 变了”的反馈。
 */
export async function logIgnoredLegacyBashShellSelectionSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const sessionStore = runtime.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return;
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_BASH_SHELL_SELECTION,
    });
    if (entries.length === 0) {
      return;
    }
    runtime.logger?.info("Ignored legacy persisted Bash shell selection snapshot", {
      ...traceContextToLogContext(traceContext),
      event: "session_entry.bash_shell_selection.ignored",
      legacySnapshotCount: entries.length,
      module: "core.runtime",
    });
  } catch (error) {
    // 读取失败只影响诊断日志，不阻塞 resume；保留真实存储错误便于排查。
    runtime.logger?.warn("Failed to read legacy Bash shell selection snapshots", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.bash_shell_selection.ignored_read_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export function announceSessionShellEnvironmentNoticeAfterResume(
  runtime: AgentRuntimeInternal,
  options: {
    persistedEnvInfo: EnvInfo | undefined;
  },
): void {
  const selection = getSessionShellSelection(runtime);
  const noticeKind = getShellEnvironmentResumeNoticeKind({
    persistedShell: options.persistedEnvInfo?.shell,
    selection,
  });
  if (!selection || !noticeKind) {
    return;
  }

  const notice = buildShellEnvironmentResumeNotice(noticeKind, selection);
  if (hasShellEnvironmentChangeAttachment(runtime, notice)) {
    return;
  }

  // shell 不再从会话恢复：resume 后实际执行 shell 就是当前设置的选择，而历史
  // 上下文仍可能让模型沿用会话落盘时的旧 shell 习惯（旧 Windows 会话还可能由
  // auto Git Bash 接管）。因此 resume 后按持久化 Environment 与当前选择的差异，
  // 补一个 provider-visible shell 提醒；已有同文提醒不重复插入。
  runtime.messageHistory.addAttachment("shell_environment_change", notice);
}

function hasShellEnvironmentChangeAttachment(
  runtime: AgentRuntimeInternal,
  content: string,
): boolean {
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some(
      (entry) =>
        entry.kind === "attachment" &&
        entry.metadata?.source === "shell_environment_change" &&
        entry.content === content,
    );
}

function refreshPreConversationShellContext(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
): void {
  if (
    !selection ||
    !runtime.contextBuilder ||
    !runtime.contextInitialized ||
    !runtime.contextSourceSnapshot ||
    runtime.sessionPersisted
  ) {
    return;
  }
  const activeEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  if (activeEntries.length !== countContextPrefixMessages(activeEntries)) {
    return;
  }

  // deferred draft 是隐藏预热态，首发前刷新 shell 时还没有真实
  // conversation message。此时应把 session-start # Environment 一并刷新，
  // 避免模型看到的 Shell 和 Bash 实际执行 shell 不一致。
  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  runtime.contextSourceSnapshot = {
    ...runtime.contextSourceSnapshot,
    envInfo: applySessionShellToEnvInfo(runtime.contextSourceSnapshot.envInfo, selection),
  };
  rebuildContextPrefix(runtime);
}
