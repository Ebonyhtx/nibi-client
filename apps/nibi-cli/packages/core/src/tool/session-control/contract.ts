import type { SessionControlBinding, SessionTaskType } from "@nibi/contracts";

export type { SessionControlBinding } from "@nibi/contracts";

/**
 * 注册与执行共用的可信门：只有根会话匹配的 interactive / fork / workflow_parent runtime 才拿到
 * 会话控制绑定；子代理（runtimeScope=subagent）永不注入。注册与 handler 必须走同一个入口，
 * 避免「工具面注册了、执行时又被另一份判断放行」。
 */
export function sessionControlForRuntime(
  binding: SessionControlBinding | undefined,
  taskType: SessionTaskType | undefined,
  sessionId: string,
  runtimeScope?: "main" | "subagent",
): SessionControlBinding | undefined {
  if (runtimeScope === "subagent") return undefined;
  if (
    taskType !== undefined &&
    taskType !== "interactive" &&
    taskType !== "fork" &&
    taskType !== "workflow_parent"
  )
    return undefined;
  if (binding?.context().rootSession.sessionId !== sessionId) return undefined;
  return binding;
}
