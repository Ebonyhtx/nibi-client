// @vitest-environment jsdom
// 说明：根 vitest.config.ts 的 unit project 只 include `*.test.ts`，沿用 `.ts + createElement` 写法。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@nibi/services";
import type { DataSyncListItem, DataSyncListResult } from "@nibi/shared";
import {
  DATA_SYNC_CATEGORIES,
  DATA_SYNC_PUSH_ALL_CONCURRENCY,
  DataSyncSection,
  runDataSyncCategoryPushQueue,
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
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>): string =>
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

function createService(
  options: {
    list?: () => Promise<DataSyncListResult>;
    hashes?: (params: {
      keys: string[];
      targetHomeDir?: string;
    }) => Promise<{ hashes: Record<string, string> }>;
    import?: (params: {
      payload: unknown;
      items: Array<{ key: string; mode: string }>;
    }) => Promise<{
      results: Array<{ key: string; status: string; error?: string }>;
    }>;
  } = {},
) {
  return {
    listSyncItems: vi.fn(options.list ?? (async () => listResult([]))),
    getSyncContentHashes: vi.fn(options.hashes ?? (async () => ({ hashes: {} }))),
    checkSyncWriteAccess: vi.fn(async () => ({ ok: true, path: "/remote/user" })),
    exportSyncItems: vi.fn(async ({ keys }: { keys: string[] }) => ({ items: keys })),
    importSyncItems: vi.fn(
      options.import ??
        (async ({ items }: { items: Array<{ key: string }> }) => ({
          results: items.map((entry) => ({ key: entry.key, status: "created" as const })),
        })),
    ),
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

function serviceKey(category: DataSyncCategoryId): CategoryServiceKey {
  switch (category) {
    case "skills":
      return "skillSyncService";
    case "mcp":
      return "mcpSyncService";
    case "commands":
      return "commandsService";
    case "hooks":
      return "hooksService";
    case "subagents":
      return "subagentsService";
    case "plugins":
      return "pluginSyncService";
  }
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

function targetService(target: IServiceAccessor, category: DataSyncCategoryId) {
  return target[serviceKey(category)] as unknown as ReturnType<typeof createService>;
}

/** 所有分类都等待概览行显示「1 项待推送」，避免全选早于分类加载完成。 */
async function waitForAllCategoriesPushable() {
  await waitFor(() => {
    for (const category of DATA_SYNC_CATEGORIES) {
      expect(
        screen.getByTestId(`settings-data-sync-overview-row-${category}`).textContent,
      ).toContain("settings.dataSync.overview.changed(count=1)");
    }
    return true;
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hoisted.baseServices = undefined;
});

afterEach(() => {
  cleanup();
  unregisterTarget?.();
  unregisterTarget = undefined;
  vi.restoreAllMocks();
});

describe("runDataSyncCategoryPushQueue", () => {
  it("dispatches in category order with at most two categories in flight", async () => {
    const started: DataSyncCategoryId[] = [];
    const releases = new Map<DataSyncCategoryId, () => void>();
    let active = 0;
    let maxActive = 0;

    const promise = runDataSyncCategoryPushQueue({
      categories: DATA_SYNC_CATEGORIES,
      concurrency: DATA_SYNC_PUSH_ALL_CONCURRENCY,
      run: (category) => {
        started.push(category);
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<DataSyncCategoryId>((resolve) => {
          releases.set(category, () => {
            active -= 1;
            resolve(category);
          });
        });
      },
    });

    await flush();
    expect(started).toEqual(["skills", "mcp"]);

    releases.get("mcp")!();
    await flush();
    expect(started).toEqual(["skills", "mcp", "commands"]);

    releases.get("skills")!();
    await flush();
    expect(started).toEqual(["skills", "mcp", "commands", "hooks"]);

    for (const category of ["commands", "hooks", "subagents", "plugins"] as const) {
      releases.get(category)!();
      await flush();
    }

    expect(await promise).toEqual([...DATA_SYNC_CATEGORIES]);
    expect(maxActive).toBe(DATA_SYNC_PUSH_ALL_CONCURRENCY);
  });
});

describe("data sync overview push all", () => {
  it("selects all categories and pushes every selected item in category order", async () => {
    const sourceOverrides: Partial<Record<CategoryServiceKey, object>> = {};
    const targetOverrides: Partial<Record<CategoryServiceKey, object>> = {};
    for (const category of DATA_SYNC_CATEGORIES) {
      // 远端版本较新：行可选但不默认勾选，正好验证概览的跨分类全选。
      sourceOverrides[serviceKey(category)] = createService({
        list: async () => listResult([item({ key: `${category}-a`, version: "1.0.0" })]),
      });
      targetOverrides[serviceKey(category)] = createService({
        list: async () => listResult([item({ key: `${category}-a`, version: "2.0.0" })]),
      });
    }
    const target = createAccessor(targetOverrides);
    mountSection(createAccessor(sourceOverrides), target);

    await waitForAllCategoriesPushable();
    expect(screen.getByText("settings.dataSync.overview.selection.none")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    expect(screen.getByText("settings.dataSync.overview.selection.count(count=6)")).toBeTruthy();

    // 选择必须传播到分类页，并且回到概览后仍然保留。
    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-skills"));
    expect(
      await screen.findByText("settings.dataSync.category.selection.count(count=1)"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-data-sync-category-tab-overview"));
    expect(screen.getByText("settings.dataSync.overview.selection.count(count=6)")).toBeTruthy();

    // 取消全选会清空六类选择，推送全部随之禁用。
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-clear-selection"));
    expect(screen.getByText("settings.dataSync.overview.selection.none")).toBeTruthy();
    expect((screen.getByTestId("settings-data-sync-push-all") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    expect(screen.getByText("settings.dataSync.overview.selection.count(count=6)")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-data-sync-push-all"));
    await screen.findByTestId("settings-data-sync-push-all-summary");

    for (const category of DATA_SYNC_CATEGORIES) {
      expect(targetService(target, category).importSyncItems).toHaveBeenCalledTimes(1);
      expect(targetService(target, category).importSyncItems.mock.calls[0]?.[0].items).toEqual([
        { key: `${category}-a`, mode: "overwrite" },
      ]);
    }
    expect(screen.getByTestId("settings-data-sync-push-all-summary").textContent).toContain(
      "settings.dataSync.overview.pushSummary(succeeded=6,failed=0,skipped=0)",
    );
  });

  it("continues other categories and summarizes per-category partial failures", async () => {
    const skillsSource = createService({
      list: async () => listResult([item({ key: "a" }), item({ key: "b" })]),
    });
    const skillsTarget = createService({
      list: async () => listResult([]),
      import: async ({ items }) => ({
        results: items.map((entry) =>
          entry.key === "b"
            ? { key: entry.key, status: "failed", error: "disk full" }
            : { key: entry.key, status: "created" },
        ),
      }),
    });
    const mcpSource = createService({
      list: async () => listResult([item({ key: "m" })]),
    });
    const commandsSource = createService({
      list: async () => listResult([item({ key: "c" })]),
    });
    const commandsTarget = createService({
      list: async () => listResult([]),
      import: async () => {
        throw new Error("write failed");
      },
    });
    const pluginsSource = createService({
      list: async () => listResult([item({ key: "p" })]),
    });
    const target = createAccessor({
      skillSyncService: skillsTarget,
      commandsService: commandsTarget,
    });
    mountSection(
      createAccessor({
        skillSyncService: skillsSource,
        mcpSyncService: mcpSource,
        commandsService: commandsSource,
        pluginSyncService: pluginsSource,
      }),
      target,
    );

    await waitFor(() => {
      expect(screen.getByTestId("settings-data-sync-overview-row-skills").textContent).toContain(
        "settings.dataSync.overview.changed(count=2)",
      );
      expect(screen.getByTestId("settings-data-sync-overview-row-mcp").textContent).toContain(
        "settings.dataSync.overview.changed(count=1)",
      );
    });
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    fireEvent.click(screen.getByTestId("settings-data-sync-push-all"));

    const summary = await screen.findByTestId("settings-data-sync-push-all-summary");
    await waitFor(() =>
      expect(summary.textContent).toContain(
        "settings.dataSync.overview.pushSummary(succeeded=3,failed=2,skipped=0)",
      ),
    );

    const skillsFailure = screen.getByTestId("settings-data-sync-push-all-failure-skills");
    expect(skillsFailure.textContent).toContain("settings.dataSync.category.skills");
    expect(skillsFailure.textContent).toContain("b: settings.dataSync.result.failed — disk full");

    const commandsFailure = screen.getByTestId("settings-data-sync-push-all-failure-commands");
    expect(commandsFailure.textContent).toContain("settings.dataSync.category.commands");
    expect(commandsFailure.textContent).toContain(
      "c: settings.dataSync.result.failed — write failed",
    );

    // 命令分类抛错没有中断队列：后面的插件仍然被推送。
    expect(targetService(target, "skills").importSyncItems).toHaveBeenCalledTimes(1);
    expect(targetService(target, "mcp").importSyncItems).toHaveBeenCalledTimes(1);
    expect(targetService(target, "commands").importSyncItems).toHaveBeenCalledTimes(1);
    expect(targetService(target, "plugins").importSyncItems).toHaveBeenCalledTimes(1);
  });

  it("records a push-time capability gate error without aborting other categories", async () => {
    const skillsSource = createService({
      list: async () => listResult([item({ key: "s" })]),
    });
    const mcpSource = createService({
      list: async () => listResult([item({ key: "m" })]),
    });
    const mcpTarget = createService({
      list: async () => listResult([]),
      import: async () => {
        throw new Error("Method not found: importSyncItems");
      },
    });
    const target = createAccessor({ mcpSyncService: mcpTarget });
    mountSection(
      createAccessor({ skillSyncService: skillsSource, mcpSyncService: mcpSource }),
      target,
    );

    await waitFor(() => {
      expect(screen.getByTestId("settings-data-sync-overview-row-skills").textContent).toContain(
        "settings.dataSync.overview.changed(count=1)",
      );
      expect(screen.getByTestId("settings-data-sync-overview-row-mcp").textContent).toContain(
        "settings.dataSync.overview.changed(count=1)",
      );
    });
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    fireEvent.click(screen.getByTestId("settings-data-sync-push-all"));

    const summary = await screen.findByTestId("settings-data-sync-push-all-summary");
    await waitFor(() =>
      expect(summary.textContent).toContain(
        "settings.dataSync.overview.pushSummary(succeeded=1,failed=1,skipped=0)",
      ),
    );

    const mcpFailure = screen.getByTestId("settings-data-sync-push-all-failure-mcp");
    expect(mcpFailure.textContent).toContain("settings.dataSync.category.mcp");
    expect(mcpFailure.textContent).toContain("settings.dataSync.error.remoteAgentOutdated");

    // 门禁错误只发生一次：本次「推送全部」不会对该分类自动重试。
    expect(mcpTarget.importSyncItems).toHaveBeenCalledTimes(1);
    expect(targetService(target, "skills").importSyncItems).toHaveBeenCalledTimes(1);
  });

  it("records a load-time unverified capability category as a failure", async () => {
    const skillsSource = createService({
      list: async () => listResult([item({ key: "s" })]),
    });
    const mcpTarget = createService({
      hashes: async () => {
        throw new Error("socket closed");
      },
    });
    const target = createAccessor({ mcpSyncService: mcpTarget });
    mountSection(createAccessor({ skillSyncService: skillsSource }), target);

    await waitFor(() => {
      expect(screen.getByTestId("settings-data-sync-overview-row-skills").textContent).toContain(
        "settings.dataSync.overview.changed(count=1)",
      );
      expect(screen.getByTestId("settings-data-sync-overview-row-mcp").textContent).toContain(
        "settings.dataSync.overview.error",
      );
    });
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    fireEvent.click(screen.getByTestId("settings-data-sync-push-all"));

    const summary = await screen.findByTestId("settings-data-sync-push-all-summary");
    expect(summary.textContent).toContain(
      "settings.dataSync.overview.pushSummary(succeeded=1,failed=0,skipped=0)",
    );
    const mcpFailure = screen.getByTestId("settings-data-sync-push-all-failure-mcp");
    expect(mcpFailure.textContent).toContain(
      "settings.dataSync.error.remoteAgentCapabilityUnverified",
    );
    // 能力无法确认时既不 list 也不 import，绝不写入。
    expect(mcpTarget.listSyncItems).not.toHaveBeenCalled();
    expect(mcpTarget.importSyncItems).not.toHaveBeenCalled();
  });

  it("does not push items that already succeeded when pushing all again", async () => {
    const skillsSource = createService({
      list: async () => listResult([item({ key: "a" }), item({ key: "b" })]),
    });
    let importCalls = 0;
    const skillsTarget = createService({
      list: async () => listResult([]),
      import: async ({ items }) => {
        importCalls += 1;
        return {
          results: items.map((entry) =>
            importCalls === 1 && entry.key === "b"
              ? { key: entry.key, status: "failed", error: "flaky" }
              : { key: entry.key, status: "created" },
          ),
        };
      },
    });
    mountSection(
      createAccessor({ skillSyncService: skillsSource }),
      createAccessor({ skillSyncService: skillsTarget }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("settings-data-sync-overview-row-skills").textContent).toContain(
        "settings.dataSync.overview.changed(count=2)",
      ),
    );
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    fireEvent.click(screen.getByTestId("settings-data-sync-push-all"));

    const summary = await screen.findByTestId("settings-data-sync-push-all-summary");
    await waitFor(() =>
      expect(summary.textContent).toContain(
        "settings.dataSync.overview.pushSummary(succeeded=1,failed=1,skipped=0)",
      ),
    );

    // 第二次推送全部只带上次失败项；已成功项在分类 hook 里已不可选。
    const pushAllButton = screen.getByTestId("settings-data-sync-push-all") as HTMLButtonElement;
    expect(pushAllButton.disabled).toBe(false);
    fireEvent.click(pushAllButton);
    await waitFor(() => expect(skillsTarget.importSyncItems).toHaveBeenCalledTimes(2));
    expect(skillsTarget.importSyncItems.mock.calls[1]?.[0].items).toEqual([
      { key: "b", mode: "createOnly" },
    ]);
    // 第二次推送开始时旧汇总会被清空并重建，必须重新查询节点。
    await waitFor(() =>
      expect(screen.getByTestId("settings-data-sync-push-all-summary").textContent).toContain(
        "settings.dataSync.overview.pushSummary(succeeded=1,failed=0,skipped=0)",
      ),
    );
    expect((screen.getByTestId("settings-data-sync-push-all") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
