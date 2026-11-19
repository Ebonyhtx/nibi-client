// worktree 入口（composer 复选框、"在新 worktree 中分叉"）的可见性与可用性。
// 可见：本地 Git 仓库且 Host 的 runtime/capabilities 声明 worktreeCwd；
// 能力未实现/为 false 时 visible=false，绝不显示假入口或假进度。
import { useEffect, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface WorktreeSupport {
  visible: boolean;
  available: boolean;
}

const HIDDEN: WorktreeSupport = { visible: false, available: false };

export function resolveWorktreeSupport(params: {
  enabled: boolean;
  hasService: boolean;
  isRepository: boolean;
  supportsWorktreeCwd: boolean;
}): WorktreeSupport {
  const visible =
    params.enabled && params.hasService && params.isRepository && params.supportsWorktreeCwd;
  return visible ? { visible: true, available: true } : HIDDEN;
}

export function useWorktreeSupport(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  enabled: boolean,
): WorktreeSupport {
  // 无 ServiceProvider（独立组件测试/旧宿主）时按不可见处理，不抛错。
  const services = useOptionalServices();
  const managedWorktreeService = services?.managedWorktreeService;
  const gitService = services?.gitService;
  const [state, setState] = useState<{ path: string; support: WorktreeSupport } | null>(null);
  // 远程 workspace 的 identity 只用于路由；受管 worktree 只在本机路径上创建。
  const active =
    enabled && Boolean(managedWorktreeService && gitService) && !workspaceIdentity?.trim();
  useEffect(() => {
    if (!active || !managedWorktreeService || !gitService) return;
    let disposed = false;
    void (async () => {
      // 先确认 Git 仓库再探测 runtime：非 Git 项目不应为一次能力查询启动 Agent。
      const info = await gitService.getWorkspaceRepositoryInfo({ workspacePath });
      const isRepository = info.kind !== "not-repository";
      const supported = isRepository
        ? await managedWorktreeService.supportsWorktreeCwd({ workspacePath })
        : false;
      return resolveWorktreeSupport({
        enabled: true,
        hasService: true,
        isRepository,
        supportsWorktreeCwd: supported,
      });
    })().then(
      (support) => {
        if (!disposed) setState({ path: workspacePath, support });
      },
      (error: unknown) => {
        // 查询失败按不可见处理：保留原有一键分叉，不阻断对话。
        logger.warn("[worktree] 读取 worktree 能力失败", { error });
        if (!disposed) setState({ path: workspacePath, support: HIDDEN });
      },
    );
    return () => {
      disposed = true;
    };
  }, [active, gitService, managedWorktreeService, workspacePath]);
  // 不返回上一次 workspace 的结论，避免切换项目后短暂显示旧入口。
  return active && state?.path === workspacePath ? state.support : HIDDEN;
}
