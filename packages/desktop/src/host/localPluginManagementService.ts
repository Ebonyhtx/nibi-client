// Host 进程内的插件管理 backend。
//
// 复用 `@nibi/bootstrap/plugin-management` 的同一份实现（不是重写）：17 条工作区级
// 安装/市场/启停/配置/校验方法由 Host 直答，不再经过 agent 协议往返；因此 Rust 内核
// 不再需要实现这些方法。
//
// 仍留给内核/agent 的三条：
// - `getPluginReferenceCatalog`（含 category 变体）：带 sessionId 时读会话创建时冻结的
//   身份投影，Host 不能读磁盘新配置代替，否则会把“会话权威”静默降级成“工作区权威”；
// - `resolveSuggestedPluginReference`：安装前可信解析依赖 agent 的 operation 进度通知，
//   先保持原链路；
// - `onDynamicPluginOperationProgress`：同上，继续订阅 agent 事件。
//
// 插件的运行时（MCP/hooks/skills/commands/UI）仍在会话内核里，不因管理面下沉而改变。
import { resolveWorkspaceKey, type ZCodeWorkspaceRef } from "@nibi/shared";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPluginUiSurfaces,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
  type PluginManagementContext,
} from "@nibi/bootstrap/plugin-management";
import type { IPluginManagementService, IZCodeAgentService } from "@nibi/services";
import { createServiceLogger } from "@nibi/services/node";

type PluginLogger = NonNullable<PluginManagementContext["logger"]>;

type PluginFallback = Pick<
  IZCodeAgentService,
  | "getPluginReferenceCatalog"
  | "resolveSuggestedPluginReference"
  | "onDynamicPluginOperationProgress"
>;

export interface LocalPluginManagementServiceOptions {
  /** 会话权威查询与进度事件的转发目标（当前内核的 agent 连接）。 */
  fallback: PluginFallback;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
}

/** 与 agent service 的 `buildWorkspaceRef` 保持同形；workspaceKey 只用于路由/隔离。 */
function toWorkspaceRef(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): ZCodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceKey: resolveWorkspaceKey(params),
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
  };
}

function hostLogger(): PluginLogger {
  const serviceLogger = createServiceLogger("plugin-management");
  const logger: PluginLogger = {
    debug: (message, context) => serviceLogger.debug(undefined, message, context),
    info: (message, context) => serviceLogger.info(undefined, message, context),
    warn: (message, context) => serviceLogger.warn(undefined, message, context),
    error: (message, error, context) =>
      serviceLogger.error(undefined, message, error ?? undefined, context),
    child: () => logger,
  };
  return logger;
}

export function createLocalPluginManagementService(
  options: LocalPluginManagementServiceOptions,
): IPluginManagementService {
  const context: PluginManagementContext = {
    deps: { env: options.env ?? process.env },
    logger: options.logger ?? hostLogger(),
  };
  const fallback = options.fallback;
  const operations = new Map<string, AbortController>();

  const withOperation = async <T>(
    operationId: string | undefined,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!operationId) return await run();
    const controller = new AbortController();
    operations.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (operations.get(operationId) === controller) operations.delete(operationId);
    }
  };

  return {
    listPlugins: (params) =>
      listPlugins(context, {
        workspace: toWorkspaceRef(params),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    getPluginsOverview: (params) =>
      getPluginsOverview(context, {
        workspace: toWorkspaceRef(params),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    addPluginMarketplace: (params) =>
      withOperation(params.operationId, (signal) =>
        addPluginMarketplace(
          context,
          {
            workspace: toWorkspaceRef(params),
            source: params.source,
            ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun }),
            ...(params.operationId ? { operationId: params.operationId } : {}),
          },
          signal,
        ),
      ),
    removePluginMarketplace: (params) =>
      removePluginMarketplace(context, {
        workspace: toWorkspaceRef(params),
        marketplace: params.marketplace,
      }),
    updatePluginMarketplace: (params) =>
      withOperation(params.operationId, (signal) =>
        updatePluginMarketplace(
          context,
          {
            workspace: toWorkspaceRef(params),
            ...(params.marketplace ? { marketplace: params.marketplace } : {}),
            ...(params.operationId ? { operationId: params.operationId } : {}),
          },
          signal,
        ),
      ),
    installPlugin: (params) =>
      withOperation(params.operationId, (signal) =>
        installPlugin(
          context,
          {
            workspace: toWorkspaceRef(params),
            marketplace: params.marketplace,
            pluginName: params.pluginName,
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun }),
            ...(params.operationId ? { operationId: params.operationId } : {}),
          },
          signal,
        ),
      ),
    uninstallPlugin: (params) =>
      uninstallPlugin(context, {
        workspace: toWorkspaceRef(params),
        ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
        ...(params.pluginName ? { pluginName: params.pluginName } : {}),
        ...(params.removeCache === undefined ? {} : { removeCache: params.removeCache }),
      }),
    updatePlugin: (params) =>
      updatePlugin(context, {
        workspace: toWorkspaceRef(params),
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
        ...(params.marketplace ? { marketplace: params.marketplace } : {}),
      }),
    restoreBuiltinPlugin: (params) =>
      restoreBuiltinPlugin(context, {
        workspace: toWorkspaceRef(params),
        pluginId: params.pluginId,
      }),
    configurePlugin: (params) =>
      configurePlugin(context, {
        workspace: toWorkspaceRef(params),
        pluginId: params.pluginId,
        options: params.options,
        ...(params.clearOptionKeys ? { clearOptionKeys: params.clearOptionKeys } : {}),
        ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun }),
        ...(params.scope ? { scope: params.scope } : {}),
      }),
    resetPluginConfig: (params) =>
      resetPluginConfig(context, {
        workspace: toWorkspaceRef(params),
        pluginId: params.pluginId,
        ...(params.scope ? { scope: params.scope } : {}),
      }),
    validatePlugin: (params) =>
      validatePlugin(context, {
        workspace: toWorkspaceRef(params),
        ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        ...(params.pluginName ? { pluginName: params.pluginName } : {}),
        ...(params.source ? { source: params.source } : {}),
      }),
    describePlugin: (params) =>
      describePlugin(context, {
        workspace: toWorkspaceRef(params),
        marketplace: params.marketplace,
        pluginName: params.pluginName,
      }),
    setPluginEnabled: (params) =>
      withOperation(params.operationId, (signal) =>
        setPluginEnabled(
          context,
          {
            workspace: toWorkspaceRef(params),
            pluginId: params.pluginId,
            enabled: params.enabled,
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.operationId ? { operationId: params.operationId } : {}),
          },
          signal,
        ),
      ),
    cancelPluginOperation: (params) => {
      const controller = operations.get(params.operationId);
      if (!controller) return Promise.resolve({ operationId: params.operationId, cancelled: false });
      controller.abort(new DOMException("Plugin operation cancelled", "AbortError"));
      operations.delete(params.operationId);
      return Promise.resolve({ operationId: params.operationId, cancelled: true });
    },
    // 会话权威：必须由持有 session 的内核回答。
    getPluginReferenceCatalog: (params) => fallback.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) =>
      fallback.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      fallback.onDynamicPluginOperationProgress(operationId),
  };
}

/**
 * Host 装配用的完整本地插件面：`service` 接原来的 `IPluginManagementService` 注册点，
 * `listPluginUiSurfaces` 接插件 UI 桥——两者都是工作区级、不依赖会话身份。
 */
export function createLocalPluginManagementBackend(options: LocalPluginManagementServiceOptions): {
  service: IPluginManagementService;
  listPluginUiSurfaces: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }) => ReturnType<typeof listPluginUiSurfaces>;
} {
  const context: PluginManagementContext = {
    deps: { env: options.env ?? process.env },
    logger: options.logger ?? hostLogger(),
  };
  return {
    listPluginUiSurfaces: (params) =>
      listPluginUiSurfaces(context, { workspace: toWorkspaceRef(params) }),
    service: createLocalPluginManagementService(options),
  };
}
