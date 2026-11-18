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
    | Pick<IWindowControllerService, "getTaskMeta" | "mutateTask">
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

  async function mutate(
    ctx: AppControlTrustedContext,
    target: Awaited<ReturnType<typeof requireSession>>,
    mutationInput:
      | { kind: "archive"; archived: boolean }
      | { kind: "pin"; pinned: boolean },
    requestId: string,
  ): Promise<AppControlMutationResult> {
    const controller = windowController();
    if (target.sourceServerId && !controller) {
      return mutation(
        "rejected",
        requestId,
        "Cross-source mutation requires the window controller",
      );
    }
    const address = {
      taskId: target.sessionId,
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.sourceServerId ? { sourceServerId: target.sourceServerId } : {}),
    };
    try {
      if (controller) {
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
      return mutation("rejected", requestId, "The task index is unavailable in this host");
    } catch (error) {
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
      return mutate(_ctx, target, { kind: "pin", pinned: input.pinned }, input.requestId);
    },

    async noteSessionCreated(input) {
      await deps.onSessionCreated?.(input);
    },
  };
}