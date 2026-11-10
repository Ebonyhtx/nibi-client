import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

/**
 * 分组任务行的选中判定。
 *
 * 渲染性能契约（docs/chat/message-render-performance.md）：行只接收「自己是否选中」，
 * 不接收全局 activeTaskId。判定在列表层做一次，选中切换时只有旧/新两行拿到不同的
 * `active`，其余行的 props 完全不变，memo 可以跳过。
 */
export function resolveGroupedTaskActive(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  scope: {
    activeTaskId: string | null;
    activeWorkspacePath: string;
    activeWorkspaceIdentity?: string;
  },
): boolean {
  return (
    scope.activeTaskId === task.taskId &&
    buildTaskWorkspaceKey(scope.activeWorkspacePath, scope.activeWorkspaceIdentity) ===
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)
  );
}
