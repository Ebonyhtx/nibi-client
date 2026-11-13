import type {
  ModelSelection,
  NibiAgentMcpServer,
  NibiAutomationScheduleRule,
  NibiMcpListMode,
} from "@nibi/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@nibi/shared/mcp-apps";

export interface NibiAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface NibiAgentPluginMutationTarget extends NibiAgentWorkspaceTarget {
  /** 仅 Host 观测使用；不会传给 CLI。 */
  telemetry?: {
    entry?:
      | "store_list"
      | "store_detail"
      | "side_pane_market"
      | "recommended_prompt"
      | "recommended_ui"
      | "component_settings";
    client_kind?: "desktop" | "mobile";
    trigger?: "user" | "automatic" | "dependency" | "restore" | "sync";
  };
}

export interface NibiAgentPluginViewParams extends NibiAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface NibiAgentListMcpServerStatusesParams extends NibiAgentWorkspaceTarget {
  mcpServers?: NibiAgentMcpServer[];
  mode?: NibiMcpListMode;
}

export interface NibiAgentAddPluginMarketplaceParams extends NibiAgentPluginMutationTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface NibiAgentRemovePluginMarketplaceParams extends NibiAgentPluginMutationTarget {
  marketplace: string;
}

export interface NibiAgentUpdatePluginMarketplaceParams extends NibiAgentPluginMutationTarget {
  marketplace?: string;
  operationId?: string;
}

export interface NibiAgentInstallPluginParams extends NibiAgentPluginMutationTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface NibiAgentCancelPluginOperationParams {
  operationId: string;
}

export interface NibiAgentUninstallPluginParams extends NibiAgentPluginMutationTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface NibiAgentUpdatePluginParams extends NibiAgentPluginMutationTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface NibiAgentRestoreBuiltinPluginParams extends NibiAgentPluginMutationTarget {
  pluginId: string;
}

export interface NibiAgentConfigurePluginParams extends NibiAgentPluginMutationTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface NibiAgentResetPluginConfigParams extends NibiAgentPluginMutationTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface NibiAgentValidatePluginParams extends NibiAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface NibiAgentDescribePluginParams extends NibiAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface NibiAgentSetPluginEnabledParams extends NibiAgentPluginMutationTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface NibiAgentPluginReferenceCatalogParams extends NibiAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface NibiAgentSkillReferenceCatalogParams extends NibiAgentWorkspaceTarget {
  sessionId?: string;
}

/** 插件 UI：UI 发起的 `ui://` 资源读取。 */
export interface NibiAgentReadMcpResourceParams extends NibiAgentWorkspaceTarget {
  instance: import("@nibi/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** 插件 UI 页面发起的 `resources/read`；参数与 readMcpResource 同形，结果受 8 MiB 与 mimeType 白名单约束。 */
export type NibiAgentReadMcpResourceForUiParams = NibiAgentReadMcpResourceParams;

/** 插件 UI：UI 回调本插件工具；不进审批流，归属由 agent 侧 catalog fail closed。 */
export interface NibiAgentCallMcpToolForUiParams extends NibiAgentWorkspaceTarget {
  instance: import("@nibi/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的调用 id，配合 cancelMcpToolCallForUi。 */
  callId: string;
}
/** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe。 */
export interface NibiAgentListMcpResourcesForUiParams extends NibiAgentWorkspaceTarget {
  instance: import("@nibi/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际。 */
export interface NibiAgentAppToolInstanceForUiParams extends NibiAgentWorkspaceTarget {
  instance: import("@nibi/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface NibiAgentRegisterAppToolsForUiParams extends NibiAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface NibiAgentAppToolCallForUiParams extends NibiAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface NibiAgentResolveAppToolCallForUiParams extends NibiAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface NibiAgentMcpResourceSubscriptionForUiParams extends NibiAgentWorkspaceTarget {
  instance: import("@nibi/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface NibiAgentCancelMcpToolCallForUiParams extends NibiAgentWorkspaceTarget {
  instance: import("@nibi/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
export interface NibiAgentResolveSuggestedPluginReferenceParams extends NibiAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface NibiAgentCreateAutomationParams extends NibiAgentWorkspaceTarget {
  projectId?: string | null;
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: NibiAutomationScheduleRule;
}

export interface NibiAgentUpdateAutomationParams extends NibiAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: NibiAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface NibiAgentAutomationIdParams extends NibiAgentWorkspaceTarget {
  automationId: string;
}

export interface NibiAgentSetAutomationEnabledParams extends NibiAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface NibiAgentDeleteAutomationRunParams extends NibiAgentWorkspaceTarget {
  runId: string;
}
