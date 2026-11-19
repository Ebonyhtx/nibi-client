// App-exclusive 会话控制的 Host 服务：发现、打开、归档/置顶。
// 任务索引（tasks-index）是组织状态的唯一权威；这里不读内核 session store，也不中断执行。
import type { INibiTaskService } from "../session/nibiTaskService.js";
import type { IProjectService } from "../project/contract.js";
import type { IRemoteProjectService } from "../remote-projects/contract.js";
import type { IWindowControllerService } from "../window-controller/windowController.js";
import type {
  AppControlListProjectsResult,
  AppControlMutationResult,
  AppControlOpenSessionResult,
  AppControlSessionStateResult,
} from "./contract.js";
import { AppControlError } from "./contract.js";
import type { AppControlTrustedContext } from "./context.js";
import {
  createAppControlDiscoveryDirectory,
  type AppControlDiscoveryDirectory,
} from "./discovery-directory.js";
import type { AppControlNavigationRuntime } from "./navigation.js";

export interface AppControlHostDependencies {
  projectService?: Pick<IProjectService, "readTree" | "readProjects">;
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
  /** 惰性解析：desktop Host 的 window controller 晚于本服务注册。 */
  resolveWindowControllerService?: () =>
    | Pick<IWindowControllerService, "getTaskMeta" | "mutateTask" | "listTaskList">
    | undefined;
  taskService?: Pick<INibiTaskService, "archiveTask" | "unarchiveTask" | "setTaskPinned">;
  navigation: AppControlNavigationRuntime;
  /** 这个 Host 自己是某个 Source 时由装配层给出；本地桌面 Host 不传。 */
  sourceServerId?: string;
  /** 内核直接建出会话后回源 CLI 事实补 task 行；缺席时通知按 no-op 处理。 */
  onSessionCreated?: (target: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => unknown;
  logWarn?: (message: string, error?: unknown) => void;
}

export interface AppControlSetArchivedInput {
  sessionId: string;
  archived: boolean;
  requestId: string;
}

export interface AppControlSetPinnedInput {
  sessionId: string;
  pinned: boolean;
  requestId: string;
}

export interface AppControlService {
  readonly discovery: AppControlDiscoveryDirectory;
  listProjects(
    ctx: AppControlTrustedContext,
    input: { query?: string },
  ): Promise<AppControlListProjectsResult>;
  openSession(
    ctx: AppControlTrustedContext,
    input: { sessionId: string },
    signal?: AbortSignal,
  ): Promise<AppControlOpenSessionResult>;
  setSessionArchived(
    ctx: AppControlTrustedContext,
    input: AppControlSetArchivedInput,
    signal?: AbortSignal,
  ): Promise<AppControlMutationResult>;
  setSessionPinned(
    ctx: AppControlTrustedContext,
    input: AppControlSetPinnedInput,
    signal?: AbortSignal,
  ): Promise<AppControlMutationResult>;
  /**
   * 读目标的归档事实，供 CLI fork 在 owner 创建子会话之前拒绝归档目标。
   * 目标不在本 Host 可信范围或来源不匹配时按 forbidden 失败，不泄露存在性。
   */
  getSessionArchived(
    ctx: AppControlTrustedContext,
    input: { sessionId: string },
    signal?: AbortSignal,
  ): Promise<AppControlSessionStateResult>;
  /** 内核直接建出会话后的单向通知：只补 Host 行，不中断/不改目标会话执行。 */
  noteSessionCreated(input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutation(
  status: AppControlMutationResult["status"],
  requestId: string,
  reason?: string,
): AppControlMutationResult {
  return {
    status,
    requestId,
    ...(reason ? { reason } : {}),
  };
}

export function createAppControlService(deps: AppControlHostDependencies): AppControlService {
  const discovery = createAppControlDiscoveryDirectory({
    ...(deps.projectService ? { projectService: deps.projectService } : {}),
    ...(deps.remoteProjectService ? { remoteProjectService: deps.remoteProjectService } : {}),
    ...(deps.resolveWindowControllerService
      ? { resolveWindowControllerService: deps.resolveWindowControllerService }
      : {}),
    ...(deps.sourceServerId ? { sourceServerId: deps.sourceServerId } : {}),
    ...(deps.logWarn ? { logWarn: deps.logWarn } : {}),
  });

  const windowController = () => deps.resolveWindowControllerService?.();

  async function requireSession(sessionId: string) {
    const resolved = await discovery.resolveSession(sessionId);
    if (!resolved || resolved.sessionId !== sessionId) {
      throw new AppControlError("forbidden", "Target session is outside the trusted scope");
    }
    return resolved;
  }

  /**
   * 来源归属判定（上游 `taskFromSnapshot` 的来源部分）：Source Host 只能操作自己来源的会话。
   * 桌面聚合 Host 没有 sourceServerId，跨来源操作必须路由到 owning host，不能落到本机任务索引。
   * 未知/不匹配一律 forbidden，与目标不存在同一错误，不泄露它在别处是否存在。
   */
  function assertTargetSource(target: Awaited<ReturnType<typeof requireSession>>): void {
    if (!deps.sourceServerId) return;
    if (target.sourceServerId !== deps.sourceServerId)
      throw new AppControlError("forbidden", "Session source does not match this Host");
  }

  /** 归档事实：本机任务树直接给出；远端只信窗口投影的 archived 列表。 */
  async function isArchived(
    target: Awaited<ReturnType<typeof requireSession>>,
  ): Promise<boolean | undefined> {
    if (target.archived !== undefined) return target.archived;
    const controller = windowController();
    if (!controller) return undefined;
    try {
      const archived = await controller.listTaskList({
        kind: "archived",
        workspaceScopes: [
          {
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity
              ? { workspaceIdentity: target.workspaceIdentity }
              : {}),
          },
        ],
        sortBy: "updated",
        limit: 200,
      });
      return archived.items.some((item) => item.taskId === target.sessionId);
    } catch (error) {
      deps.logWarn?.("app-control: reading archived task projection failed", error);
      return undefined;
    }
  }

  async function mutate(
    ctx: AppControlTrustedContext,
    target: Awaited<ReturnType<typeof requireSession>>,
    mutationInput:
      | { kind: "archive"; archived: boolean }
      | { kind: "pin"; pinned: boolean },
    requestId: string,
  ): Promise<AppControlMutationResult> {
    const controller = windowController();
    // 归属判定已由 assertTargetSource 完成；这里只区分「本 Host 自己的行」与「其他 source 的行」。
    // 目标属于其他 source 时只允许经 owning host 路由，绝不在本地任务索引写一份再报错。
    const ownedByThisHost = !target.sourceServerId || target.sourceServerId === deps.sourceServerId;
    const address = {
      taskId: target.sessionId,
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.sourceServerId ? { sourceServerId: target.sourceServerId } : {}),
    };
    if (!ownedByThisHost) {
      if (!controller?.mutateTask)
        throw new AppControlError("unavailable", "The owning host is unavailable");
      try {
        const meta = await controller.mutateTask({ address, mutation: mutationInput });
        if (!meta) return mutation("unknown", requestId, "Task index returned no task");
        return mutation("applied", requestId);
      } catch (error) {
        deps.logWarn?.("app-control: cross-source task mutation failed", error);
        // 已交给 owning host，结果不确定；不能回退到本地任务索引。
        return mutation("unknown", requestId, reasonOf(error));
      }
    }
    try {
      if (controller?.mutateTask) {
        const meta = await controller.mutateTask({
          address,
          mutation: mutationInput,
        });
        if (!meta) return mutation("unknown", requestId, "Task index returned no task");
        // 任务索引的写操作返回更新后的 meta（不一定是 ProjectTask 投影，不带 archived/pinned）。
        // 有 meta 就说明这次写入已被权威索引接受；幂等冲突由索引自己处理。
        return mutation("applied", requestId);
      }
      if (deps.taskService) {
        const params = {
          taskId: target.sessionId,
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        };
        if (mutationInput.kind === "archive") {
          const meta = mutationInput.archived
            ? await deps.taskService.archiveTask(params)
            : await deps.taskService.unarchiveTask(params);
          return mutation(meta ? "applied" : "unknown", requestId);
        }
        const meta = await deps.taskService.setTaskPinned({
          ...params,
          pinned: mutationInput.pinned,
        });
        return mutation(meta ? "applied" : "unknown", requestId);
      }
      throw new AppControlError("unavailable", "The task index is unavailable in this host");
    } catch (error) {
      if (error instanceof AppControlError) throw error;
      deps.logWarn?.("app-control: task mutation failed", error);
      return mutation("unknown", requestId, reasonOf(error));
    }
  }

  return {
    discovery,

    async listProjects(ctx, input) {
      // discovery 只返回 Host 自己目录里的来源；allowedScopes 仍由 context 决定，模型输入不参与。
      void ctx;
      return discovery.listProjects(input.query);
    },

    async openSession(ctx, input, signal) {
      const target = await requireSession(input.sessionId);
      assertTargetSource(target);
      if (signal?.aborted) {
        throw new AppControlError("cancelled", "Open request was cancelled");
      }
      // 上游只打开当前目录投影里的任务：归档目标按 task-not-found 拒绝，不自动取消归档。
      // 远端归档事实不可确认时也 fail closed，不能把未知状态当成「未归档」静默打开。
      const archived = await isArchived(target);
      if (archived === true || (archived === undefined && target.sourceServerId)) {
        return { status: "unavailable", reason: "project.task-not-found" };
      }
      if (signal?.aborted) {
        throw new AppControlError("cancelled", "Open request was cancelled");
      }
      const result = await deps.navigation.openSession(
        {
          sessionId: target.sessionId,
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          ...(target.sourceServerId ? { sourceServerId: target.sourceServerId } : {}),
          ...(target.projectId ? { projectId: target.projectId } : {}),
        },
        signal,
      );
      if (signal?.aborted || result.reason === "cancelled") {
        throw new AppControlError("cancelled", "Open request was cancelled");
      }
      return result;
    },

    async setSessionArchived(_ctx, input, signal) {
      if (signal?.aborted) {
        throw new AppControlError("cancelled", "Mutation was cancelled before it started");
      }
      const target = await requireSession(input.sessionId);
      assertTargetSource(target);
      return mutate(
        _ctx,
        target,
        { kind: "archive", archived: input.archived },
        input.requestId,
      );
    },

    async setSessionPinned(_ctx, input, signal) {
      if (signal?.aborted) {
        throw new AppControlError("cancelled", "Mutation was cancelled before it started");
      }
      const target = await requireSession(input.sessionId);
      assertTargetSource(target);
      return mutate(_ctx, target, { kind: "pin", pinned: input.pinned }, input.requestId);
    },

    async getSessionArchived(_ctx, input, signal) {
      if (signal?.aborted) {
        throw new AppControlError("cancelled", "Session state request was cancelled");
      }
      const target = await requireSession(input.sessionId);
      assertTargetSource(target);
      const archived = await isArchived(target);
      // 产品会话的归档事实不可确认时 fail closed：CLI fork 不能拿一个未知状态去创建子会话。
      if (archived === undefined)
        throw new AppControlError("unavailable", "Session archive state is unavailable");
      return { archived };
    },

    async noteSessionCreated(input) {
      await deps.onSessionCreated?.(input);
    },
  };
}