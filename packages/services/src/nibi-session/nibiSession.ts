import { ServiceChannels } from "@nibi/shared";
import type {
  TraceId,
  NibiAgentMcpServer,
  NibiDeliveryKind,
  NibiMessageWithParts,
  ModelSelection,
  NibiPermissionRequestParams,
  NibiProviderRuntimeHeadersRequestParams,
  NibiUserInputRequestParams,
  NibiUserInputResponse,
  NibiSessionInfo,
  NibiSessionImportHistory,
  NibiSessionEvent,
  NibiSessionMode,
  NibiSessionPersistence,
  NibiSessionStateSnapshot,
  NibiStateUpdatedNotification,
  NibiWorkspacePresentation,
} from "@nibi/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { ProviderRuntimeHeadersUiResponse } from "#src/nibi-agent/nibiAgent.js";

export interface NibiSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type NibiSessionReadWorkspacePresentationParams = NibiSessionWorkspaceTarget;

export interface NibiTaskTarget extends NibiSessionWorkspaceTarget {
  sessionId: string;
}

export interface NibiSessionCreateParams extends NibiSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: NibiSessionMode;
  model?: ModelSelection;
  persistence?: NibiSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: NibiAgentMcpServer[];
  importedHistory?: NibiSessionImportHistory;
}

export interface NibiSessionResumeParams extends NibiTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: NibiAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface NibiSessionListParams extends NibiSessionWorkspaceTarget {
  limit?: number;
}

export interface NibiSessionReadParams extends NibiTaskTarget {
  deliveryKind?: NibiDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface NibiSessionMessagesParams extends NibiTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface NibiSessionEventsParams extends NibiTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface NibiSessionSetModelParams extends NibiTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface NibiSessionSetThoughtLevelParams extends NibiTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface NibiSessionSetModeParams extends NibiTaskTarget {
  mode: NibiSessionMode;
  expectedRevision?: number;
}

export interface NibiSessionRespondProviderRuntimeHeadersParams extends NibiTaskTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface NibiSessionSubscribeParams extends NibiTaskTarget {
  deliveryKind: NibiDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type NibiSessionServiceEvent =
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

export interface NibiSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface NibiSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface INibiSessionService {
  initializeWorkspace(params: NibiSessionWorkspaceTarget): Promise<NibiSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: NibiSessionWorkspaceTarget,
  ): Promise<NibiSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: NibiSessionReadWorkspacePresentationParams,
  ): Promise<NibiWorkspacePresentation>;
  createSession(params: NibiSessionCreateParams): Promise<NibiSessionStateSnapshot>;
  resumeSession(params: NibiSessionResumeParams): Promise<NibiSessionStateSnapshot>;
  listSessions(params: NibiSessionListParams): Promise<NibiSessionInfo[]>;
  readSession(params: NibiSessionReadParams): Promise<NibiSessionStateSnapshot>;
  readSessionMessages(params: NibiSessionMessagesParams): Promise<NibiMessageWithParts[]>;
  readSessionEvents(params: NibiSessionEventsParams): Promise<NibiSessionEvent[]>;
  promoteDeferredDraftSession(params: NibiTaskTarget): Promise<void>;
  closeSession(params: NibiTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: NibiTaskTarget): Promise<boolean>;
  setModel(params: NibiSessionSetModelParams): Promise<NibiSessionStateSnapshot>;
  setThoughtLevel(params: NibiSessionSetThoughtLevelParams): Promise<NibiSessionStateSnapshot>;
  setMode(params: NibiSessionSetModeParams): Promise<NibiSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: NibiSessionRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  // M5 删波次 2：onDynamicSessionEvent（旧 session/subscribe 词表的 renderer 订阅面）
  // 已删除——v4 UI 走 agentService 的 conversation/sessions-index 帧通道，
  // 该方法在 renderer 侧已无任何调用者（grep packages/ui packages/desktop 为零）。
}

export const INibiSessionService = createServiceDescriptor<INibiSessionService>(
  ServiceChannels.NibiSession,
);
