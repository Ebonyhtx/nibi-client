/* eslint-disable max-lines -- MCP store 集中维护配置加载、持久化、状态刷新与运行时状态合并，拆分会增加跨状态同步复杂度。 */
/**
 * MCP (Model Context Protocol) UI State Store
 */
import { create } from "zustand";
import type {
  NibiAgentMcpServer,
  CliMcpSource,
  McpConfig,
  McpScope,
  McpServerConfig,
  McpServerStatus,
  McpSource,
  NativeMcpServerRecord,
  WorkspaceMcpTrustDecision,
  NibiMcpListMode,
  NibiMcpServerStatusSnapshot,
  NibiMcpServer,
} from "@nibi/shared";
import { convertToNibiAgentMcpServer } from "@nibi/shared";
import { logger } from "@/logger.js";
import {
  decideWorkspaceMcpTrustThroughDirectoryService,
  decideWorkspaceMcpTrustThroughPlatform,
  fetchNativeMcpServers,
  persistCliMcpToUserDirectory,
  type McpDirectoryService,
  type McpPlatformService,
  type WorkspaceMcpTrustReasonCode,
  type WorkspaceMcpTrustReviewView,
} from "@/store/mcpStoreDesktop.js";
import {
  buildServerList,
  DEFAULT_MCP_CONFIG,
  getServerPriority,
  loadPersistedConfig,
  makeServerId,
  MCP_DELETED_PRELOAD_KEY,
  safeReadJson,
  safeWriteJson,
} from "@/store/mcpStoreHelpers.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { mergeMcpServerStatusSnapshots } from "@/store/mcpStoreStatusList.js";

let mcpPlatformService: McpPlatformService | null = null;

export function setMcpStorePlatform(platform: McpPlatformService | null): void {
  mcpPlatformService = platform;
}

interface UpdateServerStatusOptions {
  invalidateStatusListRequests?: boolean;
}

interface McpStoreState {
  config: McpConfig;
  nativeServers: NativeMcpServerRecord[];
  servers: NibiMcpServer[];
  statusSnapshots: Record<string, NibiMcpServerStatusSnapshot>;
  /** 项目级 MCP 的 Host 审核状态（Host 唯一 owner；未信任的项目 server 不进入 Agent）。 */
  workspaceTrust: Record<string, WorkspaceMcpTrustReviewView>;
  /**
   * 当前 Host 是否返回了 trust 元数据。旧远端 Host 没有该字段时保持兼容（不按未知状态拦截）；
   * 本机 Host 与新远端 Host 一律 true，按 fail-closed 过滤。
   */
  workspaceTrustKnown: boolean;
  /** Host 明确拒绝审核时的原因（未登记/离线/信任存储不可用）；没有 review 时用于只读展示。 */
  workspaceTrustReasonCode?: WorkspaceMcpTrustReasonCode;
  /** 无法归一化、Host 按未信任处理的项目 server 名。 */
  workspaceTrustUnreviewable: string[];
  currentProjectPath: string;
  currentWorkspaceIdentity?: string;
  currentAuthorityKey?: string;
  /**
   * 当前目标的目录服务，与 currentProjectPath / currentWorkspaceIdentity / currentAuthorityKey
   * 是同一组绑定，只由 setCurrentProjectPath / ensureLoadedForWorkspace 一起写入。
   */
  currentDirectoryService: McpDirectoryService | null;
  enabledStates: Record<string, boolean>;
  deletedPreloadMcpServers: Set<string>;
  isConfigLoaded: boolean;
  currentSessionId: string | null;
  loadConfig: () => void;
  /** 重新读取当前绑定目标的 MCP 配置；要换目标请用 ensureLoadedForWorkspace。 */
  loadMcpFromUserDirectory: () => Promise<boolean>;
  ensureLoadedForWorkspace: (
    workspacePath?: string,
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
    authorityKey?: string,
  ) => Promise<boolean>;
  saveConfig: () => void;
  addMcpServer: (name: string, config: McpServerConfig) => void;
  updateMcpServer: (name: string, config: McpServerConfig) => void;
  deleteMcpServer: (name: string) => void;
  addScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  updateScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  deleteScopedMcpServer: (source: McpSource, name: string, projectPath?: string) => void;
  addNibiAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateNibiAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteNibiAgentMcpServer: (name: string, projectPath?: string) => void;
  addClaudeCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateClaudeCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteClaudeCliMcpServer: (name: string, projectPath?: string) => void;
  addGeminiCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateGeminiCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteGeminiCliMcpServer: (name: string, projectPath?: string) => void;
  addCodexCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateCodexCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteCodexCliMcpServer: (name: string, projectPath?: string) => void;
  addOpenCodeMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateOpenCodeMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteOpenCodeMcpServer: (name: string, projectPath?: string) => void;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  updateServerStatus: (
    id: string,
    status: McpServerStatus,
    error?: string,
    options?: UpdateServerStatusOptions,
  ) => void;
  beginServerStatusListRefresh: (mode?: NibiMcpListMode) => number;
  markServerStatusListRefreshFailed: (
    error: string,
    requestEpoch: number,
    mode?: NibiMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, NibiMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: "connect" | "status",
  ) => void;
  getServer: (id: string) => NibiMcpServer | undefined;
  setCurrentProjectPath: (
    path: string,
    workspaceIdentity?: string,
    directoryService?: McpDirectoryService | null,
    authorityKey?: string,
  ) => void;
  /** 对一条当前项目声明提交显式信任/撤销；成功后重新读取 Host review。 */
  decideWorkspaceTrust: (
    serverName: string,
    trusted: boolean,
  ) => Promise<WorkspaceMcpTrustDecision>;
  getEnabledMcpServersForNibi: (provider: string) => NibiAgentMcpServer[];
  checkAllServerStatus: (
    tester: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>,
  ) => Promise<void>;
  mergePreloadedMcpServers: (preloaded: Record<string, McpServerConfig>) => void;
  deletePreloadedMcpServer: (source: McpSource, name: string) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
}

export const useMcpStore = create<McpStoreState>((set, get) => {
  let loadMcpPromise: Promise<boolean> | null = null;
  let loadMcpWorkspaceKey: string | null = null;
  const statusListEpochs: Record<NibiMcpListMode, number> = {
    connect: 0,
    status: 0,
  };

  function invalidateStatusListRequests(): void {
    statusListEpochs.connect += 1;
    statusListEpochs.status += 1;
  }

  function resolveTargetDirectoryService(): McpDirectoryService | null {
    const { currentAuthorityKey, currentDirectoryService, currentWorkspaceIdentity } = get();
    if (!currentWorkspaceIdentity && !currentAuthorityKey) {
      // 本地 workspace / 本机「用户」仍要走 desktop platform 路径，才能执行旧 common MCP
      // 到用户级 Nibi Agent MCP 的迁移；目录服务只用于远端目标覆盖路由。
      return null;
    }
    if (!currentDirectoryService) {
      // 远端目标没有绑定服务时 fail-closed，不回退本机 platform 或旧全局服务。
      throw new Error("MCP directory service is not bound to the remote target");
    }
    return currentDirectoryService;
  }

  function commitState(partial: {
    config?: McpConfig;
    nativeServers?: NativeMcpServerRecord[];
  }): Partial<McpStoreState> {
    const state = get();
    const nextConfig = partial.config ?? state.config;
    const nextNativeServers = partial.nativeServers ?? state.nativeServers;
    return {
      config: nextConfig,
      nativeServers: nextNativeServers,
      servers: buildServerList(
        nextConfig,
        nextNativeServers,
        state.enabledStates,
        state.deletedPreloadMcpServers,
        state.servers,
      ),
    };
  }

  function updateNativeServer(
    source: CliMcpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) {
    const nativeServers = get().nativeServers.slice();
    const targetIndex = nativeServers.findIndex(
      (server) =>
        server.source === source && server.name === name && server.projectPath === projectPath,
    );
    if (targetIndex >= 0) {
      const existing = nativeServers[targetIndex];
      if (!existing) {
        return;
      }
      nativeServers[targetIndex] = {
        ...existing,
        config,
      };
    } else {
      // 添加新的服务器记录
      const scope: McpScope = projectPath ? "workspace" : "user";
      nativeServers.push({
        source,
        scope,
        name,
        config,
        enabled: true,
        projectPath,
      });
    }
    // 项目声明被修改后旧审核摘要失效；同名重新保存必须重新审核，不能沿用旧 trusted。
    const workspaceTrust = { ...get().workspaceTrust };
    if (projectPath) delete workspaceTrust[name];
    set({
      ...commitState({ nativeServers }),
      workspaceTrust,
      ...(projectPath
        ? {
            workspaceTrustReasonCode: undefined,
            workspaceTrustUnreviewable: get().workspaceTrustUnreviewable.filter(
              (item) => item !== name,
            ),
          }
        : {}),
    });
  }

  async function persistScopedChange(
    source: McpSource,
    payload: {
      action: "upsert" | "delete";
      source: CliMcpSource;
      name: string;
      config?: McpServerConfig;
      projectPath?: string;
    },
  ): Promise<void> {
    if (source === "mcp") {
      return;
    }

    await persistCliMcpToUserDirectory(
      mcpPlatformService,
      payload,
      resolveTargetDirectoryService(),
    ).catch((error) => {
      logger.warn(`[mcpStore] persist ${source} MCP failed`, String(error));
    });
  }

  return {
    config: { ...DEFAULT_MCP_CONFIG },
    nativeServers: [],
    servers: [],
    statusSnapshots: {},
    workspaceTrust: {},
    workspaceTrustKnown: false,
    workspaceTrustReasonCode: undefined,
    workspaceTrustUnreviewable: [],
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    currentAuthorityKey: undefined,
    currentDirectoryService: null,
    enabledStates: {},
    deletedPreloadMcpServers: new Set(),
    isConfigLoaded: false,
    currentSessionId: null,

    loadConfig: () => {
      const config = loadPersistedConfig();
      // MCP 启停状态已经迁移到 ~/.nibi/cli/config.json，不能再读取旧 localStorage，
      // 否则旧的本地开关会覆盖新的 Nibi Agent 配置来源。
      const enabledStates: Record<string, boolean> = {};
      const deletedPreload = new Set<string>(safeReadJson<string[]>(MCP_DELETED_PRELOAD_KEY, []));
      const servers = buildServerList(config, [], enabledStates, deletedPreload, []);
      set({
        config,
        nativeServers: [],
        enabledStates,
        deletedPreloadMcpServers: deletedPreload,
        servers,
        statusSnapshots: {},
        isConfigLoaded: true,
      });
    },

    loadMcpFromUserDirectory: async () => {
      if (typeof window === "undefined") {
        return false;
      }

      const requestWorkspaceKey = `${get().currentAuthorityKey?.trim() || "workspace"}\0${get().currentWorkspaceIdentity?.trim() || get().currentProjectPath}`;
      if (loadMcpPromise && loadMcpWorkspaceKey === requestWorkspaceKey) {
        return await loadMcpPromise;
      }
      if (loadMcpPromise) {
        await loadMcpPromise;
      }

      const latestWorkspacePath = get().currentProjectPath || undefined;
      const latestWorkspaceIdentity = get().currentWorkspaceIdentity;
      const latestWorkspaceKey = `${get().currentAuthorityKey?.trim() || "workspace"}\0${get().currentWorkspaceIdentity?.trim() || get().currentProjectPath}`;
      if (latestWorkspaceKey !== requestWorkspaceKey) {
        // 该调用等待上一轮 load 时已从 B 切到 C；B 调用持有的 remote
        // directoryService 不得继续读取 C，交给 C 自己发起的 ensure/load 调用处理。
        return false;
      }
      if (loadMcpPromise && loadMcpWorkspaceKey === latestWorkspaceKey) {
        return await loadMcpPromise;
      }

      loadMcpWorkspaceKey = latestWorkspaceKey;
      loadMcpPromise = (async () => {
        try {
          // 等待上一 workspace load 期间可能再次切换；目录服务取等待后的最新绑定，
          // 与 requestWorkspaceKey 属于同一组目标，不能拿 B 的 remote service 去读取 C 的路径。
          const activeDirectoryService = resolveTargetDirectoryService();
          logger.info(
            `[mcpStore] loadMcpFromUserDirectory workspace=${latestWorkspacePath ?? "<none>"} identity=${latestWorkspaceIdentity ?? "<none>"}`,
          );
          const loaded = await fetchNativeMcpServers(
            mcpPlatformService,
            {
              workspacePath: latestWorkspacePath,
              ...(latestWorkspaceIdentity?.trim()
                ? { workspaceIdentity: latestWorkspaceIdentity.trim() }
                : {}),
            },
            activeDirectoryService,
          );
          const servers = loaded.servers ?? [];
          const currentState = get();
          const currentWorkspaceKey = `${currentState.currentAuthorityKey?.trim() || "workspace"}\0${currentState.currentWorkspaceIdentity?.trim() || currentState.currentProjectPath}`;
          if (currentWorkspaceKey !== latestWorkspaceKey) {
            // workspace A 的异步目录读取可能晚于切换到 B 才返回；
            // 旧结果包含 env/header/OAuth secret，不能写回共享 store 后被 B 的 Agent 消费。
            return false;
          }
          set({
            ...commitState({ nativeServers: servers }),
            workspaceTrust: loaded.trust ?? {},
            // Host 只返回原因码（未登记/离线）时也开始展示只读审核状态；
            // 旧远端 Host 不返回任何 trust 元数据时才保持 known=false 的兼容行为。
            workspaceTrustKnown: loaded.trust !== undefined || loaded.trustReasonCode !== undefined,
            workspaceTrustReasonCode: loaded.trustReasonCode,
            workspaceTrustUnreviewable: loaded.unreviewable ?? [],
          });
          return true;
        } catch (e) {
          // 读取失败不是“配置为空”；调用方必须保持 workspace not-ready，
          // 否则会显式下发空 mcpServers 并触发 replace，断开仍在运行的 MCP。
          // remote session attachment 绑定前只能拿到断连代理；这是初始化时序，不是
          // MCP 配置读取失败。只过滤该精确错误码，避免吞掉真实的目录或 RPC 故障。
          if (!isRemoteWorkspaceDisconnectedError(e)) {
            logger.warn("[mcpStore] loadMcpFromUserDirectory failed", String(e));
          }
          return false;
        } finally {
          loadMcpPromise = null;
          loadMcpWorkspaceKey = null;
        }
      })();

      return await loadMcpPromise;
    },

    ensureLoadedForWorkspace: async (
      workspacePath,
      directoryService,
      workspaceIdentity,
      authorityKey,
    ) => {
      if (!get().isConfigLoaded) {
        get().loadConfig();
      }

      const normalizedWorkspacePath = workspacePath ?? "";
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const normalizedAuthorityKey = authorityKey?.trim() || undefined;
      if (
        normalizedWorkspacePath !== get().currentProjectPath ||
        normalizedWorkspaceIdentity !== get().currentWorkspaceIdentity ||
        normalizedAuthorityKey !== get().currentAuthorityKey
      ) {
        get().setCurrentProjectPath(
          normalizedWorkspacePath,
          normalizedWorkspaceIdentity,
          directoryService,
          normalizedAuthorityKey,
        );
      } else if ((directoryService ?? null) !== get().currentDirectoryService) {
        // 同一目标换了服务对象（例如 attachment 换代）：只换绑服务，不清空列表。
        set({ currentDirectoryService: directoryService ?? null });
      }

      return await get().loadMcpFromUserDirectory();
    },

    saveConfig: () => {
      const { deletedPreloadMcpServers } = get();
      safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(deletedPreloadMcpServers));
    },

    addMcpServer: (name, config) => get().addNibiAgentMcpServer(name, config),
    updateMcpServer: (name, config) => get().updateNibiAgentMcpServer(name, config),
    deleteMcpServer: (name) => get().deleteNibiAgentMcpServer(name),
    addScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 设置页保存后会马上触发 agent 侧 mcp/list 重连。
      // 先等配置落盘，再更新本地 store，避免 agent 读到旧 timeoutMs 后展示旧健康状态。
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    updateScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 修复原因同新增：本地状态变化会驱动健康状态刷新，必须在磁盘配置更新后发生。
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    deleteScopedMcpServer: (source, name, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      persistScopedChange(targetSource, {
        action: "delete",
        source: targetSource,
        name,
        projectPath,
      });
      set(
        commitState({
          nativeServers: get().nativeServers.filter(
            (server) =>
              !(
                server.source === targetSource &&
                server.name === name &&
                server.projectPath === projectPath
              ),
          ),
        }),
      );
    },
    addClaudeCliMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("claudeclimcp", name, config, projectPath),
    updateClaudeCliMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("claudeclimcp", name, config, projectPath),
    deleteClaudeCliMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("claudeclimcp", name, projectPath),
    addGeminiCliMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("geminiclimcp", name, config, projectPath),
    updateGeminiCliMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("geminiclimcp", name, config, projectPath),
    deleteGeminiCliMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("geminiclimcp", name, projectPath),
    addCodexCliMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("codexclimcp", name, config, projectPath),
    updateCodexCliMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("codexclimcp", name, config, projectPath),
    deleteCodexCliMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("codexclimcp", name, projectPath),
    addOpenCodeMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("opencodemcp", name, config, projectPath),
    updateOpenCodeMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("opencodemcp", name, config, projectPath),
    deleteOpenCodeMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("opencodemcp", name, projectPath),
    addNibiAgentMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    updateNibiAgentMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    deleteNibiAgentMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("zcodeagentmcp", name, projectPath),

    toggleServer: async (id, enabled) => {
      invalidateStatusListRequests();
      const targetServer = get().servers.find((server) => server.id === id);
      if (targetServer && targetServer.source !== "mcp") {
        // 开关变化会触发 agent 侧 mcp/list 读取磁盘配置做真实连接。
        // 必须先等 enable 状态落盘，再更新本地列表驱动刷新，否则 agent 会读到旧开关。
        await persistCliMcpToUserDirectory(
          mcpPlatformService,
          {
            action: "set-enabled",
            source: targetServer.source,
            name: targetServer.name,
            enabled,
            projectPath: targetServer.projectPath,
            location: targetServer.location,
          },
          resolveTargetDirectoryService(),
        ).catch((error) => {
          logger.warn("[mcpStore] persist MCP enabled override failed", String(error));
        });
      }

      set((state) => {
        const nextEnabledStates = { ...state.enabledStates, [id]: enabled };
        return {
          enabledStates: nextEnabledStates,
          servers: state.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
        };
      });
    },

    updateServerStatus: (id, status, error, options) => {
      if (options?.invalidateStatusListRequests !== false) {
        invalidateStatusListRequests();
      }
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                authorization: undefined,
                error,
                failureKind: status === "error" ? "connection_failed" : undefined,
                serverRequestId: undefined,
                toolCount: status === "connected" ? s.toolCount : undefined,
                changed: status === "error" ? s.changed : false,
                lastConnected: status === "connected" ? new Date() : s.lastConnected,
              }
            : s,
        ),
      }));
    },

    beginServerStatusListRefresh: (mode = "connect") => {
      statusListEpochs[mode] += 1;
      const requestEpoch = statusListEpochs[mode];
      if (mode === "status") {
        // OAuth 1s status-only 轮询只读取 runtime snapshot；不能反复清空
        // authorization/toolCount 或把用户同时编辑的其他 MCP 投影成 connecting。
        return requestEpoch;
      }
      // agent 侧 mcp/list 会等待所有 MCP 连接完成才返回；如果插件 MCP 还在 30s 超时中，
      // 修改 timeoutMs 后本地列表会长时间停在 unknown，看起来像没有立即重新检查。
      set((state) => ({
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (
            server.source !== "zcodeagentmcp" ||
            !enabled ||
            (!server.changed && server.status !== "unknown")
          ) {
            return server;
          }
          return {
            ...server,
            status: "connecting",
            authorization: undefined,
            error: undefined,
            failureKind: undefined,
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
      return requestEpoch;
    },

    markServerStatusListRefreshFailed: (error, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode] || mode === "status") {
        // OAuth 轮询是只读的 best-effort status 请求；临时失败不能清空已有
        // authorization snapshot，也不能把同一列表中仍在连接的 MCP 批量标红。
        return;
      }
      set((state) => ({
        statusSnapshots: {},
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (server.source !== "zcodeagentmcp" || !enabled || server.status !== "connecting") {
            return server;
          }
          return {
            ...server,
            status: "error",
            authorization: undefined,
            error,
            failureKind: "status_unavailable",
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
    },

    mergeServerStatusSnapshots: (statuses, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode]) {
        return;
      }
      set((state) => {
        const nextStatusSnapshots =
          mode === "status" ? { ...state.statusSnapshots, ...statuses } : statuses;
        return {
          statusSnapshots: nextStatusSnapshots,
          servers: mergeMcpServerStatusSnapshots(state.servers, nextStatusSnapshots, {
            // Bugfix：OAuth 轮询的 status-only 响应可能只包含 pending 子集。
            // 缺失项不能按全量 mcp/list 处理，否则会把其他 MCP 误标为 agent 未返回。
            markMissingConnectingAsError: mode !== "status",
          }),
        };
      });
    },

    getServer: (id) => get().servers.find((s) => s.id === id),

    setCurrentProjectPath: (path, workspaceIdentity, directoryService, authorityKey) => {
      invalidateStatusListRequests();
      const {
        config,
        currentProjectPath,
        currentWorkspaceIdentity,
        currentAuthorityKey,
        deletedPreloadMcpServers,
        enabledStates,
        isConfigLoaded,
        nativeServers,
        servers,
      } = get();
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const normalizedAuthorityKey = authorityKey?.trim() || undefined;
      const workspaceChanged =
        path !== currentProjectPath ||
        normalizedWorkspaceIdentity !== currentWorkspaceIdentity ||
        normalizedAuthorityKey !== currentAuthorityKey;
      const nextNativeServers = workspaceChanged ? [] : nativeServers;
      set({
        currentProjectPath: path,
        currentWorkspaceIdentity: normalizedWorkspaceIdentity,
        currentAuthorityKey: normalizedAuthorityKey,
        currentDirectoryService: directoryService ?? null,
        nativeServers: nextNativeServers,
        workspaceTrust: workspaceChanged ? {} : get().workspaceTrust,
        workspaceTrustKnown: workspaceChanged ? false : get().workspaceTrustKnown,
        workspaceTrustReasonCode: workspaceChanged ? undefined : get().workspaceTrustReasonCode,
        workspaceTrustUnreviewable: workspaceChanged ? [] : get().workspaceTrustUnreviewable,
        statusSnapshots: {},
        servers: buildServerList(
          config,
          nextNativeServers,
          enabledStates,
          deletedPreloadMcpServers,
          workspaceChanged ? [] : servers,
        ),
      });
      if (isConfigLoaded && workspaceChanged) {
        // 切换到远程 workspace 后配置加载是异步的；等待期间必须先清空 A 的
        // user-level MCP，不能把其 env/header/OAuth clientSecret 暂存为 B 的可发送配置。
        void get().loadMcpFromUserDirectory();
      }
    },

    decideWorkspaceTrust: async (serverName, trusted) => {
      const state = get();
      const review = state.workspaceTrust[serverName];
      const workspacePath = state.currentProjectPath;
      if (!workspacePath || !review) {
        return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
      }
      const workspaceIdentity = state.currentWorkspaceIdentity?.trim() || undefined;
      const request = {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        serverName,
        declarationDigest: review.declarationDigest,
        trusted,
      };
      // 远端工作区的信任记录在远端用户域；只有本地 workspace 才走 Desktop Host 的
      // window-registration 桥。拿错一侧会写出内核看不见的记录。
      const directoryService = resolveTargetDirectoryService();
      const decision = directoryService
        ? await decideWorkspaceMcpTrustThroughDirectoryService(directoryService, request)
        : await decideWorkspaceMcpTrustThroughPlatform(mcpPlatformService, request);
      if (!decision.accepted) {
        // Host 拒绝（声明已变化、未登记、离线、存储不可用）：保持 review 原样并只读展示原因。
        set({ workspaceTrustReasonCode: decision.reasonCode });
        return decision;
      }

      // 成功只代表 Host 接受了本次写入；必须重新读取 Host review，不能用本地状态推断已信任。
      try {
        const loaded = await fetchNativeMcpServers(
          mcpPlatformService,
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          },
          // 远端必须用同一绑定服务重读；此前固定传 null 会读本机平台（远端路径在本机不存在），
          // 导致审批成功后 UI 仍显示未信任或把本机结果当成远端 review。
          directoryService,
        );
        const latest = get();
        if (
          latest.currentProjectPath !== workspacePath ||
          (latest.currentWorkspaceIdentity?.trim() || undefined) !== workspaceIdentity
        ) {
          return decision;
        }
        set({
          workspaceTrust: loaded.trust ?? {},
          workspaceTrustKnown: loaded.trust !== undefined || loaded.trustReasonCode !== undefined,
          workspaceTrustReasonCode: loaded.trustReasonCode,
          workspaceTrustUnreviewable: loaded.unreviewable ?? [],
        });
      } catch (error) {
        logger.warn("[mcpStore] reload workspace MCP trust after decision failed", String(error));
        set({ workspaceTrustReasonCode: "workspace_mcp_trust_unavailable" });
      }
      return decision;
    },

    getEnabledMcpServersForNibi: (_provider) => {
      const { servers, enabledStates, currentProjectPath, workspaceTrust, workspaceTrustKnown } =
        get();
      const candidates = new Map<string, NibiMcpServer>();

      for (const server of servers) {
        const isEnabled = enabledStates[server.id] ?? server.enabled;
        if (!isEnabled) continue;
        if (server.source !== "zcodeagentmcp") continue;
        if (server.scope === "workspace") {
          if (server.projectPath !== currentProjectPath) continue;
          // 项目级 MCP 必须通过 Host 的当前声明审核；未信任/不可审核/离线不进入 Agent。
          // 旧远端 Host 没有 trust 元数据时保持兼容，不按未知状态批量停用项目 MCP。
          if (workspaceTrustKnown && workspaceTrust[server.name]?.trusted !== true) continue;
        }

        const existing = candidates.get(server.name);
        if (!existing || getServerPriority(server) > getServerPriority(existing)) {
          candidates.set(server.name, server);
        }
      }

      const result: NibiAgentMcpServer[] = [];
      for (const server of candidates.values()) {
        const nibiAgentServer = convertToNibiAgentMcpServer(server.name, server.config);
        if (nibiAgentServer) result.push(nibiAgentServer);
      }
      return result;
    },

    checkAllServerStatus: async (tester) => {
      for (const server of get().servers) {
        const isEnabled = get().enabledStates[server.id] ?? server.enabled;
        if (!isEnabled || (!server.changed && server.status !== "unknown")) continue;

        get().updateServerStatus(server.id, "connecting");
        try {
          const result = await tester(server.config);
          get().updateServerStatus(
            server.id,
            result.success ? "connected" : "error",
            result.success ? undefined : (result.error ?? "Connection failed"),
          );
        } catch (e) {
          get().updateServerStatus(server.id, "error", String(e));
        }
      }
    },

    mergePreloadedMcpServers: (preloaded) => {
      const { deletedPreloadMcpServers, nativeServers } = get();
      const targetSource: CliMcpSource = "zcodeagentmcp";
      const nextNativeServers = nativeServers.slice();
      let changed = false;

      for (const [name, cfg] of Object.entries(preloaded)) {
        const serverId = makeServerId(targetSource, name);
        const exists = nextNativeServers.some(
          (server) => server.source === targetSource && server.name === name && !server.projectPath,
        );
        if (deletedPreloadMcpServers.has(serverId) || exists) continue;
        nextNativeServers.push({
          source: targetSource,
          scope: "user",
          name,
          config: cfg,
          enabled: true,
        });
        persistScopedChange(targetSource, {
          action: "upsert",
          source: targetSource,
          name,
          config: cfg,
        });
        changed = true;
      }

      if (!changed) return;
      set(commitState({ nativeServers: nextNativeServers }));
    },

    deletePreloadedMcpServer: (source, name) => {
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      const key = makeServerId(targetSource, name);
      persistScopedChange(targetSource, { action: "delete", source: targetSource, name });
      set((state) => {
        const nextDeleted = new Set(state.deletedPreloadMcpServers);
        nextDeleted.add(key);
        safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(nextDeleted));
        const nextNativeServers = state.nativeServers.filter(
          (server) =>
            !(server.source === targetSource && server.name === name && !server.projectPath),
        );
        return {
          deletedPreloadMcpServers: nextDeleted,
          nativeServers: nextNativeServers,
          servers: buildServerList(
            state.config,
            nextNativeServers,
            state.enabledStates,
            nextDeleted,
            state.servers,
          ),
        };
      });
    },

    setCurrentSessionId: (sessionId) => set({ currentSessionId: sessionId }),
  };
});
