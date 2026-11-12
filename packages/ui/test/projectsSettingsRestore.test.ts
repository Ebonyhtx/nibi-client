// @vitest-environment jsdom
// 恢复路径属于数据层契约：设置页必须复用 saveProject({ restoreProjectId, roots })，
// 而不是自己写删除标记；这里用展示层最小桩验证按钮真的走到同一个服务入口。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";

const h = vi.hoisted(() => {
  const service = { saveProject: vi.fn(), deleteProject: vi.fn() };
  const directory = {
    tree: { projects: [], tasks: [] } as ProjectTree,
    availability: new Map(),
    service,
    remoteService: undefined as unknown,
    refresh: vi.fn(async () => {}),
    loading: false,
    error: null as string | null,
    deviceNames: new Map<string, string>(),
    directory: { hosts: [], entries: [] },
  };
  return {
    service,
    directory,
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>): string =>
        values
          ? `${id}:${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`
          : id,
    },
  };
});

vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  ProjectDirectoryProvider: ({ children }: { children: unknown }) => children,
  useProjectDirectory: () => h.directory,
}));
vi.mock("@/project-sidebar/useProjectDataCleanupSupport.js", () => ({
  useProjectDataCleanupSupport: () => ({ supported: true, markUnsupported: vi.fn() }),
}));
vi.mock("@/project-sidebar/ProjectDataCleanupDialog.js", () => ({
  ProjectDataCleanupDialog: () => null,
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => h.confirm }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector({ workspaces: {} }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: h.toast }));
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => ({ intl: h.intl }) }));
vi.mock("@/settings/SettingsPageParts.js", () => ({
  SettingsGroupCard: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "settings-group-card" }, children),
}));
vi.mock("@/project-sidebar/RemoteHostSection.js", () => ({
  remoteHostLabel: (host: { id: string }) => host.id,
}));

import { ProjectsSection } from "@/settings/ProjectsSection.js";

function makeProject(overrides: Partial<VirtualProject> = {}): VirtualProject {
  return {
    id: "project-1",
    hostId: "local",
    name: "Alpha",
    nameOverridden: false,
    roots: [{ rootPath: "/work/alpha", position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.service.saveProject.mockResolvedValue(makeProject());
  h.directory.tree = {
    projects: [
      makeProject(),
      makeProject({
        id: "removed",
        name: "Beta",
        deleted: true,
        roots: [{ rootPath: "/work/beta", position: 0, isPrimary: true }],
        updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      }),
    ],
    tasks: [],
  };
});

afterEach(cleanup);

describe("ProjectsSection restore", () => {
  it("已移除项目的「恢复」调用 saveProject({ restoreProjectId, roots }) 并刷新目录", async () => {
    render(createElement(ProjectsSection));

    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(
      screen.getByText(
        "settings.projects.removedAgo:time=automations.time.ago:amount=automations.time.days:value=3",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("settings.projects.restore"));

    await waitFor(() =>
      expect(h.service.saveProject).toHaveBeenCalledWith({
        hostId: "local",
        restoreProjectId: "removed",
        roots: ["/work/beta"],
      }),
    );
    await waitFor(() => expect(h.directory.refresh).toHaveBeenCalled());
    expect(h.toast).toHaveBeenCalledWith("settings.projects.restoreSuccess:name=Beta");
  });

  it("恢复失败时显示可见错误", async () => {
    h.service.saveProject.mockRejectedValue(new Error("project.host-offline"));
    render(createElement(ProjectsSection));

    fireEvent.click(screen.getByText("settings.projects.restore"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "settings.projects.restoreFailed:name=Beta",
      ),
    );
    expect(h.directory.refresh).not.toHaveBeenCalled();
  });
});

describe("ProjectsSection selection and row actions", () => {
  it("勾选项目后才显示底部悬浮条，清除后隐藏", () => {
    render(createElement(ProjectsSection));

    expect(screen.queryByTestId("settings-projects-selection-bar")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-projects-row-checkbox"));

    const bar = screen.getByTestId("settings-projects-selection-bar");
    expect(bar.textContent).toContain("settings.projects.selectionSummary:selected=1,total=1");
    expect(screen.queryByTestId("settings-projects-remove")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-projects-selection-clear"));
    expect(screen.queryByTestId("settings-projects-selection-bar")).toBeNull();
  });

  it("行菜单只提供移除项，确认后移除该项目", async () => {
    render(createElement(ProjectsSection));

    fireEvent.keyDown(screen.getByTestId("settings-projects-row-menu"), { key: "ArrowDown" });
    const removeItem = await screen.findByTestId("settings-projects-remove-row");
    fireEvent.click(removeItem);

    await waitFor(() => expect(h.service.deleteProject).toHaveBeenCalledWith("project-1", "local"));
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.directory.refresh).toHaveBeenCalled();
  });
});
