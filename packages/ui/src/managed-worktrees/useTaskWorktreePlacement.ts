// 会话的 cwd 与所在受管 worktree。
// cwd 读 Host 的 tasks-index（ProjectDirectories.workspacePath 就是 root_path）；worktree 根从
// 受管布局识别，可用性由 Host 的 isWorktreeAvailable 裁决。远程会话不读取。
import { useEffect, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { managedWorktreeRootFromPath } from "./worktreeLabel.js";

export interface TaskWorktreePlacement {
  cwd: string;
  /** 普通任务为 undefined。 */
  worktreeRoot: string | undefined;
  /** worktree 已被删除时为 false，任务按只读处理；普通任务恒为 true。 */
  worktreeAvailable: boolean;
}

interface PlacementState {
  key: string;
  placement: TaskWorktreePlacement;
}

export function useTaskWorktreePlacement({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null | undefined;
}): TaskWorktreePlacement {
  // 无 ServiceProvider（独立组件测试/旧宿主）时退化为 workspace 目录，不抛错。
  const services = useOptionalServices();
  const managedWorktreeService = services?.managedWorktreeService;
  const projectService = services?.projectService;
  const broadcastService = useOptionalBaseWorkspaceServices()?.broadcastService;
  const local = !workspaceIdentity?.trim() && !remoteSessionId;
  const key = `${workspacePath}\u0000${sessionId ?? ""}\u0000${local ? "local" : "remote"}`;
  const [state, setState] = useState<PlacementState | null>(null);
  const [unavailableRoot, setUnavailableRoot] = useState<string | null>(null);

  useEffect(() => {
    // 没有受管 worktree 服务的宿主（远端/手机/旧 Host）不需要为每个会话查目录：
    // 只有本机启用受管 worktree 时才读 cwd 并判断 worktree 是否仍存在。
    if (!local || !sessionId || !projectService || !managedWorktreeService) return;
    let disposed = false;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const directories = await projectService.resolveSessionDirectories({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          taskId: sessionId,
        });
        if (disposed || current !== request) return;
        setState({
          key,
          placement: {
            cwd: directories.workspacePath,
            worktreeRoot: managedWorktreeRootFromPath(directories.workspacePath) ?? undefined,
            worktreeAvailable: true,
          },
        });
      } catch (error) {
        // 读取失败不能把普通任务判成 worktree 任务；保留 workspace 兜底 cwd。
        logger.warn("[worktree] 读取任务目录失败", { error });
        if (disposed || current !== request) return;
        setState({
          key,
          placement: { cwd: workspacePath, worktreeRoot: undefined, worktreeAvailable: true },
        });
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [key, local, managedWorktreeService, projectService, sessionId, workspacePath, workspaceIdentity]);

  const placement =
    state?.key === key
      ? state.placement
      : { cwd: workspacePath, worktreeRoot: undefined, worktreeAvailable: true };

  useEffect(() => {
    if (!local || !placement.worktreeRoot || !managedWorktreeService || !broadcastService) return;
    let disposed = false;
    // 每次检查递增序号，只有最新一次的结果能写入，避免较早的请求晚到后覆盖新结果。
    let latest = 0;
    const check = () => {
      const request = ++latest;
      void managedWorktreeService.isWorktreeAvailable({ worktreeRoot: placement.worktreeRoot! }).then(
        (available) => {
          if (!disposed && request === latest)
            setUnavailableRoot(available ? null : placement.worktreeRoot!);
        },
        // 查询失败不判定为只读：只读只由确定的"不存在"触发。
        (error: unknown) => logger.warn("[worktree] 读取 worktree 可用性失败", { error }),
      );
    };
    // 删除成功后 Host 发布项目变更，以它为唯一触发源重新查询，不轮询。
    const projects = broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") check();
    });
    check();
    return () => {
      disposed = true;
      projects.dispose();
    };
  }, [broadcastService, local, managedWorktreeService, placement.worktreeRoot]);

  return {
    cwd: placement.cwd,
    worktreeRoot: placement.worktreeRoot,
    worktreeAvailable: !placement.worktreeRoot || unavailableRoot !== placement.worktreeRoot,
  };
}
