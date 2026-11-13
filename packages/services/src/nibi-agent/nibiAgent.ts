import type { PluginUiToolResultNotification } from "@nibi/shared/mcp-apps";
import type {
  V4SessionDataMeasureResult,
  V4SessionDataParams,
  V4SessionDataPurgeResult,
} from "@nibi/shared/nibi-protocol-v4";
import type {
  BackgroundBashOutputResult,
  SessionDebugSnapshot,
  NibiSessionContentProfile,
} from "@nibi/shared";
/* eslint-disable max-lines -- Nibi agent service 接口集中声明 protocol/session/workspace 方法，拆分会增加 service descriptor 迁移成本。 */
import type { Event, IDisposable } from "@nibi/rpc";
import { ServiceChannels } from "@nibi/shared";
import type { AppUsageRange, AppUsageSnapshot, NibiTaskTokenUsageResult } from "@nibi/shared";
import type { DynamicWorkflowMode } from "@nibi/shared";
import type { NibiAutomation, NibiAutomationRun } from "@nibi/shared";
import type {
  NibiStorageStartupState,
  NibiDeliveryKind,
  NibiAgentMcpServer,
  NibiBackgroundTurnAttribution,
  TraceId,
  NibiSessionCompactResult,
  NibiSessionGoalAction,
  NibiSessionGoalResult,
  NibiMessageWithParts,
  ModelSelection,
  NibiSessionImportHistory,
  NibiPermissionRequestParams,
  AgentLaneResourceSample,
  NibiMcpTelemetryEvent,
  NibiMcpResourceSample,
  NibiToolExecResource,
  NibiProcessChildProcess,
  NibiMcpListResult,
  NibiPluginsListResult,
  NibiPluginsOverviewResult,
  NibiPluginsMarketplaceMutationResult,
  NibiPluginsInstallResult,
  NibiPluginsReferenceCatalogResult,
  NibiSkillsReferenceCatalogResult,
  NibiMcpReadResourceResult,
  NibiMcpUiCallToolResult,
  NibiMcpUiCancelCallResult,
  NibiMcpUiReadResourceResult,
  NibiMcpUiListResourcesResult,
  NibiMcpUiAppToolAcceptedResult,
  NibiMcpUiRegisterAppToolsResult,
  NibiMcpUiUnregisterAppToolsResult,
  NibiMcpUiListResourceTemplatesResult,
  NibiPluginsListUiSurfacesResult,
  NibiWorkflowsDeleteResult,
  NibiWorkflowsForRunResult,
  NibiWorkflowsGetResult,
  NibiWorkflowsListResult,
  NibiWorkflowsMoveResult,
  NibiWorkflowsRunsResult,
  NibiWorkflowsSaveResult,
  NibiWorkflowsUpdateMetaResult,
  NibiPluginsUninstallResult,
  NibiPluginsRestoreBuiltinResult,
  NibiPluginsConfigureResult,
  NibiPluginsDescribeResult,
  NibiPluginsValidateResult,
  NibiPluginsSetEnabledResult,
  NibiPluginsCancelOperationResult,
  NibiPluginOperationProgressNotification,
  NibiProviderRuntimeHeadersRequestParams,
  NibiProviderRuntimeHeadersCancelled,
  NibiProviderTestModelConnectivityParams,
  NibiProviderTestModelConnectivityResult,
  NibiUserInputRequestParams,
  NibiUserInputResponse,
  NibiSessionEvent,
  NibiSessionInfo,
  NibiSessionMode,
  NibiSessionPersistence,
  NibiSessionSendResult,
  NibiSessionRequestRuntimePreferencesParams,
  NibiSessionRuntimePreferencesResult,
  NibiSessionStateSnapshot,
  NibiSessionSubagentsResult,
  NibiStateUpdatedNotification,
  NibiTaskClientMode,
  NibiBrowserAmbientContext,
  NibiWorkspacePresentation,
  NibiWorkspaceGenerateTextResult,
  NibiWorkspaceGenerateTextParams,
  NibiWorkspaceHookTrustGrantResult,
  NibiAutomationBotDeliveryTarget,
} from "@nibi/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  SessionsIndexReconcileResult,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@nibi/shared/nibi-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./nibiAgentPluginParams.js";
export * from "./nibiAgentWorkflowParams.js";
import type {
  NibiAgentAddPluginMarketplaceParams,
  NibiAgentAutomationIdParams,
  NibiAgentCancelPluginOperationParams,
  NibiAgentConfigurePluginParams,
  NibiAgentResetPluginConfigParams,
  NibiAgentCreateAutomationParams,
  NibiAgentDeleteAutomationRunParams,
  NibiAgentDescribePluginParams,
  NibiAgentInstallPluginParams,
  NibiAgentListMcpServerStatusesParams,
  NibiAgentPluginViewParams,
  NibiAgentPluginReferenceCatalogParams,
  NibiAgentSkillReferenceCatalogParams,
  NibiAgentReadMcpResourceParams,
  NibiAgentReadMcpResourceForUiParams,
  NibiAgentListMcpResourcesForUiParams,
  NibiAgentAppToolCallForUiParams,
  NibiAgentAppToolInstanceForUiParams,
  NibiAgentRegisterAppToolsForUiParams,
  NibiAgentResolveAppToolCallForUiParams,
  NibiAgentMcpResourceSubscriptionForUiParams,
  NibiAgentCallMcpToolForUiParams,
  NibiAgentCancelMcpToolCallForUiParams,
  NibiAgentResolveSuggestedPluginReferenceParams,
  NibiAgentRemovePluginMarketplaceParams,
  NibiAgentRestoreBuiltinPluginParams,
  NibiAgentSetPluginEnabledParams,
  NibiAgentSetAutomationEnabledParams,
  NibiAgentUninstallPluginParams,
  NibiAgentUpdatePluginMarketplaceParams,
  NibiAgentUpdatePluginParams,
  NibiAgentUpdateAutomationParams,
  NibiAgentValidatePluginParams,
  NibiAgentWorkspaceTarget,
} from "./nibiAgentPluginParams.js";
import type {
  NibiAgentDeleteSavedWorkflowParams,
  NibiAgentFindSavedWorkflowForRunParams,
  NibiAgentGetSavedWorkflowParams,
  NibiAgentListSavedWorkflowRunsParams,
  NibiAgentListSavedWorkflowsParams,
  NibiAgentMoveSavedWorkflowParams,
  NibiAgentSaveSavedWorkflowFromRunParams,
  NibiAgentUpdateSavedWorkflowMetaParams,
} from "./nibiAgentWorkflowParams.js";

export interface NibiAgentSessionTarget extends NibiAgentWorkspaceTarget {
  sessionId: string;
}

export interface NibiAgentResumeSessionParams extends NibiAgentSessionTarget {
  additionalDirectories?: string[];
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: NibiAgentMcpServer[];
  // 冷恢复会重建 runtime，工具面隔离必须和 create 保持同一安全边界（CUA 只放行 zcode-cua 工具、
  // 禁 Bash 等）。否则 resume 后模型可见工具面/执行权限会比创建时更宽。
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface NibiAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface NibiAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface NibiAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const NIBI_AGENT_RUNTIME_UNAVAILABLE_CODE = "NIBI_AGENT_RUNTIME_UNAVAILABLE";

export type NibiAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface NibiAgentRuntimeLifecycleEvent extends NibiAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: NibiAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type NibiAgentCuaPermissionObservation = CuaPermissionObservation &
  NibiAgentWorkspaceTarget;

export interface NibiAgentCreateSessionParams extends NibiAgentWorkspaceTarget {
  projectId?: string | null;
  additionalDirectories?: string[];
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: NibiSessionMode;
  model?: ModelSelection;
  persistence?: NibiSessionPersistence;
  thoughtLevel?: string;
  /** automation 执行会话关闭模型二次命名，保持首条用户 query 作为稳定标题。 */
  titleGenerationEnabled?: boolean;
  mcpServers?: NibiAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: NibiSessionImportHistory;
}

export interface NibiAgentListSessionsParams extends NibiAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: NibiAgentRuntimePolicy;
  limit?: number;
}

export interface NibiAgentListSessionSubagentsParams extends NibiAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** 远程 workspace 的宿主连接身份；只用于选择现有 Host，不进入 CLI wire query。 */
  remoteSessionId?: string;
}

export interface NibiAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

/** 项目彻底删除的数据测量；空数组是合法的能力探测请求（只读、不创建会话）。 */
export interface NibiAgentSessionDataParams extends V4SessionDataParams {}

/** purge 的 workspace 决定由哪个 Agent 进程执行：该 cwd 已有进程时交给它，否则交给管理面进程。 */
export interface NibiAgentSessionDataPurgeParams extends V4SessionDataParams {
  workspace: NibiAgentWorkspaceTarget;
}

export interface NibiAgentTaskTokenUsageParams extends NibiAgentSessionTarget {}

export interface NibiAgentReadSessionParams extends NibiAgentSessionTarget {
  deliveryKind?: NibiDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** 被动索引/观察者只能读取现有 runtime，禁止为了读快照拉起 session。 */
  runtimePolicy?: NibiAgentRuntimePolicy;
  /** "index" 仅供 task index：返回剥离大载荷的同结构 snapshot，禁止回写 UI 状态。 */
  contentProfile?: NibiSessionContentProfile;
}

export interface NibiAgentReadSessionMessagesParams extends NibiAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface NibiAgentReadSessionEventsParams extends NibiAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type NibiAgentReadWorkspacePresentationParams = NibiAgentWorkspaceTarget;

export interface NibiAgentGrantWorkspaceHookTrustParams extends NibiAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface NibiAgentSendPromptParamsBase extends NibiAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@nibi/shared/nibi-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only 的当前 IAB 状态；UI/session persistence 仍使用 content 原文。 */
  browserAmbientContext?: NibiBrowserAmbientContext;
  clientMode?: NibiTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** Bot 来源 turn 的稳定回推地址；只在当前 turn 内供 CronCreate 读取。 */
  botDeliveryTarget?: NibiAutomationBotDeliveryTarget;
}

export type NibiAgentSendPromptParams = NibiAgentSendPromptParamsBase &
  NibiBackgroundTurnAttribution;

export interface NibiAgentCompactParams extends NibiAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface NibiAgentGoalParams extends NibiAgentSessionTarget {
  inputId?: string;
  action: NibiSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface NibiAgentSetModelParams extends NibiAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface NibiAgentSetThoughtLevelParams extends NibiAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface NibiAgentSetModeParams extends NibiAgentSessionTarget {
  mode: NibiSessionMode;
  expectedRevision?: number;
}

export interface NibiAgentGenerateWorkspaceTextParams extends NibiAgentWorkspaceTarget {
  selection: NibiWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: NibiWorkspaceGenerateTextParams["messages"];
  tools?: NibiWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * 协议层 RPC 超时。thinking 模型的长请求会超过协议 client 默认的
   * 3 分钟；调用方必须把自身 deadline 透传到这里，否则默认超时先触发、
   * 还会被 onRequestTimeout 误判 stale 杀进程。
   */
  requestTimeoutMs?: number;
}

export interface NibiAgentTestModelConnectivityParams extends NibiAgentWorkspaceTarget {
  selection: NibiProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

// 合并时曾混用 Agent 完整鉴权响应；UI 只能回传请求校验，账号鉴权必须由 Host 合成。
export type ProviderRuntimeHeadersUiResponse =
  | { headersApplied: true; runtimeProviderHeaders: Record<string, string>; errorMessage?: string }
  | { headersApplied: false; errorMessage?: string };

export interface NibiAgentRespondProviderRuntimeHeadersParams extends NibiAgentSessionTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface NibiAgentSessionRuntimePreferencesRequest extends NibiSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface NibiAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: NibiSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface NibiAgentSessionSubscribeParams extends NibiAgentSessionTarget {
  deliveryKind: NibiDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
  /**
   * 内核没有实现旧 `session/subscribe`（-32601）时回调一次。
   *
   * 只有读路径迁移中的消费者用：Rust 内核不投影 legacy `session/event`，
   * 投影源改为 v4 conversation 帧（`taskStreamFromV4`）。Node 内核订阅成功，
   * 这个回调永远不会触发，所以不会出现双流。
   */
  onLegacyStreamUnavailable?: () => void;
}

// ── v4 conversation 通道（竖切）──
// host 只做转发：subscribe/unsubscribe/command 透传给 CLI v4 gateway，
// v4/conversation/frame 通知按 workspace fan-out 给 renderer。

export interface NibiAgentConversationSubscribeParams extends NibiAgentSessionTarget {
  retryInitialization?: string;
  /** 水位不变量：仅当客户端真持有该时刻一致状态才允许带。 */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface NibiAgentConversationUnsubscribeParams extends NibiAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: NibiAgentRuntimePolicy;
}

export interface NibiAgentConversationResyncParams extends NibiAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: NibiAgentRuntimePolicy;
}

/** 行分页 query（rows/range）：按游标向上取一窗历史行。 */
export interface NibiAgentConversationRowsRangeParams extends NibiAgentSessionTarget {
  /** 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。 */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** 当前有效分支里的终态 ExitPlanMode 目录。 */
export type NibiAgentConversationPlansParams = NibiAgentSessionTarget;

/** workflow run 的事件日志分页（详情页审计面）；cursor = journal sequence。 */
export interface NibiAgentConversationWorkflowRunEventsParams extends NibiAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run 的枚举（重启后的发现查询）。 */
export interface NibiAgentConversationWorkflowRunsParams extends NibiAgentSessionTarget {
  limit?: number;
}

// ── dwf 用户面产物──
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出（文件 / markdown / 预置看板），
// 不是 run 的顶层返回值（引擎内部对后者的同名叫法）。

/** 产物清单；UI 冷恢复与中枢详情的 durable 读法。 */
export interface NibiAgentConversationWorkflowRunArtifactsParams extends NibiAgentSessionTarget {
  runId: string;
}

/** 预置看板的取数面；cursor = journal sequence（严格大于）。 */
export interface NibiAgentConversationWorkflowRunArtifactDataParams extends NibiAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** 内容产物的字节，一次一块（≤ 512 KiB，形状逐字照 attachmentRead）。 */
export interface NibiAgentConversationWorkflowRunArtifactReadParams extends NibiAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf 工作区 transcript──
/** 轻行清单：一个 run 的 files.* / git.* / world.run 行，不带正文。 */
export interface NibiAgentConversationWorkflowRunWorkspaceParams extends NibiAgentSessionTarget {
  runId: string;
}

/** 一个工作区节点的正文，按 maxBytes 保形有界化（缺省与上限在 CLI 网关侧）。 */
export interface NibiAgentConversationWorkflowRunNodeResultParams extends NibiAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface NibiAgentBackgroundBashOutputParams extends NibiAgentSessionTarget {
  workId: string;
}

export interface NibiAgentConversationFileChangesParams extends NibiAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface NibiAgentConversationFileRewindPreviewParams extends NibiAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface NibiAgentConversationCommandParams extends NibiAgentWorkspaceTarget {
  /** 仅 Host 消费；显式 NULL 表示全局任务，不向 CLI 发送项目概念。 */
  projectId?: string | null;
  envelope: CommandEnvelope;
  /** 仅 host 内部用于 Browser Use runtime 边界，不进入 v4 wire envelope。 */
  clientMode?: NibiTaskClientMode;
}

export interface NibiAgentCommandsQueryParams extends NibiAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI 不携带 connectionId；connection scope 以 trusted carrier 注入 wire identity。 */
export interface NibiAgentAttachmentBeginParams extends NibiAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface NibiAgentAttachmentChunkParams extends NibiAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface NibiAgentAttachmentTerminalParams extends NibiAgentSessionTarget {
  uploadId: string;
}

export interface NibiAgentAttachmentReadParams extends NibiAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface NibiAgentConversationAttachmentReadParams extends NibiAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface NibiAgentConversationAttachmentStatParams extends NibiAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface NibiAgentAttachmentPreviewSourceParams extends NibiAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** host scope 内部 transport 控制面；connectionId 只能经 trusted carrier 注入。 */
export interface NibiAgentConnectionFlowParams extends NibiAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index：workspace 级列表订阅（无 sessionId 维度）。 */
export interface NibiAgentSessionsIndexSubscribeParams extends NibiAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * 订阅者作用域后缀：CLI 侧重订阅替换按 (connectionId, topic) 判定，
   * host 进程内多个独立消费者（renderer 侧栏 / task-index syncer）订阅同一 topic 时
   * 必须用不同 connectionId，否则互相替换对方的订阅代际。缺省共享 host 连接 id。
   */
  subscriberScope?: string;
  /**
   * task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，
   * 禁止为了建立列表订阅而启动 Agent。缺省保持显式会话入口的旧行为。
   */
  runtimePolicy?: NibiAgentRuntimePolicy;
}

/** workspace-config：workspace 级配置目录订阅（config options + slash 目录）。 */
export interface NibiAgentWorkspaceConfigSubscribeParams extends NibiAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: NibiAgentRuntimePolicy;
}

export type NibiAgentServiceEvent =
  | { type: "session.event"; event: NibiSessionEvent }
  | { type: "state.updated"; notification: NibiStateUpdatedNotification }
  | { type: "permission.request"; request: NibiPermissionRequestParams }
  | { type: "userInput.request"; request: NibiUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: NibiUserInputResponse;
    }
  | { type: "providerRuntimeHeaders.request"; request: NibiProviderRuntimeHeadersRequestParams }
  | { type: "snapshot"; snapshot: NibiSessionStateSnapshot };

export interface NibiAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface NibiAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: NibiProcessChildProcess[];
}

export interface NibiAgentStorageStartupSnapshot {
  generation: number;
  state: NibiStorageStartupState | null;
}

export interface INibiAgentService {
  /** 控制面不需要账号或模型，且不发送普通协议请求。 */
  prepareStorage(params: NibiAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: NibiAgentWorkspaceTarget,
  ): Promise<NibiAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: NibiAgentWorkspaceTarget,
  ): Event<NibiAgentStorageStartupSnapshot>;
  initialize(params: NibiAgentWorkspaceTarget): Promise<NibiAgentInitializeResult>;
  /**
   * 同步 App 全局运行时偏好到所有已活动 workspace；不得为此启动空闲 Agent。
   */
  syncAppRuntimePreferences(preferences: NibiAgentAppRuntimePreferences): Promise<void>;
  /**
   * 动态工作流用户选择变化的信号（docs/dynamic-workflow/launch.md「The user's choice」）：Host 重新计算
   * 生效模式并串行重发 workspace/updateDynamicWorkflowPolicy。有本机设置权威的 Host 以设置文件为准；
   * desktop-attached remote Host 以传入值为准（缺席 = 跟随服务端）。不得为此启动空闲 Agent。
   */
  syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: NibiAgentWorkspaceTarget,
  ): Promise<NibiAgentWorkspaceRuntimeIdentity>;
  createSession(params: NibiAgentCreateSessionParams): Promise<NibiSessionStateSnapshot>;
  resumeSession(params: NibiAgentResumeSessionParams): Promise<NibiSessionStateSnapshot>;
  listSessions(params: NibiAgentListSessionsParams): Promise<NibiSessionInfo[]>;
  listSessionSubagents(
    params: NibiAgentListSessionSubagentsParams,
  ): Promise<NibiSessionSubagentsResult>;
  getAppUsageStats(params: NibiAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: NibiAgentTaskTokenUsageParams): Promise<NibiTaskTokenUsageResult>;
  /**
   * 测量项目会话与目录记忆的可清理体积。只读；旧内核返回 -32601 时抛
   * `NibiAgentSessionDataUnsupportedError`（稳定 code），Host 据此隐藏清理入口。
   */
  measureSessionData(params: NibiAgentSessionDataParams): Promise<V4SessionDataMeasureResult>;
  /**
   * 彻底删除会话数据：运行中/被引用的会话保留，失败项可重试，已不存在的会话按 0 字节成功（幂等）。
   * 只允许本地 workspace；远程数据必须在它自己的设备上删除。
   */
  purgeSessionData(params: NibiAgentSessionDataPurgeParams): Promise<V4SessionDataPurgeResult>;
  /**
   * 探测旧内核是否实现了 `sessionData` 方法：true/false 为确定结果，
   * undefined 表示当前没有可询问的本地运行时（不为此启动空闲 Agent）。
   */
  supportsSessionData(): Promise<boolean | undefined>;
  readSession(params: NibiAgentReadSessionParams): Promise<NibiSessionStateSnapshot>;
  readSessionMessages(
    params: NibiAgentReadSessionMessagesParams,
  ): Promise<NibiMessageWithParts[]>;
  readSessionDebug(params: NibiAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: NibiAgentReadSessionEventsParams): Promise<NibiSessionEvent[]>;
  readWorkspacePresentation(
    params: NibiAgentReadWorkspacePresentationParams,
  ): Promise<NibiWorkspacePresentation>;
  /** 无 task/session 的 Settings 预信任；Agent 会重新发现并校验 canonical snapshot。 */
  grantWorkspaceHookTrust(
    params: NibiAgentGrantWorkspaceHookTrustParams,
  ): Promise<NibiWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: NibiAgentListMcpServerStatusesParams): Promise<NibiMcpListResult>;
  listPlugins(params: NibiAgentPluginViewParams): Promise<NibiPluginsListResult>;
  /**
   * Plugin 对话引用 catalog：session-scoped 只读投影。
   * 走 workspace 级 agent client（session 记录只存在于该进程），不走独立插件管理进程。
   */
  getPluginReferenceCatalog(
    params: NibiAgentPluginReferenceCatalogParams,
  ): Promise<NibiPluginsReferenceCatalogResult>;
  /** Composer Skill 引用 catalog；带 sessionId 时读取该 runtime 的冻结快照。 */
  getSkillReferenceCatalog(
    params: NibiAgentSkillReferenceCatalogParams,
  ): Promise<NibiSkillsReferenceCatalogResult>;
  /** 插件 UI：读取插件 MCP 的 `ui://` 资源；走 session 所在 workspace agent 进程。 */
  openMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPrepareSandboxParams & {
      accountContext?: string;
    },
  ): Promise<import("@nibi/shared/mcp-apps").McpAppInstance>;
  validateMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  recycleMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<boolean>;
  closeMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  readMcpResource(params: NibiAgentReadMcpResourceParams): Promise<NibiMcpReadResourceResult>;
  /** 插件 UI：UI 发起的工具调用；复用既有权限审批，不产生 transcript row。 */
  sampleMcpApp(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiSamplingParams,
  ): Promise<import("@nibi/shared/mcp-apps").McpAppsSamplingResult>;
  cancelMcpAppSampling(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiCancelSamplingParams,
  ): Promise<{ cancelled: boolean }>;
  callMcpToolForUi(params: NibiAgentCallMcpToolForUiParams): Promise<NibiMcpUiCallToolResult>;
  /** 插件 UI 取消带 callId 的进行中 UI 工具调用；agent 侧 abort 到 MCP client。 */
  cancelMcpToolCallForUi(
    params: NibiAgentCancelMcpToolCallForUiParams,
  ): Promise<NibiMcpUiCancelCallResult>;
  /** 插件 UI 页面发起的 `resources/read`，agent 侧限同插件服务器、8 MiB、mimeType 白名单。 */
  readMcpResourceForUi(
    params: NibiAgentReadMcpResourceForUiParams,
  ): Promise<NibiMcpUiReadResourceResult>;
  /** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe 代理。 */
  listMcpResourcesForUi(
    params: NibiAgentListMcpResourcesForUiParams,
  ): Promise<NibiMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi(
    params: NibiAgentListMcpResourcesForUiParams,
  ): Promise<NibiMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi(params: NibiAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  unsubscribeMcpResourceForUi(params: NibiAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  /** App-Provided Tools：页面工具登记 / 注销与模型调用的认领 / 回传（信箱投递走 v4 live 增量）。 */
  registerAppToolsForUi(
    params: NibiAgentRegisterAppToolsForUiParams,
  ): Promise<NibiMcpUiRegisterAppToolsResult>;
  unregisterAppToolsForUi(
    params: NibiAgentAppToolInstanceForUiParams,
  ): Promise<NibiMcpUiUnregisterAppToolsResult>;
  claimAppToolCallForUi(
    params: NibiAgentAppToolCallForUiParams,
  ): Promise<NibiMcpUiAppToolAcceptedResult>;
  resolveAppToolCallForUi(
    params: NibiAgentResolveAppToolCallForUiParams,
  ): Promise<NibiMcpUiAppToolAcceptedResult>;
  /** 插件 UI 工作区级面板入口（已启用插件清单 `ui.surfaces[]`）。 */
  listPluginUiSurfaces(
    params: NibiAgentWorkspaceTarget,
  ): Promise<NibiPluginsListUiSurfacesResult>;
  // 已保存工作流的 GUI 中枢：workspace 级、无会话，每次调用现扫 `<cwd>/.nibi/workflows/`。
  // 全局档传 `scope: "global"`：带 workspace 就用它当载体，不带则由 services 层自选本机载体运行时。
  listSavedWorkflows(params: NibiAgentListSavedWorkflowsParams): Promise<NibiWorkflowsListResult>;
  getSavedWorkflow(params: NibiAgentGetSavedWorkflowParams): Promise<NibiWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: NibiAgentUpdateSavedWorkflowMetaParams,
  ): Promise<NibiWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: NibiAgentDeleteSavedWorkflowParams,
  ): Promise<NibiWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: NibiAgentListSavedWorkflowRunsParams,
  ): Promise<NibiWorkflowsRunsResult>;
  // 在项目档 / 全局档之间移动同名文件：
  // `workspace` 是载体（移到项目传目标项目、移到全局传源项目），`to` 是落点档；不覆盖已存在的目标。
  moveSavedWorkflow(params: NibiAgentMoveSavedWorkflowParams): Promise<NibiWorkflowsMoveResult>;
  // 完成卡的「直接保存」（docs/dynamic-workflow/transcript-and-notifications.md）：按 runId 从
  // journal 取这次 run 实际跑过的脚本落盘，不经模型回合。两者都必带 workspace（journal 在那里）。
  saveSavedWorkflowFromRun(
    params: NibiAgentSaveSavedWorkflowFromRunParams,
  ): Promise<NibiWorkflowsSaveResult>;
  /** 这次 run 对应哪个已保存工作流（推导，不记忆）；顺带回 run 的实参供「再次运行」预填。 */
  findSavedWorkflowForRun(
    params: NibiAgentFindSavedWorkflowForRunParams,
  ): Promise<NibiWorkflowsForRunResult>;
  resolveSuggestedPluginReference(
    params: NibiAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@nibi/shared").NibiPluginsResolveSuggestedReferenceResult>;
  /** 推荐项 Plugin 首次本地检查缺失后的 operation-scoped 刷新进度。 */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<NibiPluginOperationProgressNotification>;
  getPluginsOverview(params: NibiAgentPluginViewParams): Promise<NibiPluginsOverviewResult>;
  /**
   * 资源管理器：枚举本 Host 内全部本地 Agent 进程（含 plugin / mcp-status 泳道），
   * 并向每个存活 runtime 请求 `process/childProcesses`；单个 runtime 失败只让它的 children 为空。
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<NibiAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: NibiAgentAddPluginMarketplaceParams,
  ): Promise<NibiPluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: NibiAgentRemovePluginMarketplaceParams,
  ): Promise<NibiPluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: NibiAgentUpdatePluginMarketplaceParams,
  ): Promise<NibiPluginsMarketplaceMutationResult>;
  installPlugin(params: NibiAgentInstallPluginParams): Promise<NibiPluginsInstallResult>;
  cancelPluginOperation(
    params: NibiAgentCancelPluginOperationParams,
  ): Promise<NibiPluginsCancelOperationResult>;
  uninstallPlugin(params: NibiAgentUninstallPluginParams): Promise<NibiPluginsUninstallResult>;
  updatePlugin(params: NibiAgentUpdatePluginParams): Promise<NibiPluginsInstallResult>;
  restoreBuiltinPlugin(
    params: NibiAgentRestoreBuiltinPluginParams,
  ): Promise<NibiPluginsRestoreBuiltinResult>;
  configurePlugin(params: NibiAgentConfigurePluginParams): Promise<NibiPluginsConfigureResult>;
  resetPluginConfig(
    params: NibiAgentResetPluginConfigParams,
  ): Promise<NibiPluginsConfigureResult>;
  validatePlugin(params: NibiAgentValidatePluginParams): Promise<NibiPluginsValidateResult>;
  describePlugin(params: NibiAgentDescribePluginParams): Promise<NibiPluginsDescribeResult>;
  setPluginEnabled(params: NibiAgentSetPluginEnabledParams): Promise<NibiPluginsSetEnabledResult>;
  // ---- 定时任务(automation)管理 ----
  listAutomations(params: NibiAgentWorkspaceTarget): Promise<NibiAutomation[]>;
  listAllAutomations(): Promise<NibiAutomation[]>;
  createAutomation(params: NibiAgentCreateAutomationParams): Promise<NibiAutomation>;
  updateAutomation(params: NibiAgentUpdateAutomationParams): Promise<NibiAutomation | null>;
  deleteAutomation(params: NibiAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: NibiAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: NibiAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: NibiAgentAutomationIdParams): Promise<NibiAgentRunAutomationNowResult>;
  listAutomationRuns(params: NibiAgentAutomationIdParams): Promise<NibiAutomationRun[]>;
  deleteAutomationRun(params: NibiAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: NibiAgentGenerateWorkspaceTextParams,
  ): Promise<NibiWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: NibiAgentTestModelConnectivityParams,
  ): Promise<NibiProviderTestModelConnectivityResult>;
  /**
   * @deprecated：send 主路径已收敛 v4 sendText 命令。仅剩两个消费点——
   * adapter 带附件输入回退（待附件命令面落地后移除）与 nibiSessionService
   * pass-through；新代码禁止回用。
   */
  sendPrompt(params: NibiAgentSendPromptParams): Promise<NibiSessionSendResult>;
  compactSession(params: NibiAgentCompactParams): Promise<NibiSessionCompactResult>;
  goalSession(params: NibiAgentGoalParams): Promise<NibiSessionGoalResult>;
  closeSession(
    params: NibiAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: NibiAgentSetModelParams): Promise<NibiSessionStateSnapshot>;
  setThoughtLevel(params: NibiAgentSetThoughtLevelParams): Promise<NibiSessionStateSnapshot>;
  setMode(params: NibiAgentSetModeParams): Promise<NibiSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: NibiAgentRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  respondSessionRuntimePreferences(
    params: NibiAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  /**
   * v4 UI 的 Start Plan runtime-auth bridge 只需要本地 pending request 事件，
   * 不能为此额外打开旧 `session/subscribe`，否则会把旧 replay/continuous 读路径
   * 重新带回 v4 pane。
   */
  onDynamicProviderRuntimeHeadersRequest(
    params: NibiAgentSessionTarget,
  ): Event<NibiProviderRuntimeHeadersRequestParams>;
  /**
   * Start Plan runtime headers 的 workspace 级订阅入口（生产应答方使用）。
   * Bug 原因（2026-08-16 web 远控卡死）：session 级入口只随桌面 pane 挂载订阅，
   * web 远控新建会话在桌面没有 pane、web 端无应答方，请求校验请求滞留 pending，
   * 任务永久「工作中」。桌面窗口用本入口为每个打开的 workspace tab 维持常驻应答方；
   * 订阅时先注册 live listener 再按 workspaceKey 前缀补投 pending，与 session 级同语义。
   */
  onDynamicWorkspaceProviderRuntimeHeadersRequest(
    params: NibiAgentWorkspaceTarget,
  ): Event<NibiProviderRuntimeHeadersRequestParams>;
  /** 只投递本 workspace 的校验取消，不属于 conversation stream。 */
  onDynamicWorkspaceProviderRuntimeHeadersCancelled(
    params: NibiAgentWorkspaceTarget,
  ): Event<NibiProviderRuntimeHeadersCancelled>;
  onDynamicSessionRuntimePreferencesRequest(): Event<NibiAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI 进程级资源样本，带 services 打的 lane 标签（CLI 自己不知道 lane）。
   * 使用 dynamic event 避免 RPC 服务在无人订阅时缓冲周期事件；
   * 该事件不属于 session/conversation continuous 或 replayable 状态。
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP 进程生命周期与低频内存事件，仅供可信 Host relay 上报 ARMS。 */
  onDynamicMcpTelemetry(): Event<NibiMcpTelemetryEvent>;
  /** MCP 进程树资源事实，只供可信 Host 汇总上报。 */
  onDynamicMcpResourceSamples(): Event<NibiMcpResourceSample[]>;
  /** Bash 完成事实，仅可信 Host 资源旁路订阅。 */
  onDynamicToolExecResource(): Event<NibiToolExecResource>;
  /**
   * @deprecated 旧协议订阅面（session/subscribe + session/event + state.updated）。
   * task-index syncer 已迁 v4 sessions-index/workspace-config 帧；
   * 仅剩 nibiTaskServiceAdapter.onDynamicTaskEvent（replayable 读路径）消费。
   * 写路径已收敛 v4 命令面；本订阅是读路径投影源。
   */
  onDynamicSessionEvent(params: NibiAgentSessionSubscribeParams): Event<NibiAgentServiceEvent>;
  // ── v4 conversation 通道（竖切）──
  /** RPC attachment 建立后先读取 host 可信 hello。 */
  helloConversationV4(): Promise<HelloMessage>;
  /** hello 校验后回送 clientHello；metadata 不能覆盖 connection mode/profile。 */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** 仅供 trusted host relay/facade；terminal RPC caller 必须被 connection scope 拒绝。 */
  setConnectionFlowStateV4(params: NibiAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: NibiAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: NibiAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: NibiAgentConversationUnsubscribeParams): Promise<void>;
  /** rows/range 行分页 query（loadOlder 游标向上补历史）。 */
  conversationRowsRangeV4(
    params: NibiAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: NibiAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** workflow run 事件日志分页；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunEventsV4(
    params: NibiAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举；journal-backed 的重启后发现面。 */
  conversationWorkflowRunsV4(
    params: NibiAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** workflow run 的用户面产物清单；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunArtifactsV4(
    params: NibiAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页；hook 以 itemCount 变化为信号增量拉取。 */
  conversationWorkflowRunArtifactDataV4(
    params: NibiAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块；授权在 CLI 侧（journal 行才是取字节的依据）。 */
  conversationWorkflowRunArtifactReadV4(
    params: NibiAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 工作区 transcript 的清单。 */
  conversationWorkflowRunWorkspaceV4(
    params: NibiAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文。 */
  conversationWorkflowRunNodeResultV4(
    params: NibiAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: NibiAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: NibiAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: NibiAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: NibiAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: NibiAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: NibiAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: NibiAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: NibiAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: NibiAgentAttachmentTerminalParams): Promise<void>;
  /** Desktop local 已发送视频 source query；远端与 Web 返回 chunked。 */
  attachmentPreviewSourceV4(
    params: NibiAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** 已发送 image/video 只读分块查询；connection scope 注入可信 workspace 连接。 */
  attachmentReadV4(params: NibiAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share 读取 userInput 附件，允许 text/plain 等非媒体类型。 */
  conversationAttachmentReadV4(
    params: NibiAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Share 选择阶段只读 userInput 附件元数据，不读取完整内容。 */
  conversationAttachmentStatV4(
    params: NibiAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** workspace 级下行帧流（v4/conversation/frame），renderer 侧按 topic 自行路由。 */
  onDynamicConversationFrame(
    params: NibiAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** workspace 级 live telemetry 事实；connection facade 仅向可信 desktop-continuous 下游暴露。 */
  onDynamicLocalTtftFacts(
    params: NibiAgentWorkspaceTarget,
  ): Event<import("@nibi/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: NibiAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** 当前窗口全部本地 live task 的 CUA 权限观察；历史、远程与 replayable 不在此事件面。 */
  onDynamicCuaPermissionObservation(): Event<NibiAgentCuaPermissionObservation>;
  /** 本地桌面窗口创建插件页面，不依赖 conversation 订阅。 */
  onDynamicPluginUiToolResult(): Event<
    PluginUiToolResultNotification & { workspacePath: string; workspaceIdentity?: string }
  >;

  /** 只读 CLI 持久事实；不恢复会话运行实例。旧远端可以不提供此能力。 */
  reconcileSessionsIndexV4?(
    params: NibiAgentWorkspaceTarget & { sessionIds: string[] },
  ): Promise<SessionsIndexReconcileResult>;
  // ── M5 sessions-index 通道（列表活性）──
  subscribeSessionsIndexV4(
    params: NibiAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: NibiAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: NibiAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 sessions-index 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicSessionsIndexFrame(
    params: NibiAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config 通道（配置目录活性；task-index syncer 消费）──
  subscribeWorkspaceConfigV4(
    params: NibiAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: NibiAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: NibiAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 workspace-config 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicWorkspaceConfigFrame(
    params: NibiAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * （CLI 重连重订）：agent 进程换代通知（超时回收/崩溃后重新拉起）。
   * v4 订阅活在 CLI 进程内存，进程换代即失效；订阅方（task-index syncer 等）
   * 收到后必须对该 workspaceKey 重发 subscribe，否则帧流静默中断。
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Agent client 在 service 内完成登记后发布 available，当前 client 关闭后发布 unavailable。
   * 这是被动 observer attach/detach 的唯一生命周期信号，不表达用户使用租约。
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: NibiAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** 当前 desktop-local CUA turn 是否仍在执行，用于 Helper recovery 避免中途回收 Agent。 */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: NibiAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const INibiAgentService = createServiceDescriptor<INibiAgentService>(
  ServiceChannels.NibiAgent,
);
