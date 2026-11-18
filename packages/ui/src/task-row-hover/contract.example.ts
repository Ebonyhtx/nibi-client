/**
 * task-row-hover 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { NibiTaskMeta } from "@nibi/shared";
import type { TaskRowIdentityHoverCardProps } from "./contract.js";

export function exampleTaskRowHoverProps(
  task: NibiTaskMeta,
  rowElement: TaskRowIdentityHoverCardProps["children"],
): TaskRowIdentityHoverCardProps {
  return {
    task,
    workspaceLabel:
      task.workspacePath
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? task.workspacePath,
    children: rowElement,
  };
}
