import type { MessageWithParts, SessionEvent, SessionInfo } from "@nibi/contracts";
import {
  nibiAppControlReplySchema,
  nibiProtocolMethods,
  type NibiWorkspaceRef,
} from "@nibi/shared";
import { SessionControlError } from "@nibi/session-control/contracts";
import {
  createNibiSessionControlRuntime,
  type NibiSessionControlRuntime,
} from "../cli-session-control/index.js";
import type { NibiProtocolAgentServerContext } from "./server-types.js";
import { createWorkspaceNibiApp } from "./workspace-model-runtime.js";

/**
 * 每个 workspace 一个 CLI session-control owner。createRecord 在真实 session 创建/恢复时调用；
 * 临时 app（模型连通性、workspace generateText）不经过这里，因此不会污染会话控制列表。
 */
export function sessionControlRuntimeForWorkspace(
  context: NibiProtocolAgentServerContext,
  workspace: NibiWorkspaceRef,
  projectActiveMessages: (
    messages: MessageWithParts[],
    session: SessionInfo | null | undefined,
    rewindEvents: readonly SessionEvent[],
  ) => MessageWithParts[],
): NibiSessionControlRuntime | undefined {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return undefined;
  const runtimes = (context.sessionControlRuntimes ??= new Map());
  const key = workspace.workspaceKey;
  const existing = runtimes.get(key);
  if (existing) return existing;
  let runtime!: NibiSessionControlRuntime;
  runtime = createNibiSessionControlRuntime({
    workspace: {
      kind: "cli",
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    },
    sessionStore,
    projectActiveMessages,
    // 归档事实归 App Host 任务索引；独立 CLI/旧 Host 没有该方法时保持缺席，
    // 不把「查不到」伪造为「未归档」。fork 在拿到 true 时先于 owner 拒绝。
    isSessionArchived: async (session) => {
      try {
        const reply = await context.requestClient(
          nibiProtocolMethods.appControlSessionArchived,
          {
            callerSessionId: session.sessionId,
            callId: `session-archived-${session.sessionId}-${Date.now()}`,
            workspacePath: session.workspacePath,
            ...(session.workspaceIdentity
              ? { workspaceIdentity: session.workspaceIdentity }
              : {}),
            input: { sessionId: session.sessionId },
          },
          nibiAppControlReplySchema,
          { timeoutMs: 5_000 },
        );
        if (!reply.ok) {
          // Host 能确认这是产品会话但归档事实不可用时 fail closed；forbidden 等
          // 表示目标不是本 Host 的产品会话（独立 CLI 历史），维持原 owner 语义。
          if (reply.error.code === "unavailable")
            throw new SessionControlError("unavailable", reply.error.message);
          return undefined;
        }
        const archived = (reply.result as { archived?: unknown } | null)?.archived;
        return archived === true ? true : archived === false ? false : undefined;
      } catch (error) {
        if (error instanceof SessionControlError) throw error;
        // 没有 App Host、旧 Host 不支持或连接断开：CLI fork 维持原 owner 语义。
        return undefined;
      }
    },
    createRootApp: (request) =>
      createWorkspaceNibiApp(context, workspace, {
        env: context.deps.env,
        eventStore: context.deps.createSessionEventStore(request.sessionId),
        resume: request.resume,
        sessionControlHost: runtime.control,
        sessionStore,
        version: context.deps.version,
        ...(request.traceContext ? { traceContext: request.traceContext } : {}),
        runtimeConfig: {
          workingDirectory: request.cwd,
        },
      }),
  });
  runtimes.set(key, runtime);
  return runtime;
}
