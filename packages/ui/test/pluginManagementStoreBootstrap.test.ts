import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NibiPluginsBootstrapResult,
  NibiPluginsOverviewResult,
  NibiPluginInfo,
} from "@nibi/shared";
import type { IPluginManagementService } from "@nibi/services";
import {
  createPluginManagementStore,
  resetScopedPluginManagementStoresForTests,
  usePluginManagementStore,
} from "../src/store/pluginManagementStore.js";
import { resetPluginManagementSnapshotsForTests } from "../src/store/pluginManagementStoreLoading.js";

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
    diagnostics: [{ code: "overview-diagnostic", message: "overview", severity: "warning" }],
    capability: { supported: true },
    ...overrides,
  };
}

function makeBootstrap(
  overrides: Partial<NibiPluginsBootstrapResult> = {},
): NibiPluginsBootstrapResult {
  return {
    list: {
      plugins: [makePlugin()],
      diagnostics: [{ code: "list-diagnostic", message: "list", severity: "warning" }],
    },
    overview: makeOverview(),
    ...overrides,
  };
}

function createPluginServiceMock(overrides?: {
  getPluginsBootstrap?: IPluginManagementService["getPluginsBootstrap"];
  getPluginsOverview?: IPluginManagementService["getPluginsOverview"];
  listPlugins?: IPluginManagementService["listPlugins"];
}): IPluginManagementService {
  const service: Record<string, unknown> = {
    getPluginsOverview: overrides?.getPluginsOverview ?? vi.fn(async () => makeOverview()),
    listPlugins:
      overrides?.listPlugins ?? vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] })),
  };
  if (overrides?.getPluginsBootstrap) {
    service.getPluginsBootstrap = overrides.getPluginsBootstrap;
  }
  return service as unknown as IPluginManagementService;
}

beforeEach(() => {
  resetPluginManagementSnapshotsForTests();
  resetScopedPluginManagementStoresForTests();
  usePluginManagementStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    authorityKey: null,
    configScope: null,
    plugins: [],
    marketplaces: [],
    marketplaceAvailabilityKnown: false,
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    loading: false,
    error: null,
    errorCode: null,
    lastFailedPluginId: null,
    togglingPluginId: null,
    activeOperations: [],
    describeCache: {},
  });
});

describe("plugin management bootstrap RPC", () => {
  it("uses one bootstrap call and merges list + overview", async () => {
    const getPluginsBootstrap = vi.fn(async () => makeBootstrap());
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const service = createPluginServiceMock({
      getPluginsBootstrap:
        getPluginsBootstrap as unknown as IPluginManagementService["getPluginsBootstrap"],
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore
      .getState()
      .initialize({ workspacePath: "/workspace/app", pluginService: service });

    expect(getPluginsBootstrap).toHaveBeenCalledTimes(1);
    expect(getPluginsBootstrap).toHaveBeenCalledWith({ workspacePath: "/workspace/app" });
    // 新 Host 一次 RPC 完成，不再并行发两个旧请求。
    expect(listPlugins).not.toHaveBeenCalled();
    expect(getPluginsOverview).not.toHaveBeenCalled();
    const state = usePluginManagementStore.getState();
    expect(state.plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
    expect(state.marketplaces.map((marketplace) => marketplace.id)).toEqual(["nibi-official"]);
    expect(state.marketplaceAvailabilityKnown).toBe(true);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "list-diagnostic",
      "overview-diagnostic",
    ]);
    expect(state.error).toBeNull();
  });

  it("falls back to the two legacy RPCs for an old Host without the method", async () => {
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const service = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore
      .getState()
      .initialize({ workspacePath: "/workspace/app", pluginService: service });

    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(getPluginsOverview).toHaveBeenCalledTimes(1);
    expect(usePluginManagementStore.getState().plugins).toHaveLength(1);
    expect(usePluginManagementStore.getState().marketplaceAvailabilityKnown).toBe(true);
  });

  it("falls back when a ProxyChannel reports method-not-found", async () => {
    const getPluginsBootstrap = vi.fn(async () => {
      throw new Error("Method not found: getPluginsBootstrap");
    });
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const service = createPluginServiceMock({
      getPluginsBootstrap:
        getPluginsBootstrap as unknown as IPluginManagementService["getPluginsBootstrap"],
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore
      .getState()
      .initialize({ workspacePath: "/workspace/app", pluginService: service });

    expect(getPluginsBootstrap).toHaveBeenCalledTimes(1);
    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(getPluginsOverview).toHaveBeenCalledTimes(1);
    expect(usePluginManagementStore.getState().plugins).toHaveLength(1);
  });

  it("falls back when a partial implementation returns no usable payload", async () => {
    const getPluginsBootstrap = vi.fn(async () => ({}) as never);
    const listPlugins = vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] }));
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const service = createPluginServiceMock({
      getPluginsBootstrap:
        getPluginsBootstrap as unknown as IPluginManagementService["getPluginsBootstrap"],
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore
      .getState()
      .initialize({ workspacePath: "/workspace/app", pluginService: service });

    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(getPluginsOverview).toHaveBeenCalledTimes(1);
    expect(usePluginManagementStore.getState().plugins).toHaveLength(1);
  });

  it("keeps the last projection when bootstrap and the legacy list both fail", async () => {
    const load = createPluginManagementStore();
    await load.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService: createPluginServiceMock({
        getPluginsBootstrap: vi.fn(async () =>
          makeBootstrap(),
        ) as unknown as IPluginManagementService["getPluginsBootstrap"],
      }),
    });
    expect(load.getState().plugins).toHaveLength(1);

    const failingService = createPluginServiceMock({
      getPluginsBootstrap: vi.fn(async () => {
        throw new Error("discovery failed");
      }) as unknown as IPluginManagementService["getPluginsBootstrap"],
      listPlugins: vi.fn(async () => {
        throw new Error("list failed");
      }) as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview: vi.fn(async () => {
        throw new Error("overview failed");
      }) as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await load.getState().refresh(failingService);

    // 失败只写 error，不得把已有目录清空成“确实没有插件”。
    expect(load.getState().plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
    expect(load.getState().error).toBe("list failed");
    expect(load.getState().loading).toBe(false);
  });
});
