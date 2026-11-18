import type { MessageWithParts, SessionEvent, SessionInfo } from "@nibi/contracts";
import type { NibiWorkspaceRef } from "@nibi/shared";
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
