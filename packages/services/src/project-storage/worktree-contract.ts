/**
 * 受管 worktree 的 Task 行读写端口。单独成文件，避免 ProjectRepositoryContract 的公开
 * 方法数超过架构上限；由同一 ProjectRepository 实现。
 *
 * 只导入类型，不在运行期依赖 contract.ts。
 */
import type { ProjectTaskRef } from "./project-refs.js";

export interface ProjectWorktreeRepositoryContract {
  /** 任务行记录的 cwd（`root_path`）；没有这一行时返回 null，不回退为 workspace 路径。 */
  readTaskCwd(task: ProjectTaskRef): string | null;
  /**
   * 撤销一条尚无 CLI 事实的创建预留。released = 已撤销；absent = 没有这一行；
   * kept = 行已有 CLI 事实（会话已存在），不删除。
   */
  releaseReservedTask(input: { task: ProjectTaskRef }): "released" | "absent" | "kept";
  /** 只读：本 Host 上运行在指定受管 worktree 中的未删除任务（按 worktree_root 精确匹配）。 */
  listTasksByWorktree(input: {
    worktreeRoot: string;
  }): Array<ProjectTaskRef & { projectId: string | null; title: string; archived: boolean }>;
}
