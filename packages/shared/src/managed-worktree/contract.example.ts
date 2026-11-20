import { join } from "node:path";
import {
  mapProjectRootsIntoWorktree,
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
} from "./index.js";

/**
 * 契约示例：给一个数据根、源仓库与 worktree 名，算出受管目录、反向解析结果，
 * 以及源仓库内路径在 worktree 里的对应位置。宿主与测试共用这一条纯路径链路。
 */
export function describeManagedWorktreePlacement(input: {
  dataBaseDir: string;
  sourceRoot: string;
  worktreeName: string;
}) {
  const managedRoot = resolveManagedWorktreeRoot(input.dataBaseDir);
  const worktreeRoot = join(managedRoot, "0a1b", input.worktreeName);
  const parsed = parseManagedWorktreePath(
    managedRoot,
    join(worktreeRoot, "src", "index.ts"),
  );
  const mapped = mapProjectRootsIntoWorktree(
    [input.sourceRoot, join(input.sourceRoot, "packages", "app")],
    { sourceRoot: input.sourceRoot, worktreeRoot, cwd: "" },
  );
  return { managedRoot, worktreeRoot, parsed, mapped };
}
