/**
 * 项目数据清理需要的 Host 行读写；由同一 ProjectRepository 实现。
 * 单独成文件，避免主契约的公开方法数超过架构上限。
 * 注意：不能从 contract.ts 导入 ProjectTaskRef，否则两个契约文件形成循环依赖。
 */
export interface ProjectDataTaskRef {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ProjectDataRepositoryContract {
  /** 项目下全部任务行（含已删除行），用于测量与删行。 */
  readProjectTaskRefs(projectId: string): ProjectDataTaskRef[];
  /** 全库任务行所属项目与 cwd，用于排除仍被别的项目/任务使用的目录。 */
  readTaskScopes(): Array<{ projectId: string | null; cwd: string }>;
  /**
   * Host 定时任务仍指向的会话：`automations.target_task_id` 是任务绑定的执行会话，
   * `automation_runs.session_id` 是已派发运行实际使用的会话。两类行都在任务索引库里，
   * 删掉会话会让定时任务失去目标或运行历史指向悬空，因此清理时必须按「被引用」保留。
   */
  readAutomationSessionRefs(): string[];
  /** CLI 已删除会话后移除 Host 行；目录删除失败时保留行供重试。 */
  purgeTasks(tasks: readonly ProjectDataTaskRef[]): void;
}
