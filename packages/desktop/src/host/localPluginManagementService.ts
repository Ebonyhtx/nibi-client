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
// 扩展代码宿主是例外：它必须跟 Host 同进程族，才能在桌面（Rust 内核）真正运行；
// T1/T2/T3 的子进程隔离仍由 bootstrap 的 activatePluginExtensions 负责。
import { resolveWorkspaceKey, type NibiWorkspaceRef } from "@nibi/shared";
import { Emitter, Event as RpcEvent, type Event } from "@nibi/rpc";
import {
  activatePluginExtensions,
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsBootstrap,
  getPluginsOverview,
  installPlugin,
  listPluginUiSurfaces,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  resolveNibiPlugins,
  resolvePluginStorageRoot,
  restoreBuiltinPlugin,
  seedOfficialPlugins,
  setPluginConsent,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
  type PluginExtensionHost,
  type PluginManagementContext,
} from "@nibi/bootstrap/plugin-management";
import type {
  IPluginManagementService,
  INibiAgentService,
  NibiPluginNotificationEvent,
  NibiPluginUiOpenViewEvent,
} from "@nibi/services";
import { createServiceLogger } from "@nibi/services/node";

type PluginLogger = NonNullable<PluginManagementContext["logger"]>;

type PluginFallback = Pick<
  INibiAgentService,
  | "getPluginReferenceCatalog"
  | "resolveSuggestedPluginReference"
  | "onDynamicPluginOperationProgress"
> & {
  /** 会话读取能力依赖内核的 session 列表；旧调用方缺席时只关闭 sessions.read。 */
  listSessions?: INibiAgentService["listSessions"];
};

export interface LocalPluginManagementServiceOptions {
  /** 会话权威查询与进度事件的转发目标（当前内核的 agent 连接）。 */
  fallback: PluginFallback;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  /** 扩展代码宿主；由 backend 统一创建与释放，service 只负责在读取面触发激活。 */
  extensions?: Pick<
    PluginExtensionRuntime,
    "ensure" | "onNotification" | "onUiOpenView"
  >;
}

/** 与 agent service 的 `buildWorkspaceRef` 保持同形；workspaceKey 只用于路由/隔离。 */
function toWorkspaceRef(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): NibiWorkspaceRef {
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

let officialPluginSeedAttempted = false;

interface PluginExtensionRuntime {
  dispose(): Promise<void>;
  /** 第一次读取某工作区的插件面时激活；装/启/停/更新仍按既有规则重启后生效。 */
  ensure(workspace: NibiWorkspaceRef): void;
  onNotification: Event<NibiPluginNotificationEvent>;
  onUiOpenView: Event<NibiPluginUiOpenViewEvent>;
}

function createPluginExtensionRuntime(options: {
  env: NodeJS.ProcessEnv;
  fallback: PluginFallback;
  logger: PluginLogger;
}): PluginExtensionRuntime {
  const notificationEmitter = new Emitter<NibiPluginNotificationEvent>();
  const uiOpenViewEmitter = new Emitter<NibiPluginUiOpenViewEvent>();
  const hosts = new Map<string, Promise<PluginExtensionHost | undefined>>();

  return {
    ensure(workspace) {
      // 远端 workspace 的插件运行时在远端；Host 不能读取本机同名路径冒充远端插件。
      if (workspace.remoteSessionId || hosts.has(workspace.workspaceKey)) return;
      const listSessions = options.fallback.listSessions;
      const activation = (async () => {
        const plugins = resolveNibiPlugins({
          env: options.env,
          logger: options.logger,
          workingDirectory: workspace.workspacePath,
        }).plugins;
        return await activatePluginExtensions({
          logger: options.logger,
          plugins,
          storageRoot: resolvePluginStorageRoot(workspace.workspacePath, options.env),
          workspacePath: workspace.workspacePath,
          handlers: {
            ...(listSessions
              ? {
                  readSessions: async (input: { limit?: number }) => {
                    const sessions = await listSessions.call(options.fallback, {
                      workspacePath: workspace.workspacePath,
                      ...(workspace.workspaceIdentity
                        ? { workspaceIdentity: workspace.workspaceIdentity }
                        : {}),
                      ...(workspace.remoteSessionId
                        ? { remoteSessionId: workspace.remoteSessionId }
                        : {}),
                      ...(input.limit === undefined ? {} : { limit: input.limit }),
                    });
                    // 只暴露协议已承诺的元数据；提示词、文件路径与游标都不下发。
                    return sessions.map((session) => ({
                      id: session.sessionId,
                      parentId: session.parentSessionId ?? null,
                      title: session.title,
                      createdAt: session.createdAt,
                      updatedAt: session.updatedAt,
                    }));
                  },
                }
              : {}),
            showNotification: (input) => {
              notificationEmitter.fire({ ...workspace, ...input });
            },
            openView: (input) => {
              uiOpenViewEmitter.fire({ ...workspace, ...input });
            },
          },
        });
      })().catch((error) => {
        options.logger.warn("[plugins] extension host activation failed", {
          error: error instanceof Error ? error.message : String(error),
          workspacePath: workspace.workspacePath,
        });
        return undefined;
      });
      hosts.set(workspace.workspaceKey, activation);
    },
    onNotification: notificationEmitter.event,
    onUiOpenView: uiOpenViewEmitter.event,
    async dispose() {
      const pending = [...hosts.values()];
      hosts.clear();
      for (const activation of pending) {
        const host = await activation;
        await host?.dispose();
      }
      notificationEmitter.dispose();
      uiOpenViewEmitter.dispose();
    },
  };
}

export function createLocalPluginManagementService(
  options: LocalPluginManagementServiceOptions,
): IPluginManagementService {
  // Rust 内核启动不会经过 Node bootstrap 的 seed；Host 自己就是插件管理面，必须在
  // 第一次创建 backend 时补一次。只有 main 注入随包资源目录（桌面运行态）时才执行，
  // 单测/CLI 上下文没有这两个 env，不会写真实用户目录。
  if (!officialPluginSeedAttempted && process.env.NIBI_BUNDLED_AGENT_RESOURCE_DIR?.trim()) {
    officialPluginSeedAttempted = true;
    const logger = options.logger ?? hostLogger();
    try {
      seedOfficialPlugins({ env: options.env ?? process.env, logger });
    } catch (error) {
      logger.warn("Official plugin seed failed during Host startup", { error });
    }
  }
  const context: PluginManagementContext = {
    deps: { env: options.env ?? process.env },
    logger: options.logger ?? hostLogger(),
  };
  const fallback = options.fallback;
  const operations = new Map<string, AbortController>();
  const extensions = options.extensions;
  const activateExtensions = (workspace: NibiWorkspaceRef): NibiWorkspaceRef => {
    extensions?.ensure(workspace);
    return workspace;
  };

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
        workspace: activateExtensions(toWorkspaceRef(params)),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    getPluginsOverview: (params) =>
      getPluginsOverview(context, {
        workspace: activateExtensions(toWorkspaceRef(params)),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    // 一次请求完成 list + overview，且 Host 只解析一次 discovery；旧的两个方法
    // 保持原样，供旧 renderer 和其他调用方继续使用。
    getPluginsBootstrap: (params) =>
      getPluginsBootstrap(context, {
        workspace: activateExtensions(toWorkspaceRef(params)),
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
    setPluginConsent: (params) =>
      setPluginConsent(context, {
        workspace: toWorkspaceRef(params),
        pluginId: params.pluginId,
        granted: params.granted,
      }),
    cancelPluginOperation: (params) => {
      const controller = operations.get(params.operationId);
      if (!controller)
        return Promise.resolve({ operationId: params.operationId, cancelled: false });
      controller.abort(new DOMException("Plugin operation cancelled", "AbortError"));
      operations.delete(params.operationId);
      return Promise.resolve({ operationId: params.operationId, cancelled: true });
    },
    // 会话权威：必须由持有 session 的内核回答。
    getPluginReferenceCatalog: (params) => fallback.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => fallback.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      fallback.onDynamicPluginOperationProgress(operationId),
    onDynamicPluginUiOpenView: () => extensions?.onUiOpenView ?? RpcEvent.None,
    onDynamicPluginNotification: () => extensions?.onNotification ?? RpcEvent.None,
  };
}

/**
 * Host 装配用的完整本地插件面：`service` 接原来的 `IPluginManagementService` 注册点，
 * `listPluginUiSurfaces` 接插件 UI 桥——两者都是工作区级、不依赖会话身份。
 */
export function createLocalPluginManagementBackend(options: LocalPluginManagementServiceOptions): {
  dispose: () => Promise<void>;
  service: IPluginManagementService;
  listPluginUiSurfaces: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }) => ReturnType<typeof listPluginUiSurfaces>;
} {
  const env = options.env ?? process.env;
  const context: PluginManagementContext = {
    deps: { env },
    logger: options.logger ?? hostLogger(),
  };
  const extensions = createPluginExtensionRuntime({
    env,
    fallback: options.fallback,
    logger: context.logger ?? hostLogger(),
  });
  return {
    dispose: () => extensions.dispose(),
    listPluginUiSurfaces: (params) => {
      const workspace = toWorkspaceRef(params);
      extensions.ensure(workspace);
      return listPluginUiSurfaces(context, { workspace });
    },
    service: createLocalPluginManagementService({ ...options, extensions }),
  };
}
