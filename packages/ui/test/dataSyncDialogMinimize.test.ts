// @vitest-environment jsdom
// 说明：根 vitest.config.ts 的 unit project 只 include `*.test.ts`，沿用同目录的 `.ts + createElement` 写法。
import { createElement, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@nibi/services";
import type { DataSyncListItem, DataSyncListResult } from "@nibi/shared";
import {
  DATA_SYNC_CATEGORIES,
  DataSyncDialogProvider,
  DataSyncSettingsEntry,
  useDataSyncResultRefresh,
  useDataSyncResultVersion,
  useOpenDataSyncDialog,
  type DataSyncCategoryId,
} from "@/data-sync/index.js";
import { registerSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";

const hoisted = vi.hoisted(() => ({
  baseServices: undefined as IServiceAccessor | undefined,
  platform: null as { requestSourceSettingsAttachment: (id: string) => Promise<unknown> } | null,
  devices: [{ sourceServerId: "source-a", name: "dev-a" }],
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => hoisted.platform,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => hoisted.baseServices,
}));
vi.mock("@/data-sync/app/useDataSyncDevices.js", () => ({
  useDataSyncDevices: () => ({ devices: hoisted.devices, remoteUserAvailable: true }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
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

function listResult(items: DataSyncListItem[]): DataSyncListResult {
  return { items, homeDir: "/home/test" };
}

function createService(
  options: {
    list?: () => Promise<DataSyncListResult>;
    import?: (params: {
      items: Array<{ key: string }>;
    }) => Promise<{ results: Array<{ key: string; status: string; error?: string }> }>;
  } = {},
) {
  return {
    listSyncItems: vi.fn(options.list ?? (async () => listResult([]))),
    getSyncContentHashes: vi.fn(async () => ({ hashes: {} })),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let unregisterTarget: (() => void) | undefined;

/** 已注册 attachment 的渲染环境：provider 打开后分类直接进入 ready。 */
function mountWithTarget(source: IServiceAccessor, target: IServiceAccessor, children: ReactNode) {
  hoisted.baseServices = source;
  unregisterTarget = registerSourceSettingsServices({
    sourceServerId: "source-a",
    attachmentId: "attachment-a",
    services: target,
    dispose: () => {},
  });
  return render(createElement(DataSyncDialogProvider, null, children));
}

function OpenSyncButton({ category }: { category?: DataSyncCategoryId }) {
  const open = useOpenDataSyncDialog();
  return createElement(
    "button",
    {
      type: "button",
      "data-testid": category ? `open-sync-${category}` : "open-sync",
      onClick: () => open?.(category ? { category } : {}),
    },
    category ?? "open",
  );
}

function VersionProbe() {
  const version = useDataSyncResultVersion();
  return createElement("span", { "data-testid": "result-version" }, String(version));
}

function RefreshProbe() {
  const [refreshes, setRefreshes] = useState(0);
  useDataSyncResultRefresh(() => setRefreshes((count) => count + 1));
  return createElement("span", { "data-testid": "refresh-count" }, String(refreshes));
}

async function openCategory(category: DataSyncCategoryId) {
  fireEvent.click(screen.getByTestId(`open-sync-${category}`));
  await screen.findByTestId("data-sync-dialog");
  return screen.findByTestId(`settings-data-sync-category-tab-${category}`);
}

beforeEach(() => {
  hoisted.baseServices = undefined;
  hoisted.platform = {
    requestSourceSettingsAttachment: vi.fn(async () => ({ attachmentId: "attachment-a" })),
  };
});

afterEach(() => {
  cleanup();
  unregisterTarget?.();
  unregisterTarget = undefined;
  vi.restoreAllMocks();
});

describe("data sync dialog provider", () => {
  it("opens, minimizes and restores the same single dialog without replacing its request", async () => {
    const source = createAccessor();
    const target = createAccessor();
    mountWithTarget(
      source,
      target,
      createElement(
        "div",
        null,
        createElement(VersionProbe),
        createElement(OpenSyncButton, { category: "skills" }),
        createElement(OpenSyncButton, { category: "mcp" }),
      ),
    );

    const skillsTab = await openCategory("skills");
    expect(skillsTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByTestId("data-sync-minimize"));
    expect(screen.queryByTestId("data-sync-dialog")).toBeNull();
    const bar = screen.getByTestId("data-sync-minimized-progress");
    expect(bar.textContent).toContain("settings.dataSync.minimized.restore");

    // 最小化期间另一个入口只恢复现有实例，不替换成 mcp。
    fireEvent.click(screen.getByTestId("open-sync-mcp"));
    await screen.findByTestId("data-sync-dialog");
    expect(
      screen.getByTestId("settings-data-sync-category-tab-skills").getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("data-sync-minimize"));
    fireEvent.click(screen.getByTestId("data-sync-minimized-progress"));
    await screen.findByTestId("data-sync-dialog");
    expect(
      screen.getByTestId("settings-data-sync-category-tab-skills").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps an in-flight push running while minimized and restores its result", async () => {
    const pending = deferred<{ results: Array<{ key: string; status: string }> }>();
    const skillsSource = createService({
      list: async () => listResult([item({ key: "skill-a" })]),
    });
    const skillsTarget = createService({ import: () => pending.promise });
    const source = createAccessor({ skillSyncService: skillsSource });
    const target = createAccessor({ skillSyncService: skillsTarget });
    mountWithTarget(
      source,
      target,
      createElement(
        "div",
        null,
        createElement(VersionProbe),
        createElement(RefreshProbe),
        createElement(OpenSyncButton, { category: "skills" }),
      ),
    );

    await openCategory("skills");
    await waitFor(() =>
      expect((screen.getByTestId("settings-data-sync-push") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId("settings-data-sync-push"));
    await waitFor(() => expect(skillsTarget.importSyncItems).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("data-sync-minimize"));
    const bar = screen.getByTestId("data-sync-minimized-progress");
    expect(bar.textContent).toContain("settings.dataSync.minimized.pushing");
    expect(bar.textContent).toContain("settings.dataSync.category.skills");
    expect(screen.queryByTestId("data-sync-dialog")).toBeNull();

    act(() => pending.resolve({ results: [{ key: "skill-a", status: "created" }] }));
    await waitFor(() =>
      expect(screen.getByTestId("data-sync-minimized-progress").textContent).toContain(
        "settings.dataSync.minimized.finished",
      ),
    );
    expect(screen.getByTestId("result-version").textContent).toBe("1");
    await waitFor(() => expect(screen.getByTestId("refresh-count").textContent).toBe("1"));
    expect(screen.getByTestId("data-sync-minimized-progress").textContent).toContain(
      "settings.dataSync.push.summary(succeeded=1,failed=0,skipped=0)",
    );

    fireEvent.click(screen.getByTestId("data-sync-minimized-progress"));
    await screen.findByTestId("data-sync-dialog");
    expect(
      screen.getByText("settings.dataSync.push.summary(succeeded=1,failed=0,skipped=0)"),
    ).toBeTruthy();
  });

  it("shows the failed state on the minimized bar", async () => {
    const pending = deferred<{
      results: Array<{ key: string; status: string; error?: string }>;
    }>();
    const skillsSource = createService({
      list: async () => listResult([item({ key: "skill-a" })]),
    });
    const skillsTarget = createService({ import: () => pending.promise });
    mountWithTarget(
      createAccessor({ skillSyncService: skillsSource }),
      createAccessor({ skillSyncService: skillsTarget }),
      createElement(
        "div",
        null,
        createElement(VersionProbe),
        createElement(OpenSyncButton, { category: "skills" }),
      ),
    );

    await openCategory("skills");
    await waitFor(() =>
      expect((screen.getByTestId("settings-data-sync-push") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId("settings-data-sync-push"));
    await waitFor(() => expect(skillsTarget.importSyncItems).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("data-sync-minimize"));

    act(() =>
      pending.resolve({
        results: [{ key: "skill-a", status: "failed", error: "disk full" }],
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("data-sync-minimized-progress").textContent).toContain(
        "settings.dataSync.minimized.failed",
      ),
    );
    expect(screen.getByTestId("result-version").textContent).toBe("1");
  });

  it("does not attach source settings or read categories before the user opens sync", async () => {
    const sourceSkills = createService();
    hoisted.baseServices = createAccessor({ skillSyncService: sourceSkills });
    const request = vi.fn(async () => ({ attachmentId: "attachment-a" }));
    hoisted.platform = { requestSourceSettingsAttachment: request };
    render(
      createElement(
        DataSyncDialogProvider,
        null,
        createElement(VersionProbe),
        createElement(OpenSyncButton, { category: "skills" }),
      ),
    );

    expect(request).not.toHaveBeenCalled();
    expect(sourceSkills.listSyncItems).not.toHaveBeenCalled();
    expect(screen.queryByTestId("data-sync-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("open-sync-skills"));
    await screen.findByTestId("data-sync-dialog");
    await waitFor(() => expect(request).toHaveBeenCalledWith("source-a"));
  });

  it("opens the window-level dialog from the settings entry", async () => {
    mountWithTarget(
      createAccessor(),
      createAccessor(),
      createElement(DataSyncSettingsEntry, {
        devices: [{ sourceServerId: "source-a", name: "dev-a" }],
      }),
    );

    fireEvent.click(screen.getByTestId("settings-data-sync-entry-open"));
    await screen.findByTestId("data-sync-dialog");
    expect(screen.getByTestId("settings-data-sync")).toBeTruthy();
  });

  it("keeps the dialog session mounted when the settings entry unmounts", async () => {
    const view = mountWithTarget(
      createAccessor(),
      createAccessor(),
      createElement(DataSyncSettingsEntry, {
        devices: [{ sourceServerId: "source-a", name: "dev-a" }],
      }),
    );
    fireEvent.click(screen.getByTestId("settings-data-sync-entry-open"));
    await screen.findByTestId("data-sync-dialog");

    // 离开设置页只卸载入口；provider 仍在窗口根部，弹窗和 session 不能随之消失。
    view.rerender(
      createElement(
        DataSyncDialogProvider,
        null,
        createElement("div", { "data-testid": "other-settings-page" }),
      ),
    );
    expect(screen.getByTestId("data-sync-dialog")).toBeTruthy();
    expect(screen.getByTestId("settings-data-sync")).toBeTruthy();
  });

  it("increments the result version once after a push-all completes", async () => {
    const sourceOverrides: Partial<Record<CategoryServiceKey, object>> = {};
    for (const category of DATA_SYNC_CATEGORIES) {
      sourceOverrides[serviceKey(category)] = createService({
        list: async () => listResult([item({ key: `${category}-a` })]),
      });
    }
    mountWithTarget(
      createAccessor(sourceOverrides),
      createAccessor(),
      createElement("div", null, createElement(VersionProbe), createElement(OpenSyncButton)),
    );

    fireEvent.click(screen.getByTestId("open-sync"));
    await screen.findByTestId("data-sync-dialog");
    await waitFor(() => {
      for (const category of DATA_SYNC_CATEGORIES) {
        expect(
          screen.getByTestId(`settings-data-sync-overview-row-${category}`).textContent,
        ).toContain("settings.dataSync.overview.changed(count=1)");
      }
    });
    fireEvent.click(screen.getByTestId("settings-data-sync-overview-select-all"));
    fireEvent.click(screen.getByTestId("settings-data-sync-push-all"));
    await screen.findByTestId("settings-data-sync-push-all-summary");
    expect(screen.getByTestId("result-version").textContent).toBe("1");
  });
});

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
