import type { NibiTaskChangeSummary, NibiTaskMeta } from "@nibi/shared";
import { getPathLeaf } from "@/lib/path.js";

const EMPTY_CHANGE_PARTS: string[] = [];

/**
 * 卡片标题与侧栏行名保持同源。
 *
 * NIBI 的受管 worktree 任务直接在 worktree 路径上创建，`tasks-index` 只持久化
 * `workspacePath`，没有独立的 `worktreeRoot`/`cwd` 可以派生 `<仓库名> · <bucket>`。
 * 因此这里不伪造 worktree 标签：有行内名称就用行内名称，没有才回退到路径叶子。
 */
export function resolveTaskRowWorkspaceLabel(
  task: Pick<NibiTaskMeta, "workspacePath">,
  workspaceLabel: string,
): string {
  const normalizedLabel = workspaceLabel.trim();
  if (normalizedLabel.length > 0) {
    return normalizedLabel;
  }
  return getPathLeaf(task.workspacePath);
}

/** 变更统计与行内 `+N/-N` 同口径；为 0 的一侧不显示。 */
export function formatTaskRowChangeParts(summary: NibiTaskChangeSummary | null): string[] {
  if (!summary) {
    return EMPTY_CHANGE_PARTS;
  }

  const parts: string[] = [];
  if (summary.added > 0) {
    parts.push(`+${summary.added}`);
  }
  if (summary.removed > 0) {
    parts.push(`-${summary.removed}`);
  }
  return parts;
}
