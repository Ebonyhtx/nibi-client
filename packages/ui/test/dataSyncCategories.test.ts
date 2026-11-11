// @vitest-environment jsdom
// 说明：根 vitest.config.ts 的 unit project 只 include `*.test.ts`，现有 `.test.tsx` 不会被默认入口收集；
// 因此这里沿用同目录设置页测试的 `.ts + createElement` 写法，保证用例真正进入 CI。
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@nibi/services";
import type { DataSyncListItem, DataSyncListResult } from "@nibi/shared";
import {
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
  DataSyncSection,
  compareSkillRows,
  resolveDataSyncCategoryService,
  selectSkillHashRequests,
  useDataSyncCategory,
  type DataSyncCategoryId,
} from "@/data-sync/index.js";
import { registerSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";

const hoisted = vi.hoisted(() => ({
  baseServices: undefined as IServiceAccessor | undefined,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => hoisted.baseServices,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: (
        { id }: { id: string },
        values?: Record<string, string | number>,
      ): string =>
        values
          ? `${id}(${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")})`
          : id,
    },
  }),
}));

type CategoryServiceKey =
  | "skillSyncService"
  | "mcpSyncService"
  | "commandsService"
  | "hooksService"
  | "subagentsService"
  | "pluginSyncService";

function item(overrides: Partial<DataSyncListItem> & { key: string }): DataSyncListItem {
  return { name: overrides.key, enabled: true, ...overrides };
}

function listResult(items: DataSyncListItem[], extra: Partial<DataSyncListResult> = {}) {
  return { items, homeDir: "/home/test", ...extra } satisfies DataSyncListResult;
}

function createService(options: {
  list?: () => Promise<DataSyncListResult>;
  hashes?: (params: {
    keys: string[];
    targetHomeDir?: string;
  }) => Promise<{ hashes: Record<string, string> }>;
} = {}) {
  return {
    listSyncItems: vi.fn(options.list ?? (async () => listResult([]))),
    getSyncContentHashes: vi.fn(options.hashes ?? (async () => ({ hashes: {} }))),
    checkSyncWriteAccess: vi.fn(async () => ({ ok: true, path: "/remote/user" })),
    exportSyncItems: vi.fn(async ({ keys }: { keys: string[] }) => ({ items: keys })),
    importSyncItems: vi.fn(async ({ items }: { items: Array<{ key: string }> }) => ({
      results: items.map((entry) => ({ key: entry.key, status: "created" as const })),
    })),
  };
}

function createAccessor(
  overrides: Partial<Record<CategoryServiceKey, object>> = {},
): IServiceAccessor {
  return {
    skillSyncService: createService(),
    mcpSyncService: createService(),
    commandsService: createService(),
    hooksService: createService(),
    subagentsService: createService(),
    pluginSyncService: createService(),
    ...overrides,
  } as unknown as IServiceAccessor;
}

let unregisterTarget: (() => void) | undefined;

function mountSection(
  source: IServiceAccessor,
  target: IServiceAccessor,
  initialCategory?: DataSyncCategoryId,
) {
  hoisted.baseServices = source;
  unregisterTarget = registerSourceSettingsServices({
    sourceServerId: "source-a",
    attachmentId: "attachment-a",
    services: target,
    dispose: () => {},
  });
  return render(
    createElement(DataSyncSection, {
      devices: [{ sourceServerId: "source-a", name: "dev-a" }],
      ...(initialCategory ? { initialCategory } : {}),
    }),
  );
}

beforeEach(() => {
  hoisted.baseServices = undefined;
});

afterEach(() => {
  cleanup();
  unregisterTarget?.();
  unregisterTarget = undefined;
  vi.restoreAllMocks();
});

describe("data sync category comparison", () => {
  it("treats equal versions as synced and skips hash requests", () => {
    const sourceItems = [item({ key: "versioned", version: "1.0.0" })];
    const targetItems = [item({ key: "versioned", version: "1.0.0" })];
    expect(selectSkillHashRequests(sourceItems, targetItems)).toEqual({
      sourceKeys: [],
      targetKeys: [],
    });
    expect(
      compareSkillRows({ sourceItems, targetItems, sourceHashes: {}, targetHashes: {} })[0],
    ).toMatchObject({ category: "skills", status: "synced", selectable: false });
  });

  it("compares JSON items from list contentHash without extra hash requests", () => {
    const sourceItems = [item({ key: "same", contentHash: "h1" })];
    const targetItems = [item({ key: "same", contentHash: "h1" })];
    expect(selectSkillHashRequests(sourceItems, targetItems)).toEqual({
      sourceKeys: [],
      targetKeys: [],
    });
    expect(
      compareSkillRows({
        category: "hooks",
        sourceItems,
        targetItems,
        sourceHashes: {},
        targetHashes: {},
      })[0],
    ).toMatchObject({ category: "hooks", status: "synced", selectable: false });
  });
});

describe("useDataSyncCategory", () => {
  it("resolves the service for the selected category and swaps it on category change", async () => {
    const skills = createService({
      list: async () => listResult([item({ key: "skill-a", signature: { fileCount: 1, totalBytes: 1 } })]),
    });
    const mcp = createService({
      list: async () => listResult([item({ key: "mcp-a" })]),
    });
    const mcpTarget = createService({
      list: async () => listResult([item({ key: "mcp-a" })], { homeDir: "/remote/home" }),
    });
    const source = createAccessor({ skillSyncService: skills, mcpSyncService: mcp });
    const target = createAccessor({ mcpSyncService: mcpTarget });
    const { result, rerender } = renderHook(
      ({ category }: { category: DataSyncCategoryId }) =>
        useDataSyncCategory({
          category,
          sourceServices: source,
          targetServices: target,
          online: true,
        }),
      { initialProps: { category: "skills" } },
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.category).toBe("skills");
    expect(result.current.rows.map((row) => row.key)).toEqual(["skill-a"]);
    expect(skills.listSyncItems).toHaveBeenCalledTimes(1);
    expect(mcp.listSyncItems).not.toHaveBeenCalled();

    rerender({ category: "mcp" });
    await waitFor(() => expect(result.current.category).toBe("mcp"));
    await waitFor(() => expect(result.current.rows.map((row) => row.key)).toEqual(["mcp-a"]));
    expect(mcp.listSyncItems).toHaveBeenCalledTimes(1);
    expect(result.current.rows[0]?.category).toBe("mcp");
    // MCP 列表不带哈希：来源端按目标 home 改写后再计算，避免两端 home 不同被误判为差异。
    expect(mcp.getSyncContentHashes).toHaveBeenCalledWith({
      keys: ["mcp-a"],
      targetHomeDir: "/remote/home",
    });
  });

  it("fails closed while offline", async () => {
    const skills = createService();
    const source = createAccessor({ skillSyncService: skills });
    const target = createAccessor();
    const { result } = renderHook(() =>
      useDataSyncCategory({
        category: "skills",
        sourceServices: source,
        targetServices: target,
        online: false,
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("offline"));
    expect(result.current.rows).toEqual([]);
    expect(skills.listSyncItems).not.toHaveBeenCalled();
  });

  it("maps an outdated remote target to a stable error without reading or writing", async () => {
    const source = createAccessor();
    const targetService = createService({
      hashes: async () => {
        throw new Error("Method not found: getSyncContentHashes");
      },
    });
    const target = createAccessor({ skillSyncService: targetService });
    const { result } = renderHook(() =>
      useDataSyncCategory({
        category: "skills",
        sourceServices: source,
        targetServices: target,
        online: true,
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.errorCode).toBe(DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE);
    expect(targetService.getSyncContentHashes).toHaveBeenCalledTimes(1);
    expect(targetService.listSyncItems).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.push();
    });
    expect(targetService.exportSyncItems).not.toHaveBeenCalled();
    expect(targetService.importSyncItems).not.toHaveBeenCalled();

    // 重新加载不会再次探测：同一连接的能力结论已缓存。
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(targetService.getSyncContentHashes).toHaveBeenCalledTimes(1);
  });

  it("probes a supported remote target only once across reloads", async () => {
    const source = createAccessor();
    const targetService = createService();
    const target = createAccessor({ skillSyncService: targetService });
    const { result } = renderHook(() =>
      useDataSyncCategory({
        category: "skills",
        sourceServices: source,
        targetServices: target,
        online: true,
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(targetService.getSyncContentHashes).toHaveBeenCalledTimes(1);
    expect(targetService.getSyncContentHashes).toHaveBeenCalledWith({ keys: [] });

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(targetService.listSyncItems).toHaveBeenCalledTimes(2));
    expect(targetService.getSyncContentHashes).toHaveBeenCalledTimes(1);
  });

  it("aborts the remaining batches when import reports a missing method", async () => {
    const sourceService = createService({
      list: async () =>
        listResult([
          item({ key: "a", signature: { fileCount: 1, totalBytes: 15 * 1024 * 1024 } }),
          item({ key: "b", signature: { fileCount: 1, totalBytes: 15 * 1024 * 1024 } }),
        ]),
    });
    const targetService = createService({ list: async () => listResult([]) });
    targetService.importSyncItems.mockImplementation(async () => {
      throw new Error("Method not found: importSyncItems");
    });
    const source = createAccessor({ skillSyncService: sourceService });
    const target = createAccessor({ skillSyncService: targetService });
    const { result } = renderHook(() =>
      useDataSyncCategory({
        category: "skills",
        sourceServices: source,
        targetServices: target,
        online: true,
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.selectedCount).toBe(2);

    await act(async () => {
      await result.current.push();
    });
    // 第一批 import 就证明方法缺失：第二整批不再导出，避免半同步。
    expect(sourceService.exportSyncItems).toHaveBeenCalledTimes(1);
    expect(result.current.errorCode).toBe(DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE);
    expect(result.current.pushing).toBe(false);
  });
});

describe("DataSyncSection categories", () => {
  it("shows per-category counts in the overview and switches into a category", async () => {
    const skillsSource = createService({
      list: async () =>
        listResult([
          item({ key: "local-only" }),
          item({ key: "same", contentHash: "h1" }),
        ]),
    });
    const skillsTarget = createService({
      list: async () =>
        listResult([
          item({ key: "same", contentHash: "h1" }),
          item({ key: "remote-only" }),
        ]),
    });
    mountSection(
      createAccessor({ skillSyncService: skillsSource }),
      createAccessor({ skillSyncService: skillsTarget }),
    );

    const overviewRow = await screen.findByTestId("settings-data-sync-overview-row-skills");
    await waitFor(() =>
      expect(overviewRow.textContent).toContain("settings.dataSync.overview.local(count=2)"),
    );
    expect(overviewRow.textContent).toContain("settings.dataSync.overview.remote(count=2)");
    expect(overviewRow.textContent).toContain("settings.dataSync.overview.changed(count=1)");
    expect(screen.getByTestId("settings-data-sync-category-tab-skills").textContent).toContain(
      "settings.dataSync.category.pushable(count=1)",
    );

    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-skills"));
    expect(await screen.findByTestId("settings-data-sync-row-local-only")).toBeTruthy();
    expect(screen.getByTestId("settings-data-sync-row-remote-only")).toBeTruthy();
    expect(
      screen.getByText("settings.dataSync.category.selection.count(count=1)"),
    ).toBeTruthy();
  });

  it("lands on the category preselected by the settings entry", async () => {
    mountSection(createAccessor(), createAccessor(), "plugins");

    const tab = await screen.findByTestId("settings-data-sync-category-tab-plugins");
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByTestId("settings-data-sync-category-tab-overview").getAttribute("aria-selected"),
    ).toBe("false");
    expect(
      await screen.findByText(
        "settings.dataSync.category.empty(category=settings.dataSync.category.plugins)",
      ),
    ).toBeTruthy();
  });

  it("renders the outdated remote guidance in the category panel", async () => {
    const skillsTarget = createService({
      hashes: async () => {
        throw new Error("Method not found: getSyncContentHashes");
      },
    });
    mountSection(
      createAccessor(),
      createAccessor({ skillSyncService: skillsTarget }),
    );

    fireEvent.click(await screen.findByTestId("settings-data-sync-category-tab-skills"));
    expect(await screen.findByText("settings.dataSync.error.remoteAgentOutdatedTitle")).toBeTruthy();
    expect(screen.getByText("settings.dataSync.error.remoteAgentOutdated")).toBeTruthy();
    expect(skillsTarget.importSyncItems).not.toHaveBeenCalled();
  });

  it("blocks the whole MCP category when the target uses the compatibility config", async () => {
    const mcpSource = createService({
      list: async () => listResult([item({ key: "github", name: "github" })]),
    });
    const mcpTarget = createService({
      list: async () =>
        listResult([], { importBlockedReason: "target-compat-config" }),
    });
    mountSection(
      createAccessor({ mcpSyncService: mcpSource }),
      createAccessor({ mcpSyncService: mcpTarget }),
    );

    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-mcp"));
    const blocked = await screen.findByTestId("settings-data-sync-category-blocked");
    expect(blocked.textContent).toContain("settings.dataSync.category.blockedTitle");
    expect(blocked.textContent).toContain("settings.dataSync.blocked.targetCompatConfig");

    const checkbox = screen.getByRole("checkbox", { name: "github" });
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect((screen.getByTestId("settings-data-sync-push") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("clears the previous category selection when switching categories", async () => {
    const skillsSource = createService({
      list: async () => listResult([item({ key: "local-only" })]),
    });
    mountSection(createAccessor({ skillSyncService: skillsSource }), createAccessor());

    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-skills"));
    expect(
      await screen.findByText("settings.dataSync.category.selection.count(count=1)"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-mcp"));
    await screen.findByText("settings.dataSync.category.selection.none");
    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-skills"));
    await waitFor(() =>
      expect(
        screen.getByText("settings.dataSync.category.selection.none"),
      ).toBeTruthy(),
    );
  });

  it("shows subagent dependency hints without changing selection", async () => {
    const subagentsSource = createService({
      list: async () =>
        listResult([
          item({
            key: "planner",
            name: "Planner",
            signature: { fileCount: 1, totalBytes: 10 },
            contentHash: "h1",
            dependencies: { mcpServers: ["github", "filesystem"], skills: ["review"] },
          }),
        ]),
    });
    mountSection(
      createAccessor({ subagentsService: subagentsSource }),
      createAccessor(),
    );

    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-subagents"));
    const dependencies = await screen.findByTestId("settings-data-sync-dependencies-planner");
    expect(dependencies.textContent).toContain(
      "settings.dataSync.category.dependencies.mcp(names=github, filesystem)",
    );
    expect(dependencies.textContent).toContain(
      "settings.dataSync.category.dependencies.skills(names=review)",
    );
    const checkbox = screen.getByRole("checkbox", { name: "Planner" });
    expect(checkbox.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText("settings.dataSync.category.selection.count(count=1)"),
    ).toBeTruthy();
  });

  it("maps the plugins category to pluginSyncService and shows its counts", async () => {
    const pluginsSource = createService({
      list: async () =>
        listResult([
          item({ key: "local-only", signature: { fileCount: 2, totalBytes: 20 } }),
          item({ key: "same", contentHash: "h1" }),
        ]),
    });
    const pluginsTarget = createService({
      list: async () => listResult([item({ key: "same", contentHash: "h1" })]),
    });
    const source = createAccessor({ pluginSyncService: pluginsSource });
    const target = createAccessor({ pluginSyncService: pluginsTarget });
    mountSection(source, target);

    expect(resolveDataSyncCategoryService(source, "plugins")).toBe(pluginsSource);

    const tab = await screen.findByTestId("settings-data-sync-category-tab-plugins");
    expect(tab.textContent).toContain("settings.dataSync.category.plugins");
    expect(tab.textContent).toContain("settings.dataSync.category.pushable(count=1)");
    const overviewRow = screen.getByTestId("settings-data-sync-overview-row-plugins");
    expect(overviewRow.textContent).toContain("settings.dataSync.overview.local(count=2)");
    expect(overviewRow.textContent).toContain("settings.dataSync.overview.remote(count=1)");

    fireEvent.click(tab);
    expect(await screen.findByTestId("settings-data-sync-row-local-only")).toBeTruthy();
    expect(
      screen.getByText("settings.dataSync.category.selection.count(count=1)"),
    ).toBeTruthy();
  });

  it("没有设备时显示空态，并提供连接设备入口", () => {
    hoisted.baseServices = createAccessor();
    const onConnectDevice = vi.fn();
    render(
      createElement(DataSyncSection, {
        devices: [],
        onConnectDevice,
      }),
    );

    expect(screen.getByTestId("settings-data-sync-empty")).toBeTruthy();
    expect(screen.getByText("settings.dataSync.phase.noDevicesTitle")).toBeTruthy();
    expect(screen.getByText("settings.dataSync.phase.noDevices")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.dataSync.phase.connectDevice"));
    expect(onConnectDevice).toHaveBeenCalledTimes(1);
  });
});
