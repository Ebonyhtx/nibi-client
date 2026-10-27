import type { IServiceAccessor } from "@nibi/services";
import type { ZCodeProvider } from "@nibi/shared";
import { logger } from "@/logger.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 插件变更后让**正在运行的会话**也跟上。
 *
 * ## 为什么需要它（真机复现过的 bug）
 *
 * 插件目录是 App（Session runtime）创建时解析并**冻结**的：`resolveStartupPlugins` 只在
 * 建 App 时跑一次。于是用户在插件商店里装了新插件、切回输入框敲 `/命令`，命令面板给出的是
 * 「没有匹配的 slash command」——新建会话也没有，重载渲染进程也没用，**只有整个应用重启**
 * 才看得到（实测：装在跑着的桌面版里，装完必须重启才出现 `/mathmodel`）。
 * 用户按"装插件 → 用命令"的自然顺序操作，会以为插件装坏了，而界面上没有任何提示。
 *
 * 这里用已有的能力把它补齐：重启该 workspace 的 agent 进程（下一次建 App 会重新解析插件），
 * 再走一次 workspace prepare 把新的 slash 命令发布进 store —— 也就是界面上的"重新加载会话"
 * 那套动作（`useWorkspaceSessionReload`），只是由插件变更来触发。
 *
 * ## 两条安全约定
 *
 * 1. **有任务在跑就不重启**：重启会打断当前回合。宁可延后生效（返回 `deferred-active-task`，
 *    由调用方提示"新会话/下次重启后生效"），也不能把用户正在跑的活掐掉。
 * 2. **任何失败都不向上抛**：插件已经装好了，收尾失败不该显示成"安装失败"。
 *    调用方按返回值决定提示哪种文案。
 */
export type PluginRuntimeReloadOutcome = "reloaded" | "deferred-active-task" | "failed";

export async function reloadWorkspaceRuntimeAfterPluginChange(params: {
  readonly services: Pick<IServiceAccessor, "zcodeTaskService" | "zcodeSessionService">;
  readonly workspacePath: string | null | undefined;
  readonly workspaceIdentity?: string | null;
}): Promise<PluginRuntimeReloadOutcome> {
  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) return "failed";
  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
  if (workspaceState.activeTaskId) {
    logger.info("[plugins] skip runtime reload: active task", {
      activeTaskId: workspaceState.activeTaskId,
      workspacePath,
    });
    return "deferred-active-task";
  }
  const provider = resolveWorkspaceModelConfigSyncScope(workspaceState).provider as ZCodeProvider;

  store.setWorkspaceInitState(workspacePath, "initializing", null, workspaceIdentity);
  try {
    await params.services.zcodeTaskService.restartWorkspaceProcess({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      provider,
    });
    const prepareResult = await prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider,
      zcodeSessionService: params.services.zcodeSessionService,
    });
    // provider 可能在 prepare 期间被用户改掉：只有仍是我们请求的那个才回写，避免覆盖新状态。
    const latest = useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity);
    if (latest.selectedProvider === provider) {
      useZCodeSessionStore
        .getState()
        .setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
      useZCodeSessionStore
        .getState()
        .setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
      useZCodeSessionStore
        .getState()
        .setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
    }
    useZCodeSessionStore.getState().setWorkspaceInitState(workspacePath, "ready", null, workspaceIdentity);
    logger.info("[plugins] workspace runtime reloaded after plugin change", { workspacePath });
    return "reloaded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[plugins] workspace runtime reload failed", { message, workspacePath });
    useZCodeSessionStore
      .getState()
      .setWorkspaceInitState(workspacePath, "failed", message, workspaceIdentity);
    return "failed";
  }
}
