// @vitest-environment jsdom
// 说明：根 vitest.config.ts 的 unit project 只 include `*.test.ts`，现有 `.test.tsx` 不会被默认入口收集；
// 因此这里沿用同目录设置页测试的 `.ts + createElement` 写法，保证用例真正进入 CI。
import { createElement } from "react";
import {
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
  DataSyncSection,
  compareSkillRows,
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
  | "subagentsService";

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
    ...overrides,
  } as unknown as IServiceAccessor;
}

let unregisterTarget: (() => void) | undefined;

function mountSection(source: IServiceAccessor, target: IServiceAccessor) {
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
});
