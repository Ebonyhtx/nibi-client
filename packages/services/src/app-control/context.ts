// App 控制的可信上下文：只从反向请求信封与 Host 自己的目录派生身份、授权与发现范围。
// 模型输入（工具参数）不能提供 callerSessionId、workspacePath、allowedScopes 或 uiTarget。
import { z } from "zod";
import type { AppControlRequestEnvelope, AppControlScope } from "./contract.js";

const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() === value && !value.includes("\0"), {
    message: "Identifier must be canonical",
  });

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value) && !value.includes("\0"),
    { message: "Expected an absolute workspace path" },
  );

export const appControlEnvelopeSchema = z
  .object({
    callerSessionId: identifier,
    callId: identifier,
    turnId: identifier.optional(),
    workspacePath: absolutePath,
    workspaceIdentity: identifier.optional(),
    input: z.unknown(),
  })
  .strict();

export const listProjectsInputSchema = z
  .object({
    query: z.string().max(4096).optional(),
  })
  .strict();

export const openSessionInputSchema = z.object({ sessionId: identifier }).strict();

/** 内核直接建出会话后的单向通知：只带新会话 id，工作区由请求信封给出。 */
export const sessionCreatedInputSchema = z.object({ sessionId: identifier }).strict();

export const setSessionArchivedInputSchema = z
  .object({
    sessionId: identifier,
    archived: z.boolean(),
    requestId: identifier,
  })
  .strict();

export const setSessionPinnedInputSchema = z
  .object({
    sessionId: identifier,
    pinned: z.boolean(),
    requestId: identifier,
  })
  .strict();

/** 内部只读查询：返回目标的归档事实，不做组织写入。 */
export const sessionArchivedInputSchema = z.object({ sessionId: identifier }).strict();

export const cancelInputSchema = z.object({}).strict();

/** 一条已鉴权的 App 控制调用；范围由 Host 派生，永不由模型输入补齐。 */
export interface AppControlTrustedContext {
  callerSessionId: string;
  callId: string;
  turnId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Host 自己的授权范围：本 Host 的 host scope。 */
  allowedScopes: readonly AppControlScope[];
  /** 本次真正可搜索的来源：本机 + 在线项目来源。 */
  discoveryScopes: readonly AppControlScope[];
  /** Host 绑定的窗口（模型不能提供）；navigation 回执会给出真实 uiTarget。 */
  uiTarget?: string;
}

export function parseEnvelope(params: unknown): AppControlRequestEnvelope {
  return appControlEnvelopeSchema.parse(params) as AppControlRequestEnvelope;
}

/** 本 Host 的 host scope；sourceServerId 只在调用来自某个 Source 时由装配层传入。 */
export function hostScope(sourceServerId?: string): AppControlScope {
  return {
    kind: "app",
    scope: "host",
    ...(sourceServerId ? { sourceServerId } : {}),
  };
}

export function projectScope(projectId: string, sourceServerId?: string): AppControlScope {
  return {
    kind: "app",
    scope: "project",
    projectId,
    ...(sourceServerId ? { sourceServerId } : {}),
  };
}

export function workspaceScope(
  workspacePath: string,
  workspaceIdentity?: string,
  sourceServerId?: string,
): AppControlScope {
  return {
    kind: "app",
    scope: "workspace",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(sourceServerId ? { sourceServerId } : {}),
  };
}

/** 同一个 scope 的身份键；发现范围与项目引用去重共用。 */
export function scopeKey(scope: AppControlScope): string {
  return `${scope.scope}\0${scope.sourceServerId ?? ""}\0${
    scope.scope === "host"
      ? ""
      : scope.scope === "project"
        ? scope.projectId
        : scope.workspaceIdentity?.trim() || scope.workspacePath
  }`;
}

export function createTrustedContext(
  envelope: AppControlRequestEnvelope,
  discoveryScopes: readonly AppControlScope[],
  sourceServerId?: string,
): AppControlTrustedContext {
  return {
    callerSessionId: envelope.callerSessionId,
    callId: envelope.callId,
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    workspacePath: envelope.workspacePath,
    ...(envelope.workspaceIdentity ? { workspaceIdentity: envelope.workspaceIdentity } : {}),
    allowedScopes: [hostScope(sourceServerId)],
    discoveryScopes,
  };
}