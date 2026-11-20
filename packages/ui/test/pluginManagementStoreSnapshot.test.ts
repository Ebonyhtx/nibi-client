import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NibiPluginsOverviewResult, NibiPluginInfo } from "@nibi/shared";
import type { IPluginManagementService } from "@nibi/services";
import { createPluginManagementStore } from "../src/store/pluginManagementStore.js";
import {
  PLUGIN_MANAGEMENT_SNAPSHOT_TTL_MS,
  notifyPluginManagementChange,
  resetPluginManagementSnapshotsForTests,
} from "../src/store/pluginManagementStoreLoading.js";

function makePlugin(overrides: Partial<NibiPluginInfo> = {}): NibiPluginInfo {
  return {
    id: "skill-creator@nibi-official",
    name: "skill-creator",
    enabled: true,
    source: "official",
    marketplace: "nibi-official",
    skillCount: 1,
    skillRootCount: 1,
    commandRootCount: 0,
    mcpServerNames: [],
    rootPath: "/cache/skill-creator",
    ...overrides,
  };
}

function makeOverview(
  overrides: Partial<NibiPluginsOverviewResult> = {},
): NibiPluginsOverviewResult {
  return {
    marketplaces: [
      {
        id: "nibi-official",
        name: "nibi-official",
        source: { source: "url", url: "https://example.test/marketplace.json" } as never,
        pluginCount: 1,
        lastUpdated: "2026-11-20T10:00:00.000Z",
      },
    ],
    availablePlugins: [
      {
        id: "skill-creator@nibi-official",
        name: "skill-creator",
        marketplace: "nibi-official",
        installed: false,
      },
    ],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
    ...overrides,
  };
}

function createPluginServiceMock(overrides?: {
  getPluginsOverview?: IPluginManagementService["getPluginsOverview"];
  listPlugins?: IPluginManagementService["listPlugins"];
  updatePluginMarketplace?: IPluginManagementService["updatePluginMarketplace"];
}): IPluginManagementService {
  return {
    getPluginsOverview: overrides?.getPluginsOverview ?? vi.fn(async () => makeOverview()),
    listPlugins:
      overrides?.listPlugins ?? vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] })),
    updatePluginMarketplace:
      overrides?.updatePluginMarketplace ?? vi.fn(async () => ({ diagnostics: [] })),
  } as unknown as IPluginManagementService;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetPluginManagementSnapshotsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin management snapshots across mounts", () => {
  it("renders the previous projection on the next mount without a new discovery", async () => {
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const service = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    const first = createPluginManagementStore();
    await first.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    expect(listPlugins).toHaveBeenCalledTimes(1);

    const second = createPluginManagementStore();
    await second.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    expect(second.getState().plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
    expect(second.getState().marketplaces.map((marketplace) => marketplace.id)).toEqual([
      "nibi-official",
    ]);
    expect(second.getState().loading).toBe(false);
    // TTL 内命中快照：不因为重新挂载再跑一轮 list + overview。
    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(getPluginsOverview).toHaveBeenCalledTimes(1);
  });

  it("uses a stale snapshot immediately and refreshes it in the background", async () => {
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const service = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
    });

    const first = createPluginManagementStore();
    await first.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    const refresh = deferred<{ plugins: NibiPluginInfo[]; diagnostics: [] }>();
    listPlugins.mockImplementation(() => refresh.promise);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + PLUGIN_MANAGEMENT_SNAPSHOT_TTL_MS + 1);

    const second = createPluginManagementStore();
    const initialize = second.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService: service,
    });

    // initialize 不等待慢查询：旧目录同步可见，后台请求还在飞。
    await initialize;
    expect(second.getState().plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
    expect(second.getState().loading).toBe(false);
    expect(listPlugins).toHaveBeenCalledTimes(2);

    refresh.resolve({ plugins: [makePlugin({ name: "fresh" })], diagnostics: [] });
    await vi.waitFor(() =>
      expect(second.getState().plugins.map((plugin) => plugin.name)).toEqual(["fresh"]),
    );
  });

  it("does not reuse a projection across workspaces, Source authorities, or config scopes", async () => {
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const service = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
    });

    const sourceA = createPluginManagementStore();
    await sourceA.getState().initialize({ workspacePath: "/workspace/a", pluginService: service });

    // 同 service、不同 workspace：必须重新加载，不能先显示 a 的目录。
    const workspaceB = deferred<{ plugins: NibiPluginInfo[]; diagnostics: [] }>();
    listPlugins.mockImplementationOnce(() => workspaceB.promise);
    const storeB = createPluginManagementStore();
    const initializeB = storeB.getState().initialize({
      workspacePath: "/workspace/b",
      pluginService: service,
    });
    expect(storeB.getState().plugins).toEqual([]);
    expect(storeB.getState().loading).toBe(true);
    workspaceB.resolve({ plugins: [makePlugin({ name: "workspace-b" })], diagnostics: [] });
    await initializeB;
    expect(storeB.getState().plugins.map((plugin) => plugin.name)).toEqual(["workspace-b"]);

    // 同路径、不同 authority（另一台 Source 的 home）：不能复用本机快照。
    const authorityB = deferred<{ plugins: NibiPluginInfo[]; diagnostics: [] }>();
    listPlugins.mockImplementationOnce(() => authorityB.promise);
    const sourceStore = createPluginManagementStore();
    const initializeAuthority = sourceStore.getState().initialize({
      workspacePath: "/workspace/a",
      authorityKey: "source-settings:server-b",
      pluginService: service,
    });
    expect(sourceStore.getState().plugins).toEqual([]);
    expect(sourceStore.getState().loading).toBe(true);
    authorityB.resolve({ plugins: [makePlugin({ name: "source-b" })], diagnostics: [] });
    await initializeAuthority;
    expect(sourceStore.getState().plugins.map((plugin) => plugin.name)).toEqual(["source-b"]);

    // 同 workspace、不同配置层：User 与 Workspace 投影不能互相复用。
    const userScope = deferred<{ plugins: NibiPluginInfo[]; diagnostics: [] }>();
    listPlugins.mockImplementationOnce(() => userScope.promise);
    const userStore = createPluginManagementStore();
    const initializeUser = userStore.getState().initialize({
      workspacePath: "/workspace/a",
      configScope: "user",
      pluginService: service,
    });
    expect(userStore.getState().plugins).toEqual([]);
    expect(userStore.getState().loading).toBe(true);
    userScope.resolve({ plugins: [makePlugin({ name: "user-view" })], diagnostics: [] });
    await initializeUser;
    expect(userStore.getState().plugins.map((plugin) => plugin.name)).toEqual(["user-view"]);
  });

  it("does not let a query started before a change overwrite the newer snapshot", async () => {
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const service = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    // 变更前启动的慢查询。
    const stale = deferred<{ plugins: NibiPluginInfo[]; diagnostics: [] }>();
    listPlugins.mockImplementationOnce(() => stale.promise);
    const staleRefresh = store.getState().refresh(service, { background: true });

    // 变更通知让旧查询的 revision 过期；随后开始的一轮刷新拿到新结果。
    notifyPluginManagementChange({
      workspacePath: "/workspace/app",
      workspaceIdentity: null,
      authorityKey: null,
      scope: "user",
    });
    listPlugins.mockImplementation(async () => ({
      plugins: [makePlugin({ name: "newer" })],
      diagnostics: [],
    }));
    const freshRefresh = store.getState().refresh(service, { background: true });

    stale.resolve({ plugins: [makePlugin({ name: "stale" })], diagnostics: [] });
    await Promise.all([staleRefresh, freshRefresh]);

    const nextMount = createPluginManagementStore();
    await nextMount.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService: service,
    });
    // 下一次 mount 读到的是变更后的快照，而不是更晚返回的旧查询结果。
    expect(nextMount.getState().plugins.map((plugin) => plugin.name)).toEqual(["newer"]);
  });

  it("keeps the previous catalog and loading=false when a marketplace refresh fails", async () => {
    let rejectRefresh!: (reason?: unknown) => void;
    const updatePluginMarketplace = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectRefresh = reject;
        }),
    );
    const service = createPluginServiceMock({
      updatePluginMarketplace:
        updatePluginMarketplace as unknown as IPluginManagementService["updatePluginMarketplace"],
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const catalogBeforeFailure = store.getState().marketplaces;

    const refresh = store.getState().updateMarketplace("nibi-official", service);

    // 刷新在飞时列表 loading 不被置起（PluginStorePage 的列表 loading 只读 state.loading）。
    expect(store.getState().loading).toBe(false);
    expect(store.getState().activeOperations).toHaveLength(1);

    rejectRefresh(new Error("offline"));
    await expect(refresh).resolves.toBe(false);

    expect(store.getState().marketplaces).toBe(catalogBeforeFailure);
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toContain("offline");
  });
});
