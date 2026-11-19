import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NibiPluginInfo } from "@nibi/shared";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  useOptionalBaseWorkspaceServices,
  useOptionalWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import { toast } from "@/components/ui/toast.js";

/** NIBI 官方 Design 内置插件（默认启用；用户或项目可以显式停用）。 */
export const DESIGN_PLUGIN_ID = "design@nibi-official";

export type DesignPluginGateStatus = "loading" | "enabled" | "disabled" | "error";

/** 纯函数：插件列表 / 加载错误 → 设计工具门禁状态。 */
export function resolveDesignPluginGateStatus({
  error,
  loading,
  plugins,
  rpcReady,
}: {
  error: string | null;
  loading: boolean;
  plugins: readonly Pick<NibiPluginInfo, "enabled" | "id">[];
  rpcReady: boolean;
}): DesignPluginGateStatus {
  if (!rpcReady || (loading && plugins.length === 0)) return "loading";
  if (error) return "error";
  return plugins.some((plugin) => plugin.id === DESIGN_PLUGIN_ID && plugin.enabled)
    ? "enabled"
    : "disabled";
}

/**
 * 设计工具的内置插件门禁。查询失败与插件缺失分开：前者提示读取失败，后者显示安装确认；
 * 确认只导航到插件详情页，不自动安装或启用。
 */
export function useBrowserDesignPluginGate({
  enabled,
  remoteSessionId,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  remoteSessionId?: string | null;
  workspaceIdentity?: string;
  workspacePath: string | undefined;
}) {
  const { intl } = useNibiIntl();
  const confirm = useConfirmDialog();
  const baseServices = useOptionalBaseWorkspaceServices();
  const { services, rpcReady: scopedRpcReady } = useOptionalWorkspaceServicesResolution(
    enabled ? (workspacePath ?? null) : null,
    remoteSessionId,
    workspaceIdentity,
  );
  const pluginManagementService =
    services.pluginManagementService ?? baseServices?.pluginManagementService;
  // side pane 在 provider 外时 scoped 解析不 ready；只要 Host 的 base 服务存在，插件门禁就能查。
  const rpcReady = scopedRpcReady || Boolean(baseServices?.pluginManagementService);
  const store = useScopedPluginManagementStore(pluginManagementService);
  const plugins = store((state) => state.plugins);
  const loading = store((state) => state.loading);
  const error = store((state) => state.error);
  const initializedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !workspacePath || !rpcReady) return;
    const key = `${workspacePath}\0${workspaceIdentity ?? ""}`;
    if (initializedKeyRef.current === key) return;
    initializedKeyRef.current = key;
    void store.getState().initialize({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginService: pluginManagementService,
    });
  }, [enabled, pluginManagementService, rpcReady, store, workspaceIdentity, workspacePath]);

  const status = useMemo(
    () => resolveDesignPluginGateStatus({ error, loading, plugins, rpcReady }),
    [error, loading, plugins, rpcReady],
  );

  const ensureEnabled = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    if (status === "enabled") return true;

    let current: DesignPluginGateStatus = status;
    if (current === "loading" && workspacePath && rpcReady) {
      // 首次点击可能早于插件列表返回：先等这一轮初始化，再用最新投影判断，不能把加载中当成缺失。
      await store.getState().initialize({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        pluginService: pluginManagementService,
      });
      const state = store.getState();
      current = resolveDesignPluginGateStatus({
        error: state.error,
        loading: state.loading,
        plugins: state.plugins,
        rpcReady,
      });
      if (current === "enabled") return true;
    }
    if (current === "loading") return false;
    if (current === "error") {
      toast(intl.formatMessage({ id: "browser.design.pluginCheckFailed" }), {
        variant: "warning",
        position: "bottom-center",
        dedupeKey: "browser-design-plugin-check-failed",
      });
      return false;
    }
    const confirmed = await confirm({
      title: intl.formatMessage({ id: "browser.design.pluginRequired.title" }),
      description: intl.formatMessage({ id: "browser.design.pluginRequired.description" }),
      confirmLabel: intl.formatMessage({ id: "browser.design.pluginRequired.action" }),
      testId: "browser-design-plugin-required",
      showKeyboardHints: false,
    });
    if (confirmed) requestPluginStoreOpen(DESIGN_PLUGIN_ID);
    return false;
  }, [
    confirm,
    enabled,
    intl,
    pluginManagementService,
    rpcReady,
    status,
    store,
    workspaceIdentity,
    workspacePath,
  ]);

  return {
    pluginEnabled: status === "enabled",
    status,
    ensureEnabled,
  };
}