import type { IPluginManagementService } from "@nibi/services";
import type { NibiPluginScope } from "@nibi/shared";
import { logger } from "@/logger.js";
import {
  buildWorkspaceKey,
  loadInto,
  notifyPluginManagementChange,
} from "@/store/pluginManagementStoreLoading.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 协议层把业务码放在 data.code；本地直调时也可能挂在 error.code。 */
function readErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const data =
    "data" in error && error.data && typeof error.data === "object"
      ? (error.data as { code?: unknown })
      : undefined;
  if (typeof data?.code === "string") return data.code;
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

let nextToggleRequestId = 0;
const requestsByStore = new WeakMap<() => PluginManagementState, Map<string, number>>();

function buildToggleRequestKey(input: {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: NibiPluginScope | null;
  pluginId: string;
}): string {
  const workspaceKey = buildWorkspaceKey(
    input.workspacePath,
    input.workspaceIdentity,
    input.authorityKey,
  );
  return `${workspaceKey}\u0000${input.configScope ?? "effective"}\u0000${input.pluginId}`;
}

export async function setPluginEnabledOptimistically(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginId: string,
  enabled: boolean,
  pluginService: IPluginManagementService,
  scope: NibiPluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  let activeToggleRequests = requestsByStore.get(get);
  if (!activeToggleRequests) {
    activeToggleRequests = new Map();
    requestsByStore.set(get, activeToggleRequests);
  }

  const requestKey = buildToggleRequestKey({
    workspacePath,
    workspaceIdentity,
    authorityKey,
    configScope,
    pluginId,
  });
  const requestId = ++nextToggleRequestId;
  activeToggleRequests.set(requestKey, requestId);
  const isCurrentRequest = (): boolean => {
    const current = get();
    return (
      activeToggleRequests.get(requestKey) === requestId &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope &&
      current.togglingPluginId === pluginId
    );
  };

  const previousPlugin = get().plugins.find((plugin) => plugin.id === pluginId);
  // 启停 RPC 和后续列表刷新存在可感知延迟。先投影最终状态，让开关立刻响应；失败时
  // 在 catch 中恢复快照，避免用户把正常的异步写入误判成“点了没反应”。
  set({
    togglingPluginId: pluginId,
    error: null,
    lastFailedPluginId: null,
    ...(previousPlugin
      ? {
          plugins: get().plugins.map((plugin) =>
            plugin.id === pluginId ? { ...plugin, enabled, enabledSource: scope } : plugin,
          ),
        }
      : {}),
  });

  try {
    const result = await pluginService.setPluginEnabled({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginId,
      enabled,
      scope,
    });
    if (!isCurrentRequest()) {
      notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    set({
      plugins: get().plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, ...result.plugin, enabled: result.enabled } : plugin,
      ),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentRequest();
  } catch (error) {
    // 启停失败时必须返回 false 并恢复 optimistic projection，避免
    // 调用方继续刷新其它能力，或让界面把失败的切换误报成成功。
    const consentRequired =
      enabled && readErrorCode(error) === "plugin_consent_required";
    if (consentRequired) {
      logger.info("[plugins] consent required before enabling", { pluginId });
    } else {
      logger.error("[plugins] setEnabled failed", { pluginId, enabled, error: toMessage(error) });
    }
    if (isCurrentRequest()) {
      set({
        ...(consentRequired
          ? {
              consentPrompt: {
                permissions: previousPlugin?.permissions?.required ?? [],
                pluginId,
              },
              error: null,
            }
          : { error: toMessage(error) }),
        lastFailedPluginId: pluginId,
        ...(previousPlugin
          ? {
              plugins: get().plugins.map((plugin) =>
                plugin.id === pluginId ? previousPlugin : plugin,
              ),
            }
          : {}),
      });
    }
    return false;
  } finally {
    if (isCurrentRequest()) {
      set({ togglingPluginId: null });
    }
    if (activeToggleRequests.get(requestKey) === requestId) {
      activeToggleRequests.delete(requestKey);
    }
  }
}
