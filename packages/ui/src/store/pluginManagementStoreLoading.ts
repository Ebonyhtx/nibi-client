import type { IPluginManagementService } from "@nibi/services";
import {
  remoteHostIdFromWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type NibiPluginScope,
} from "@nibi/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildWorkspaceKey(
  workspacePath: string,
  workspaceIdentity: string | null,
  authorityKey: string | null,
): string {
  return `${authorityKey?.trim() || "workspace"}\0${workspaceIdentity?.trim() || workspacePath}`;
}

// 只共享同服务、同身份、同配置投影的在途查询；每个视图仍独立写回和保存错误态。
const loadsByService = new WeakMap<
  IPluginManagementService,
  Map<string, { task: Promise<Partial<PluginManagementState>>; revision: number }>
>();
export interface PluginManagementChange {
  owner?: () => PluginManagementState;
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  scope: NibiPluginScope;
}
const changeListeners = new Set<(change: PluginManagementChange) => void | Promise<void>>();
let revision = 0;
export const getPluginManagementRevision = () => revision;
export function subscribePluginManagementChanges(
  listener: (change: PluginManagementChange) => void | Promise<void>,
) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
export function notifyPluginManagementChange(change: PluginManagementChange): void {
  // revision 同时是模块级快照缓存的失效版本：变更前写入的快照之后只用作首屏旧数据，
  // 读取方会先渲染它再后台刷新，不会把它当成最新结果跳过查询。
  revision += 1;
  // 派生视图不能拖住已成功的写入；发布失效信号后，后台查询各自收口。
  for (const listener of changeListeners) {
    void Promise.resolve()
      .then(() => listener(change))
      .catch((error: unknown) => {
        logger.warn("[plugins] background projection refresh failed", {
          message: toMessage(error),
        });
      });
  }
}
export function isPluginManagementChangeRelevant(
  state: Pick<
    PluginManagementState,
    "workspacePath" | "workspaceIdentity" | "authorityKey" | "configScope"
  >,
  change: PluginManagementChange,
): boolean {
  if (!state.workspacePath) return false;
  if (change.scope === "workspace") {
    return (
      state.configScope !== "user" &&
      buildWorkspaceKey(state.workspacePath, state.workspaceIdentity, state.authorityKey) ===
        buildWorkspaceKey(change.workspacePath, change.workspaceIdentity, change.authorityKey)
    );
  }
  const hostKey = (target: { workspaceIdentity: string | null; authorityKey: string | null }) => {
    const identity = target.workspaceIdentity ?? "";
    const sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    // Source 用户设置没有项目 identity，但和该 Source 下项目共享用户配置。
    return (
      target.authorityKey ??
      (sourceServerId
        ? `source-settings:${sourceServerId}`
        : (remoteHostIdFromWorkspaceIdentity(identity) ?? "local"))
    );
  };
  return hostKey(state) === hostKey(change);
}

// 跨 mount 的目录快照：插件市场页每次打开都会重新挂载并新建 scoped store，
// 没有这层缓存时首屏必须等 list + overview 两个 RPC，管理视图还会再建一份 store。
// 快照按 service + workspaceKey（authority/identity 已包含） + configScope 隔离，
// 不同 workspace、不同远端 Source、User/Workspace 配置视图都不会互相复用。
export const PLUGIN_MANAGEMENT_SNAPSHOT_TTL_MS = 60_000;
const MAX_PLUGIN_MANAGEMENT_SNAPSHOTS_PER_SERVICE = 24;

export interface PluginManagementSnapshotContext {
  workspacePath: string;
  workspaceIdentity?: string | null;
  authorityKey?: string | null;
  configScope?: NibiPluginScope | null;
}

export type PluginManagementSnapshotData = Pick<
  PluginManagementState,
  | "plugins"
  | "marketplaces"
  | "marketplaceAvailabilityKnown"
  | "availablePlugins"
  | "installedPlugins"
  | "restorableBuiltins"
  | "diagnostics"
>;

interface StoredPluginManagementSnapshot {
  data: PluginManagementSnapshotData;
  loadedAt: number;
  /** 写入结果所基于的变更版本；落后于全局 revision 时只能当旧数据。 */
  revision: number;
}

let snapshotsByService = new WeakMap<
  IPluginManagementService,
  Map<string, StoredPluginManagementSnapshot>
>();

function buildSnapshotKey(context: PluginManagementSnapshotContext): string {
  return `${buildWorkspaceKey(
    context.workspacePath,
    context.workspaceIdentity ?? null,
    context.authorityKey ?? null,
  )}\0${context.configScope ?? "effective"}`;
}

export function readPluginManagementSnapshot(
  pluginService: IPluginManagementService,
  context: PluginManagementSnapshotContext,
): { data: PluginManagementSnapshotData; fresh: boolean } | undefined {
  const stored = snapshotsByService.get(pluginService)?.get(buildSnapshotKey(context));
  if (!stored) return undefined;
  return {
    data: stored.data,
    // TTL 内且没有新变更才跳过网络；否则仍先返回旧数据，由调用方后台刷新。
    fresh:
      Date.now() - stored.loadedAt < PLUGIN_MANAGEMENT_SNAPSHOT_TTL_MS &&
      stored.revision === revision,
  };
}

function writePluginManagementSnapshot(
  pluginService: IPluginManagementService,
  context: PluginManagementSnapshotContext,
  data: PluginManagementSnapshotData,
  loadedRevision: number,
): void {
  let snapshots = snapshotsByService.get(pluginService);
  if (!snapshots) {
    snapshots = new Map();
    snapshotsByService.set(pluginService, snapshots);
  }
  const key = buildSnapshotKey(context);
  // 重新插入以刷新 LRU 顺序；条目数按 service 有界，避免长期运行累积历史 workspace。
  snapshots.delete(key);
  snapshots.set(key, { data, loadedAt: Date.now(), revision: loadedRevision });
  while (snapshots.size > MAX_PLUGIN_MANAGEMENT_SNAPSHOTS_PER_SERVICE) {
    const oldestKey = snapshots.keys().next().value;
    if (oldestKey === undefined) break;
    snapshots.delete(oldestKey);
  }
}

function toPluginManagementSnapshot(
  result: Partial<PluginManagementState>,
): PluginManagementSnapshotData | undefined {
  // overview 失败后的 list fallback 会产生“来源状态未知”的空市场投影，不能落成快照，
  // 否则下一次 mount 会先把“所有市场都不存在”渲染出来。
  if (result.marketplaceAvailabilityKnown !== true) return undefined;
  const {
    plugins,
    marketplaces,
    availablePlugins,
    installedPlugins,
    restorableBuiltins,
    diagnostics,
  } = result;
  if (
    !plugins ||
    !marketplaces ||
    !availablePlugins ||
    !installedPlugins ||
    !restorableBuiltins ||
    !diagnostics
  ) {
    return undefined;
  }
  return {
    plugins,
    marketplaces,
    marketplaceAvailabilityKnown: true,
    availablePlugins,
    installedPlugins,
    restorableBuiltins,
    diagnostics,
  };
}

export function resetPluginManagementSnapshotsForTests(): void {
  snapshotsByService = new WeakMap();
}

// 单个 operationId 会被后一次安装覆盖；每次调用持有独立条目，完成时只移除自己。
// 通过条目身份清理，同名并发操作以及切换配置层后的新操作都不会被误清除。
export function beginPluginOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  id: string,
): () => void {
  const entry = { id };
  set({
    activeOperations: [...get().activeOperations, entry],
    operationVersion: get().operationVersion + 1,
    error: null,
    errorCode: null,
    lastFailedPluginId: null,
  });
  return () => {
    set({ activeOperations: get().activeOperations.filter((operation) => operation !== entry) });
  };
}

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
  scope: NibiPluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  const finish = beginPluginOperation(set, get, operationId);
  const operationVersion = get().operationVersion;
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationVersion === operationVersion;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // 并发刷新不能把已成功落盘的安装报告成失败；结果只受当前目标上下文约束。
    if (!isCurrentContext()) {
      await notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    await notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentContext();
  } catch (error) {
    // marketplace add/update 等通用操作失败：无插件目标，归属清空。
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // 旧操作不能覆盖同一配置层中新操作的错误态；只有最近发起的操作才回写。
    if (ownsVisibleOperation()) {
      set({
        error: toMessage(error),
        errorCode:
          typeof (error as { diagnosticCode?: unknown }).diagnosticCode === "string"
            ? (error as { diagnosticCode: string }).diagnosticCode
            : null,
        lastFailedPluginId: null,
      });
    }
    return false;
  } finally {
    finish();
  }
}

interface PluginLoadParams {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: NibiPluginScope | null;
  pluginService: IPluginManagementService;
  fresh?: boolean;
  background?: boolean;
}
export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: PluginLoadParams,
): Promise<void> {
  let inFlightLoads = loadsByService.get(params.pluginService);
  if (!inFlightLoads) {
    inFlightLoads = new Map();
    loadsByService.set(params.pluginService, inFlightLoads);
  }
  const workspaceKey = buildWorkspaceKey(
    params.workspacePath,
    params.workspaceIdentity,
    params.authorityKey,
  );
  const loadKey = `${workspaceKey}\0${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  // 变更前启动的查询不能充当变更后的刷新；同一轮通知的新查询仍可共用。
  if (existing && (params.fresh || (params.background && existing.revision < revision))) {
    await existing.task;
    return loadInto(set, get, { ...params, fresh: false });
  }
  const request = existing ?? { task: runLoadInto({ ...params, workspaceKey }), revision };
  inFlightLoads.set(loadKey, request);
  try {
    const result = await request.task;
    // 变更通知之后才完成的旧查询不能覆盖更新的快照；等下一次刷新（或下一次 mount 的
    // 后台刷新）用新 revision 重新落盘。
    if (request.revision >= revision) {
      const snapshot = toPluginManagementSnapshot(result);
      if (snapshot) {
        writePluginManagementSnapshot(params.pluginService, params, snapshot, request.revision);
      }
    }
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.authorityKey !== params.authorityKey ||
      current.configScope !== params.configScope
    )
      return;
    // 其它视图的成功操作只刷新数据，不能抹掉本视图尚未处理的操作错误。
    set(
      params.background && current.error
        ? { ...result, error: current.error, lastFailedPluginId: current.lastFailedPluginId }
        : result,
    );
  } finally {
    if (inFlightLoads.get(loadKey) === request) inFlightLoads.delete(loadKey);
  }
}

async function runLoadInto(
  params: PluginLoadParams & { workspaceKey: string },
): Promise<Partial<PluginManagementState>> {
  try {
    // React StrictMode、settings service 引用刷新或快速切换设置页时，
    // 同一 workspace 会并发触发 initialize。每次触发都发成独立 plugins/list 的话，
    // agent 已经 stale 时这些请求会排队产生多个 30s timeout。按 workspaceKey 复用 in-flight
    // 请求，并在仍处于同一 workspace 时才回写结果，避免过期响应覆盖当前设置页。
    const [listResult, overviewResult] = await Promise.all([
      params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
      params.pluginService.getPluginsOverview({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    ]);
    const diagnostics = [...listResult.diagnostics, ...overviewResult.diagnostics];
    return {
      plugins: listResult.plugins,
      marketplaces: overviewResult.marketplaces,
      marketplaceAvailabilityKnown: true,
      availablePlugins: overviewResult.availablePlugins,
      installedPlugins: overviewResult.installedPlugins,
      restorableBuiltins: overviewResult.restorableBuiltins,
      diagnostics,
      loading: false,
    };
  } catch (error) {
    logger.error("[plugins] overview/list failed", {
      workspacePath: params.workspacePath,
      workspaceKey: params.workspaceKey,
      lastFailedPluginId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const result = await params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      });
      return {
        plugins: result.plugins,
        marketplaces: [],
        // overview 失败时空数组表示“来源状态未知”，而不是“所有来源已删除”。
        // 保留该边界，避免 list fallback 返回的 official/cache 插件被批量误判为孤立安装。
        marketplaceAvailabilityKnown: false,
        availablePlugins: [],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: result.diagnostics,
        loading: false,
      };
    } catch (listError) {
      logger.error("[plugins] list fallback failed", {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
      return {
        loading: false,
        marketplaceAvailabilityKnown: false,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      };
    }
  }
}
