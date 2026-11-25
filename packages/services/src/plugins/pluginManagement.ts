// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 INibiAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 nibi-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@nibi/rpc";
import type {
  NibiPluginOperationProgressNotification,
  NibiPluginsBootstrapResult,
  NibiPluginsConfigureResult,
  NibiPluginsConsentResult,
  NibiPluginsCancelOperationResult,
  NibiPluginsDescribeResult,
  NibiPluginsInstallResult,
  NibiPluginsListResult,
  NibiPluginsMarketplaceMutationResult,
  NibiPluginsOverviewResult,
  NibiPluginsReferenceCatalogResult,
  NibiPluginsRestoreBuiltinResult,
  NibiPluginsSetEnabledResult,
  NibiPluginsUninstallResult,
  NibiPluginsValidateResult,
  NibiWorkspaceRef,
} from "@nibi/shared";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  NibiAgentAddPluginMarketplaceParams,
  NibiAgentConfigurePluginParams,
  NibiAgentCancelPluginOperationParams,
  NibiAgentDescribePluginParams,
  NibiAgentInstallPluginParams,
  NibiAgentPluginReferenceCatalogParams,
  NibiAgentResolveSuggestedPluginReferenceParams,
  NibiAgentResetPluginConfigParams,
  NibiAgentPluginViewParams,
  NibiAgentPluginsAuditParams,
  NibiAgentPluginConsentParams,
  NibiAgentRemovePluginMarketplaceParams,
  NibiAgentRestoreBuiltinPluginParams,
  NibiAgentSetPluginEnabledParams,
  NibiAgentUninstallPluginParams,
  NibiAgentUpdatePluginMarketplaceParams,
  NibiAgentUpdatePluginParams,
  NibiAgentValidatePluginParams,
} from "../nibi-agent/nibiAgentPluginParams.js";

/** 扩展代码 `nibi.ui.openView` 的宿主侧事件；Host 打开面板，renderer 只消费。 */
export interface NibiPluginUiOpenViewEvent extends NibiWorkspaceRef {
  pluginId: string;
  surfaceId: string;
}

/** 扩展代码 `nibi.notifications.show` 的宿主侧事件；title 已由扩展宿主校验非空。 */
export interface NibiPluginNotificationEvent extends NibiWorkspaceRef {
  body?: string;
  pluginId: string;
  title: string;
}

export interface IPluginManagementService {
  listPlugins(params: NibiAgentPluginViewParams): Promise<NibiPluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: NibiAgentPluginReferenceCatalogParams,
  ): Promise<NibiPluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: NibiAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@nibi/shared").NibiPluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<NibiPluginOperationProgressNotification>;
  getPluginsOverview(params: NibiAgentPluginViewParams): Promise<NibiPluginsOverviewResult>;
  /** 插件审计「最近 N 条」（设置页详情用）：只读，按 pluginId 过滤。 */
  getPluginsAudit(
    params: NibiAgentPluginsAuditParams,
  ): Promise<import("@nibi/shared").NibiPluginsAuditResult>;
  /**
   * Additive：一次返回 list + overview。Host 侧只跑一次插件 discovery；
   * 旧 Host 没有该方法，调用方按 method-not-found 回退到两个旧 RPC。
   */
  getPluginsBootstrap(params: NibiAgentPluginViewParams): Promise<NibiPluginsBootstrapResult>;
  addPluginMarketplace(
    params: NibiAgentAddPluginMarketplaceParams,
  ): Promise<NibiPluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: NibiAgentRemovePluginMarketplaceParams,
  ): Promise<NibiPluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: NibiAgentUpdatePluginMarketplaceParams,
  ): Promise<NibiPluginsMarketplaceMutationResult>;
  installPlugin(params: NibiAgentInstallPluginParams): Promise<NibiPluginsInstallResult>;
  cancelPluginOperation(
    params: NibiAgentCancelPluginOperationParams,
  ): Promise<NibiPluginsCancelOperationResult>;
  uninstallPlugin(params: NibiAgentUninstallPluginParams): Promise<NibiPluginsUninstallResult>;
  updatePlugin(params: NibiAgentUpdatePluginParams): Promise<NibiPluginsInstallResult>;
  restoreBuiltinPlugin(
    params: NibiAgentRestoreBuiltinPluginParams,
  ): Promise<NibiPluginsRestoreBuiltinResult>;
  configurePlugin(params: NibiAgentConfigurePluginParams): Promise<NibiPluginsConfigureResult>;
  resetPluginConfig(params: NibiAgentResetPluginConfigParams): Promise<NibiPluginsConfigureResult>;
  validatePlugin(params: NibiAgentValidatePluginParams): Promise<NibiPluginsValidateResult>;
  describePlugin(params: NibiAgentDescribePluginParams): Promise<NibiPluginsDescribeResult>;
  setPluginEnabled(params: NibiAgentSetPluginEnabledParams): Promise<NibiPluginsSetEnabledResult>;
  setPluginConsent(params: NibiAgentPluginConsentParams): Promise<NibiPluginsConsentResult>;
  /**
   * 扩展代码请求打开自己的面板。Host-local backend 提供；旧 backend / 远端 agent 缺席，
   * renderer 按“没有事件”处理，不把缺席当成已支持。
   * 名字必须是 `onDynamic*`：RPC proxy 只有这条约定会把“返回 Event 的方法”变成订阅，
   * 其它 onXxx 名称会被当成事件属性并把返回值序列化成非函数。
   */
  onDynamicPluginUiOpenView?(): Event<NibiPluginUiOpenViewEvent>;
  /** 扩展代码发通知。缺席原因与命名约束同 `onDynamicPluginUiOpenView`。 */
  onDynamicPluginNotification?(): Event<NibiPluginNotificationEvent>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);

/** 入口只附加观测上下文；RPC 方法由 Proxy 动态提供，不能通过对象展开复制。 */
export function withPluginTelemetry(
  service: IPluginManagementService,
  telemetry: NonNullable<NibiAgentInstallPluginParams["telemetry"]>,
): IPluginManagementService {
  const mutations = new Set<PropertyKey>([
    "addPluginMarketplace",
    "removePluginMarketplace",
    "updatePluginMarketplace",
    "installPlugin",
    "uninstallPlugin",
    "updatePlugin",
    "restoreBuiltinPlugin",
    "configurePlugin",
    "resetPluginConfig",
    "setPluginEnabled",
  ]);
  return new Proxy(service, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (!mutations.has(property)) return method.bind(target);
      return (params: NibiAgentInstallPluginParams) =>
        method.call(target, { ...params, telemetry });
    },
  });
}
