import {
  collectTelemetryRendererContext,
  resolveWorkspaceTelemetryDetail,
  type RendererTelemetryEventPayload,
} from "@nibi/shared";
// 设置页插件管理薄服务实现——plugins/* 旧协议词的唯一 host 侧消费点。
// 插件安装/市场/启停的事实源在 nibi-cli 进程（读写 ~/.nibi 插件目录并热更新
// 运行态），host 无副本，故实现保持 agent 协议往返；收敛价值在 UI 层不再直触
// INibiAgentService，词表消费面从 UI 散点收拢到本文件一处。
import type { INibiAgentService } from "../nibi-agent/nibiAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";
import { Event as RpcEvent } from "@nibi/rpc";

export interface PluginManagementServiceDependencies {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  now?: () => number;
  /**
   * 安装/更新前的钩子：宿主拿它刷新 NIBI 会员凭证（刚在官网买完，不重启也能装收费件）。
   * 钩子失败不阻断安装——门禁仍会按现有凭证判，最多是提示没生效。
   */
  beforeInstall?: () => Promise<void> | void;
  nibiAgentService: Pick<
    INibiAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
    | "setPluginConsent"
  >;
}

export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.nibiAgentService;
  const now = dependencies.now ?? Date.now;
  const runBeforeInstall = async (): Promise<void> => {
    try {
      await dependencies.beforeInstall?.();
    } catch {
      // 会员刷新失败不阻断安装：agent 门禁会用缓存凭证继续判。
    }
  };
  type Params = import("../nibi-agent/nibiAgentPluginParams.js").NibiAgentPluginMutationTarget & {
    pluginId?: string;
    pluginName?: string;
    marketplace?: string;
    scope?: "user" | "workspace";
    dryRun?: boolean;
    removeCache?: boolean;
  };
  type Result = {
    diagnostics?: Array<{ severity?: string; code?: string }>;
    installedPlugins?: Array<{
      id: string;
      marketplace: string;
      version?: string;
      scope: string;
      listing?: { publisherType?: string };
    }>;
    removedPlugin?: { id: string; marketplace: string; version?: string };
    pluginId?: string;
    marketplaces?: unknown[];
    marketplace?: { id: string };
    plugin?: { id: string; marketplace: string; source: string; version?: string };
  };
  const report = (
    action: string,
    params: Params,
    startedAt: number,
    result?: Result,
    error?: unknown,
  ) => {
    if (params.dryRun || !dependencies.reportTelemetryEvent) return;
    const diagnostics = result?.diagnostics ?? [];
    const hasError = diagnostics.some((item) => item.severity === "error");
    // JSON-RPC 保留原始异常类型在 data.name；不能用取消请求的 ACK 或错误文案推断。
    const errorData =
      error instanceof Error && "data" in error && error.data && typeof error.data === "object"
        ? (error.data as { name?: unknown; code?: unknown })
        : undefined;
    const cancelled =
      errorData?.name === "AbortError" ||
      errorData?.code === "plugin_operation_cancelled" ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          ("code" in error && error.code === "plugin_operation_cancelled"))) ||
      diagnostics.some((item) => item.code === "plugin_operation_cancelled");
    const pluginId =
      params.pluginId ??
      (params.pluginName && params.marketplace
        ? `${params.pluginName}@${params.marketplace}`
        : result?.pluginId);
    const installed = result?.installedPlugins?.find((item) => item.id === pluginId);
    const status = cancelled
      ? "cancelled"
      : error
        ? "failure"
        : hasError
          ? action === "update" && !params.pluginId && result?.installedPlugins?.length
            ? "partial"
            : "failure"
          : action === "uninstall" && !result?.removedPlugin
            ? "noop"
            : action === "install" && !installed
              ? "failure"
              : action === "update" && !result?.installedPlugins?.length
                ? "noop"
                : "success";
    const detail: Record<string, string> = {
      schema_version: "1",
      action,
      result: status,
      duration_ms: String(Math.max(0, now() - startedAt)),
      entry: params.telemetry?.entry ?? "unknown",
      trigger: params.telemetry?.trigger ?? "user",
      client_kind: params.telemetry?.client_kind ?? "unknown",
      scope: params.scope ?? installed?.scope ?? "unknown",
      ...resolveWorkspaceTelemetryDetail(params),
      ...(pluginId || result?.removedPlugin
        ? { plugin_id: pluginId ?? result!.removedPlugin!.id }
        : {}),
      ...(params.marketplace || installed || result?.removedPlugin || result?.marketplace
        ? {
            marketplace:
              params.marketplace ??
              installed?.marketplace ??
              result?.removedPlugin?.marketplace ??
              result!.marketplace!.id,
          }
        : {}),
      ...(installed?.version ? { version_after: installed.version } : {}),
      ...(result?.removedPlugin?.version ? { version_before: result.removedPlugin.version } : {}),
      ...(installed?.listing?.publisherType
        ? { publisher_type: installed.listing.publisherType }
        : {}),
      ...(action === "uninstall" ? { remove_cache: String(params.removeCache ?? true) } : {}),
      ...(status === "failure" || status === "partial" || status === "cancelled"
        ? { error_category: cancelled ? "cancelled" : hasError ? "diagnostic" : "transport" }
        : {}),
    };
    // 上报只观察最终结果，不等待网络，失败不得改变原业务返回或触发业务重试。
    try {
      void Promise.resolve(
        dependencies.reportTelemetryEvent({
          elementName: "plugin_lifecycle",
          eventRegion: "app",
          eventType: "result",
          context: collectTelemetryRendererContext(),
          eventExtraDetail: detail,
        }),
      ).catch(() => {});
    } catch {
      /* 观测端故障与业务隔离。 */
    }
  };
  const observe = async <T extends Result>(
    action: string,
    params: Params,
    invoke: (clean: Params) => Promise<T>,
  ): Promise<T> => {
    const startedAt = now();
    const { telemetry: _telemetry, ...clean } = params;
    try {
      const result = await invoke(clean);
      report(action, params, startedAt, result);
      return result;
    } catch (error) {
      report(action, params, startedAt, undefined, error);
      throw error;
    }
  };
  return {
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    // agent 路由（NIBI_PLUGIN_ROUTING=agent）下没有单一的 bootstrap 协议词；
    // 组合两个既有调用保持返回值形状。Host-local 路由直接复用一次 discovery 的新实现。
    getPluginsBootstrap: async (params) => {
      // Host-local 路由下 agent 其实是本地插件 backend（createLocalPluginManagementBackend）；
      // 优先转发它的 bootstrap，保证 Host 只跑一次 discovery。真正的 agent 路由没有该词，
      // 退回两个既有调用，返回值形状不变。
      const localBootstrap = (agent as Partial<IPluginManagementService>).getPluginsBootstrap;
      if (typeof localBootstrap === "function") {
        return localBootstrap.call(agent, params);
      }
      const [list, overview] = await Promise.all([
        agent.listPlugins(params),
        agent.getPluginsOverview(params),
      ]);
      return { list, overview };
    },
    addPluginMarketplace: (params) =>
      observe("source_add", params, (clean) => agent.addPluginMarketplace(clean as typeof params)),
    removePluginMarketplace: (params) =>
      observe("source_remove", params, (clean) =>
        agent.removePluginMarketplace(clean as typeof params),
      ),
    updatePluginMarketplace: (params) =>
      observe("source_refresh", params, (clean) =>
        agent.updatePluginMarketplace(clean as typeof params),
      ),
    installPlugin: (params) =>
      observe("install", params, async (clean) => {
        // 钩子在计时内：用户看到的是"点击到装完"，会员刷新等待也是这段时间。
        await runBeforeInstall();
        return agent.installPlugin(clean as typeof params);
      }),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) =>
      observe("uninstall", params, (clean) => agent.uninstallPlugin(clean as typeof params)),
    updatePlugin: (params) =>
      observe("update", params, async (clean) => {
        await runBeforeInstall();
        return agent.updatePlugin(clean as typeof params);
      }),
    restoreBuiltinPlugin: (params) =>
      observe("restore", params, (clean) => agent.restoreBuiltinPlugin(clean as typeof params)),
    configurePlugin: (params) =>
      observe("configure", params, (clean) => agent.configurePlugin(clean as typeof params)),
    resetPluginConfig: (params) =>
      observe("reset_config", params, (clean) => agent.resetPluginConfig(clean as typeof params)),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: (params) =>
      observe(params.enabled ? "enable" : "disable", params, (clean) =>
        agent.setPluginEnabled(clean as typeof params),
      ),
    setPluginConsent: (params) =>
      observe(params.granted ? "consent_grant" : "consent_revoke", params, (clean) =>
        agent.setPluginConsent(clean as typeof params),
      ),
    // Host-local backend 提供扩展宿主事件；旧 agent 路由没有这两条事件源，返回 None。
    // 必须用 `onDynamic*` 命名：RPC proxy 只把它当作“返回 Event 的方法”来订阅。
    onDynamicPluginUiOpenView: () => {
      const impl = (agent as Partial<IPluginManagementService>).onDynamicPluginUiOpenView;
      return typeof impl === "function" ? impl.call(agent) : RpcEvent.None;
    },
    onDynamicPluginNotification: () => {
      const impl = (agent as Partial<IPluginManagementService>).onDynamicPluginNotification;
      return typeof impl === "function" ? impl.call(agent) : RpcEvent.None;
    },
  };
}
