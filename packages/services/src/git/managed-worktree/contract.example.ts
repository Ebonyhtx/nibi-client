import { parseWorktreeListPorcelain } from "./index.js";

/**
 * 契约示例：把 `git worktree list --porcelain -z` 的输出收敛成 UI 需要的分支清单。
 * 解析是纯函数，宿主只负责执行 git 命令与错误分类。
 */
export function readWorktreeBranches(porcelainOutput: string): Array<{
  path: string;
  branch: string | null;
  prunable: boolean;
}> {
  return parseWorktreeListPorcelain(porcelainOutput).map((record) => ({
    path: record.path,
    branch: record.branchName,
    prunable: record.prunable,
  }));
}
