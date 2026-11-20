// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { NibiPluginsOverviewResult } from "@nibi/shared";
import type { IPluginManagementService } from "@nibi/services";
import {
  createPluginManagementStore,
  useScopedPluginManagementStore,
} from "../src/store/pluginManagementStore.js";
import { resetPluginManagementSnapshotsForTests } from "../src/store/pluginManagementStoreLoading.js";

function makeOverview(): NibiPluginsOverviewResult {
  return {
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
  };
}

function createPluginServiceMock(): IPluginManagementService {
  return {
    getPluginsOverview: vi.fn(async () => makeOverview()),
    listPlugins: vi.fn(async () => ({
      plugins: [
        {
          id: "skill-creator@nibi-official",
          name: "skill-creator",
          enabled: true,
          source: "official" as const,
          marketplace: "nibi-official",
          skillCount: 1,
          skillRootCount: 1,
          commandRootCount: 0,
          mcpServerNames: [],
          rootPath: "/cache/skill-creator",
        },
      ],
      diagnostics: [],
    })),
  } as unknown as IPluginManagementService;
}

beforeEach(() => {
  resetPluginManagementSnapshotsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScopedPluginManagementStore seed context", () => {
  it("hydrates the store synchronously from a module-level snapshot", async () => {
    const service = createPluginServiceMock();
    const first = createPluginManagementStore();
    await first.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    const { result, unmount } = renderHook(() =>
      useScopedPluginManagementStore(service, { workspacePath: "/workspace/app" }),
    );

    // 挂载后的第一帧（effect 之前）就应拿到旧目录，而不是先显示空列表/loading。
    expect(result.current.getState().plugins.map((plugin) => plugin.name)).toEqual([
      "skill-creator",
    ]);
    expect(result.current.getState().workspacePath).toBe("/workspace/app");
    expect(result.current.getState().loading).toBe(false);
    unmount();
  });

  it("keeps loading until initialize when no snapshot exists", () => {
    const service = createPluginServiceMock();
    const { result, unmount } = renderHook(() =>
      useScopedPluginManagementStore(service, { workspacePath: "/workspace/app" }),
    );

    expect(result.current.getState().plugins).toEqual([]);
    expect(result.current.getState().loading).toBe(true);
    unmount();
  });
});
