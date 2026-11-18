// Node 内核的 App 控制端口：把 4 个动作翻译成 `appControl/*` 反向请求，由 Host 处理。
// 这里不持有项目、任务索引或窗口状态；身份与 workspace 来自 bootstrap 注入的可信绑定。
import {
  listProjectsResultSchema,
  mutationResultSchema,
  openSessionResultSchema,
  SessionControlError,
  type AppListProjectsInput,
  type AppSessionRef,
  type AppTrustedContext,
  type ListProjectsResult,
  type MutationResult,
  type OpenSessionResult,
} from "@nibi/session-control/contracts";
import type { AppSessionControlPort } from "@nibi/contracts";
import {
  nibiAppControlReplySchema,
  nibiProtocolMethods,
  type NibiAppControlReply,
  type NibiProtocolMethod,
} from "@nibi/shared";
import type { NibiProtocolAgentServerContext } from "../nibi-protocol/server-types.js";
import {
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
} from "../nibi-protocol/server-types.js";

const TOOL_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 5_000;

function envelope(ctx: AppTrustedContext, input: unknown) {
  const callId = ctx.toolCallId;
  const root = ctx.rootSession;
  if (!callId) throw new SessionControlError("invalid_input", "Missing tool call identity");
  if (!root) throw new SessionControlError("forbidden", "Missing App session binding");
  return {
    callerSessionId: root.sessionId,
    callId,
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    workspacePath: root.workspacePath,
    ...(root.workspaceIdentity ? { workspaceIdentity: root.workspaceIdentity } : {}),
    input,
  };
}

function mapError(error: unknown): SessionControlError {
  if (error instanceof SessionControlError) return error;
  if (error instanceof ProtocolRequestError) {
    if (error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled)
      return new SessionControlError("cancelled", error.message);
    return new SessionControlError("unavailable", error.message);
  }
  return new SessionControlError(
    "unavailable",
    error instanceof Error ? error.message : String(error),
  );
}

function unwrap<T>(reply: NibiAppControlReply, schema: { parse(value: unknown): T }): T {
  if (!reply.ok) throw new SessionControlError(reply.error.code, reply.error.message);
  return schema.parse(reply.result);
}

export function createProtocolAppSessionControl(
  context: NibiProtocolAgentServerContext,
): AppSessionControlPort {
  async function request<T>(
    method: NibiProtocolMethod,
    ctx: AppTrustedContext,
    input: unknown,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    if (ctx.signal?.aborted) throw new SessionControlError("cancelled", "Call cancelled");
    try {
      const reply = await context.requestClient(
        method,
        envelope(ctx, input),
        nibiAppControlReplySchema,
        {
          timeoutMs: TOOL_TIMEOUT_MS,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      return unwrap(reply, schema);
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.code === "cancelled") {
        // best-effort 撤销；Host 收不到也不改变调用方看到的稳定 cancelled。
        const callId = ctx.toolCallId;
        const root = ctx.rootSession;
        if (callId && root) {
          void context
            .requestClient(
              nibiProtocolMethods.appControlCancel,
              {
                callerSessionId: root.sessionId,
                callId,
                workspacePath: root.workspacePath,
                ...(root.workspaceIdentity
                  ? { workspaceIdentity: root.workspaceIdentity }
                  : {}),
                input: {},
              },
              nibiAppControlReplySchema,
              { timeoutMs: CANCEL_TIMEOUT_MS },
            )
            .catch(() => undefined);
        }
      }
      throw mapped;
    }
  }

  return {
    async listProjects(ctx: AppTrustedContext, input: AppListProjectsInput) {
      return request<ListProjectsResult>(
        nibiProtocolMethods.appControlListProjects,
        ctx,
        input.query === undefined ? {} : { query: input.query },
        listProjectsResultSchema,
      );
    },

    async openSession(
      ctx: AppTrustedContext,
      input: { sessionId: string },
    ): Promise<OpenSessionResult> {
      return request(
        nibiProtocolMethods.appControlOpenSession,
        ctx,
        { sessionId: input.sessionId },
        openSessionResultSchema,
      );
    },

    async setSessionArchived(
      ctx: AppTrustedContext,
      input: { sessionId: string; archived: boolean; requestId: string },
    ): Promise<MutationResult> {
      return request(
        nibiProtocolMethods.appControlSetSessionArchived,
        ctx,
        input,
        mutationResultSchema,
      );
    },

    async setSessionPinned(
      ctx: AppTrustedContext,
      input: { sessionId: string; pinned: boolean; requestId: string },
    ): Promise<MutationResult> {
      return request(
        nibiProtocolMethods.appControlSetSessionPinned,
        ctx,
        input,
        mutationResultSchema,
      );
    },
  } satisfies AppSessionControlPort;
}

export function createAppSessionControlBinding(input: {
  context: NibiProtocolAgentServerContext;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): {
  kind: "app";
  control: AppSessionControlPort;
  context(): AppTrustedContext;
} {
  const rootSession: AppSessionRef = {
    kind: "app",
    workspacePath: input.workspacePath,
    ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    sessionId: input.sessionId,
  };
  return {
    kind: "app",
    control: createProtocolAppSessionControl(input.context),
    context: () => ({
      callerId: `app:${input.sessionId}`,
      rootSession,
      allowedScopes: [{ kind: "app", scope: "host" }],
      discoveryScopes: [],
    }),
  };
}