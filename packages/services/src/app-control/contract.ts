// App-exclusive 会话控制的 Host 契约（与 `@nibi/session-control` 的 App schema 同形）。
// 这里只放 Host 内部与反向 RPC 之间的 wire 形状；模型面的 schema 仍由共享包提供，
// 不在这里复制第二份工具面定义。
import type { Event } from "@nibi/rpc";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type AppControlErrorCode =
  | "invalid_input"
  | "invalid_output"
  | "forbidden"
  | "unavailable"
  | "conflict"
  | "cancelled";

export class AppControlError extends Error {
  readonly code: AppControlErrorCode;

  constructor(code: AppControlErrorCode, message: string) {
    super(message);
    this.name = "AppControlError";
    this.code = code;
  }
}

export type AppControlScope =
  | { kind: "app"; scope: "host"; sourceServerId?: string }
  | { kind: "app"; scope: "project"; projectId: string; sourceServerId?: string }
  | {
      kind: "app";
      scope: "workspace";
      workspacePath: string;
      workspaceIdentity?: string;
      sourceServerId?: string;
    };

export interface AppControlProjectRef {
  kind: "app";
  projectId: string;
  sourceServerId?: string;
}

export interface AppControlProjectEntry {
  project: AppControlProjectRef;
  title: string;
}

export interface AppControlUnavailableSource {
  sourceServerId: string;
  reason: string;
}

export interface AppControlSearchScope {
  scopes: AppControlScope[];
  unavailableSources: AppControlUnavailableSource[];
}

export interface AppControlListProjectsResult {
  projects: AppControlProjectEntry[];
  searchScope: AppControlSearchScope;
}

export interface AppControlOpenSessionResult {
  status: "opened" | "unavailable";
  uiTarget?: string;
  reason?: string;
}

export interface AppControlMutationResult {
  status: "applied" | "rejected" | "unknown";
  requestId: string;
  reason?: string;
}

/** 读归档事实的内部端口（不是模型工具）：未知时不带 archived，不伪造「未归档」。 */
export interface AppControlSessionStateResult {
  archived?: boolean;
}

/** 反向请求的参数（内核 → Host）。 */
export interface AppControlRequestEnvelope {
  callerSessionId: string;
  callId: string;
  turnId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  input: unknown;
}

export type AppControlHostReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: AppControlErrorCode; message: string } };

export const APP_CONTROL_METHODS = {
  listProjects: "appControl/listProjects",
  openSession: "appControl/openSession",
  setSessionArchived: "appControl/setSessionArchived",
  setSessionPinned: "appControl/setSessionPinned",
  sessionArchived: "appControl/sessionArchived",
  cancel: "appControl/cancel",
  /** 内核直接建出会话后的单向通知；不是模型工具，也不返回业务结果。 */
  sessionCreated: "appControl/sessionCreated",
} as const;

export type AppControlMethod = (typeof APP_CONTROL_METHODS)[keyof typeof APP_CONTROL_METHODS];

export const APP_CONTROL_METHOD_NAMES: ReadonlySet<string> = new Set(
  Object.values(APP_CONTROL_METHODS),
);

/** Host 侧处理一条已鉴权的反向请求；不会从模型输入构造身份或范围。 */
export interface IAppControlReverseRpc {
  handle(method: string, params: unknown): Promise<AppControlHostReply>;
}

/**
 * 显式打开会话的 UI 事件。Host 只投递请求，不自己导航、不聚焦或抬升 OS 窗口；
 * Renderer 在自己的任务列表里定位后调用 `settleOpenSession` 回执。
 */
export interface AppControlOpenSessionEvent {
  requestId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sourceServerId?: string;
  projectId?: string;
}

export interface AppControlOpenSessionSettlement {
  requestId: string;
  /** 实际承接打开的窗口/面板标识；opened 时必须有值。 */
  uiTarget?: string;
  /** 无法打开时的原因；与 uiTarget 二选一。 */
  reason?: string;
}

export interface IAppControlNavigationService {
  onOpenSession(): Event<AppControlOpenSessionEvent>;
  /** UI 对一条打开请求的最终回执；重复或迟到的 requestId 不得覆盖已结算结果。 */
  settleOpenSession(settlement: AppControlOpenSessionSettlement): void;
}

export const IAppControlNavigationService = createServiceDescriptor<IAppControlNavigationService>(
  ServiceChannels.AppControlNavigation,
);