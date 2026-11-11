// 项目数据清理命令：把项目行/任务行与 CLI 的 sessionData 端口接起来。
// NIBI 入口允许对未删除项目清理选中数据（项目容器保留）；删除项目仍是独立软删除。
// 上游对照：packages/services/src/project/data/project-data.ts（3.17.2）。
import { z } from "zod";
import type { IProjectService } from "#src/project/contract.js";
import type {
  ProjectDataMeasureDetail,
  ProjectDataPort,
  ProjectDataPurgeDetail,
  ProjectDataSession,
} from "#src/project/data/contract.js";
import type {
  ProjectDataRepositoryContract,
  ProjectRepositoryContract,
} from "#src/project-storage/contract.js";

const purgeInputSchema = z
  .object({
    projectId: z.string().min(1),
    sessionIds: z.array(z.string().min(1)).optional(),
    directories: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * 可删除目录 = roots ∪ 会话 cwd，扣除仍被范围外项目作为 root、或被范围外任务作为 cwd
 * 使用的目录（共享目录的记忆与检查点保留）。`extraInUse` 是 purge 后仍在运行的会话 cwd。
 * 必须在删除任务行之前调用：候选 cwd 来自项目现有的任务行。
 */
function deletableProjectDirectories(
  repository: Pick<ProjectRepositoryContract, "readTree">,
  rows: ProjectDataRepositoryContract,
  projectId: string,
  extraInUse: readonly string[] = [],
): string[] {
  const projects = repository.readTree({ includeDeleted: true, includeTasks: false }).projects;
  const inUse = new Set([
    // 已软删除的项目也算：它们可以恢复，宁可保留共享目录的数据。
    ...projects
      .filter((project) => project.id !== projectId)
      .flatMap((project) => project.roots.map((root) => root.rootPath)),
    ...rows
      .readTaskScopes()
      .filter((task) => task.projectId !== projectId)
      .map((task) => task.cwd),
    ...extraInUse,
  ]);
  const project = projects.find((entry) => entry.id === projectId);
  const candidates = [
    ...(project?.roots.map((root) => root.rootPath) ?? []),
    ...rows.readProjectTaskRefs(projectId).map((task) => task.workspacePath),
  ];
  return [...new Set(candidates)].filter((path) => !inUse.has(path));
}

export function createProjectDataCommands(options: {
  repository(): Promise<ProjectRepositoryContract>;
  ownerHostId?: string;
  /** 副作用端口由 node.ts 装配；缺省时两条命令报 project.data-unavailable。 */
  data?: {
    port: ProjectDataPort;
    /** 与组织态同一 Host 库的行操作。 */
    repository(): Promise<ProjectDataRepositoryContract>;
  };
  changed(): Promise<void>;
}): Pick<IProjectService, "readProjectDataSupport" | "measureProjectData" | "purgeProjectData"> {
  // 数据只在本机删除：远程项目的数据在其设备上，不开放这条路径。
  const requireLocal = (hostId?: string): NonNullable<typeof options.data> => {
    const owner = options.ownerHostId ?? "local";
    if (owner !== "local" || (hostId && hostId !== owner))
      throw new Error("project.data-local-only");
    if (!options.data) throw new Error("project.data-unavailable");
    return options.data;
  };
  const requireProject = async (id: string) => {
    const repository = await options.repository();
    const project = repository
      .readTree({ includeDeleted: true, includeTasks: false })
      .projects.find((entry) => entry.id === id);
    if (!project) throw new Error("project.not-found");
    return { repository, project };
  };
  const dataRows = (data: NonNullable<typeof options.data>) => data.repository();
  const sessionRefs = (rows: ProjectDataRepositoryContract, id: string): ProjectDataSession[] =>
    rows
      .readProjectTaskRefs(id)
      .map((task) => ({ sessionId: task.taskId, cwd: task.workspacePath }));

  return {
    async readProjectDataSupport(hostId) {
      const owner = options.ownerHostId ?? "local";
      if (owner !== "local" || (hostId && hostId !== owner) || !options.data)
        return { supported: false };
      const supported = await options.data.port.supported();
      return { supported: supported === undefined ? "unknown" : supported };
    },

    async measureProjectData(id, hostId) {
      z.string().min(1).parse(id);
      const data = requireLocal(hostId);
      const { repository } = await requireProject(id);
      const rows = await dataRows(data);
      const refs = sessionRefs(rows, id);
      // cron 绑定的会话由 Host 判定（CLI 看不到 Host 的 automations），它和它的 cwd
      // 都必须算作仍在使用：否则 measure 会把 purge 实际保留的记忆/检查点报成可删。
      const automationRefs = new Set(rows.readAutomationSessionRefs());
      const directories = deletableProjectDirectories(
        repository,
        rows,
        id,
        refs
          .filter((ref) => automationRefs.has(ref.sessionId))
          .map((ref) => ref.cwd),
      );
      const measured = await data.port.measure({ sessions: refs, directories });
      return {
        // 被 cron 引用的会话仍保留行与标题，但可释放字节记 0：与 purge 的
        // kept(reason=referenced) 同口径，UI 也不会默认勾选它。
        sessions: measured.sessions.map((session) =>
          automationRefs.has(session.sessionId) ? { ...session, bytes: 0 } : session,
        ),
        directories: measured.directories,
      } satisfies ProjectDataMeasureDetail;
    },

    async purgeProjectData(input, hostId) {
      const parsed = purgeInputSchema.parse(input);
      const data = requireLocal(hostId);
      const { repository } = await requireProject(parsed.projectId);
      const rows = await dataRows(data);
      const refs = sessionRefs(rows, parsed.projectId);
      // automations / automation_runs 只在 Host 库里：CLI 的 sessionData/purge 看不到它们，
      // 所以由 Host 先摘出这些会话，既保证 purge 不删，也保证它们的 cwd 不被当成可释放目录。
      const automationRefs = new Set(rows.readAutomationSessionRefs());
      const selectedIds = parsed.sessionIds ? new Set(parsed.sessionIds) : undefined;
      const selected = selectedIds ? refs.filter((ref) => selectedIds.has(ref.sessionId)) : refs;
      const cronKept = selected.filter((ref) => automationRefs.has(ref.sessionId));
      const purgeable = selected.filter((ref) => !automationRefs.has(ref.sessionId));

      const sessions = await data.port.purgeSessions(purgeable);
      const deleted = new Set(sessions.deleted.map((entry) => entry.sessionId));
      // 保留下来的会话仍在用自己的 cwd：其记忆与检查点不能删。
      const survivors = refs.filter((ref) => !deleted.has(ref.sessionId)).map((ref) => ref.cwd);
      const candidateDirectories = deletableProjectDirectories(
        repository,
        rows,
        parsed.projectId,
        survivors,
      );
      const requestedDirs = parsed.directories ? new Set(parsed.directories) : undefined;
      const directories = requestedDirs
        ? candidateDirectories.filter((path) => requestedDirs.has(path))
        : candidateDirectories;
      const folders = directories.length
        ? await data.port.purgeDirectories(directories)
        : { memory: [], checkpoints: [], failed: [] };

      // CLI 已删行后才动 Host 行；目录删除失败时保留任务行，重试仍能重新算出失败的目录。
      if (!folders.failed.length) {
        rows.purgeTasks(
          rows.readProjectTaskRefs(parsed.projectId).filter((task) => deleted.has(task.taskId)),
        );
      }
      await options.changed();
      return {
        deleted: sessions.deleted,
        kept: [
          ...sessions.kept,
          ...cronKept.map((ref) => ({
            sessionId: ref.sessionId,
            reason: "referenced" as const,
          })),
        ],
        failed: [...sessions.failed, ...folders.failed],
        memory: folders.memory,
        checkpoints: folders.checkpoints,
      } satisfies ProjectDataPurgeDetail;
    },
  };
}
