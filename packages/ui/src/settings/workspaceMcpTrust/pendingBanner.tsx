import { memo, useCallback, useMemo, useState } from "react";
import type { NibiMcpServer } from "@nibi/shared";
import {
  TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER,
  TID_V4_WORKSPACE_MCP_TRUST_PENDING_DISMISS,
  TID_V4_WORKSPACE_MCP_TRUST_PENDING_REVIEW,
} from "@nibi/shared/test-ids";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useMcpStore } from "@/store/mcpStore.js";
import type { WorkspaceMcpTrustReviewView } from "@/store/mcpStoreDesktop.js";

/** 会话内「项目 MCP 待信任」提示的展示事实；只有真正会进入 Agent 的项目 server 才计数。 */
export interface WorkspaceMcpTrustPendingInfo {
  count: number;
  /** 工作区 + 声明摘要集合；摘要变化后 dismiss 失效，提示条重新出现。 */
  signature: string;
}

export interface WorkspaceMcpTrustPendingInput {
  workspacePath: string;
  workspaceIdentity?: string;
  currentProjectPath: string;
  currentWorkspaceIdentity?: string;
  trustKnown: boolean;
  trust: Record<string, WorkspaceMcpTrustReviewView>;
  unreviewable: readonly string[];
  enabledStates: Record<string, boolean>;
  servers: NibiMcpServer[];
}

/**
 * 从当前绑定工作区的 MCP store 投影里找出「已启用但未通过 Host 审核」的项目 server。
 *
 * 会话与内核都不会装载这些 server（Host 过滤 + Rust 跳过），提示条负责把静默跳过变成
 * 用户可见的原因；旧远端 Host 不返回 trust 元数据时保持未知，不误报。
 */
export function resolveWorkspaceMcpTrustPending(
  input: WorkspaceMcpTrustPendingInput,
): WorkspaceMcpTrustPendingInfo | null {
  const targetKey = input.workspaceIdentity?.trim() || input.workspacePath;
  const boundKey = input.currentWorkspaceIdentity?.trim() || input.currentProjectPath;
  if (!input.trustKnown || !targetKey || targetKey !== boundKey) {
    return null;
  }
  const blocked = input.servers.filter(
    (server) =>
      server.source === "nibiagentmcp" &&
      server.scope === "workspace" &&
      (server.projectPath ?? input.workspacePath) === input.workspacePath &&
      (input.enabledStates[server.id] ?? server.enabled) &&
      input.trust[server.name]?.trusted !== true,
  );
  if (blocked.length === 0) return null;
  const signature = blocked
    .map((server) => {
      const digest = input.trust[server.name]?.declarationDigest;
      const unreviewable = input.unreviewable.includes(server.name);
      return `${server.name}:${digest ?? (unreviewable ? "unreviewable" : "missing")}`;
    })
    .sort()
    .join("|");
  return { count: blocked.length, signature };
}

/**
 * 软门禁 dismiss store：幂等 key = workspace + 声明摘要集合。
 * 与 Hook 提示一致不落盘；刷新或声明变化后重新提示。
 */
class WorkspaceMcpTrustPendingDismissStore {
  private dismissed = new Set<string>();

  dismiss(workspaceKey: string, signature: string): void {
    this.dismissed.add(this.key(workspaceKey, signature));
  }

  isDismissed(workspaceKey: string, signature: string): boolean {
    return this.dismissed.has(this.key(workspaceKey, signature));
  }

  clear(): void {
    this.dismissed.clear();
  }

  private key(workspaceKey: string, signature: string): string {
    return `${workspaceKey}\u0000${signature}`;
  }
}

export const workspaceMcpTrustPendingDismissStore = new WorkspaceMcpTrustPendingDismissStore();

/**
 * 会话内常驻提示条：项目 MCP 因工作区未信任被跳过时显示，提供 [去审核] 与 [忽略]。
 * 数据来自 Host 已经返回的 `workspaceTrust`，不新增协议字段，也不自行推断信任。
 */
export const WorkspaceMcpTrustPendingBanner = memo(function WorkspaceMcpTrustPendingBanner({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useNibiIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const currentProjectPath = useMcpStore((state) => state.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((state) => state.currentWorkspaceIdentity);
  const trustKnown = useMcpStore((state) => state.workspaceTrustKnown);
  const trust = useMcpStore((state) => state.workspaceTrust);
  const unreviewable = useMcpStore((state) => state.workspaceTrustUnreviewable);
  const enabledStates = useMcpStore((state) => state.enabledStates);
  const servers = useMcpStore((state) => state.servers);
  const [, setDismissRevision] = useState(0);

  const info = useMemo(
    () =>
      resolveWorkspaceMcpTrustPending({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        currentProjectPath,
        ...(currentWorkspaceIdentity ? { currentWorkspaceIdentity } : {}),
        trustKnown,
        trust,
        unreviewable,
        enabledStates,
        servers,
      }),
    [
      workspacePath,
      workspaceIdentity,
      currentProjectPath,
      currentWorkspaceIdentity,
      trustKnown,
      trust,
      unreviewable,
      enabledStates,
      servers,
    ],
  );

  const handleReview = useCallback(() => {
    // 与 Hook 提示同一套导航：设置 intent 再打开设置页。
    setPendingSettingsSectionIntent("mcp");
    openSettingsTab?.();
  }, [openSettingsTab]);

  const handleDismiss = useCallback(() => {
    if (!info) return;
    workspaceMcpTrustPendingDismissStore.dismiss(
      workspaceIdentity?.trim() || workspacePath,
      info.signature,
    );
    // 模块级 Set 不是 React 状态，必须显式触发一次重渲染。
    setDismissRevision((revision) => revision + 1);
  }, [info, workspaceIdentity, workspacePath]);

  if (!info) return null;
  if (
    workspaceMcpTrustPendingDismissStore.isDismissed(
      workspaceIdentity?.trim() || workspacePath,
      info.signature,
    )
  ) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage({ id: "chat.workspaceMcpTrustPending.message" }, { count: info.count })}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_MCP_TRUST_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceMcpTrustPending.review" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_MCP_TRUST_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceMcpTrustPending.dismiss" })}
      </button>
    </div>
  );
});
