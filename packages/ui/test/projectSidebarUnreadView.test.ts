// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";
import { ProjectSidebarListHeader } from "@/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import { readProjectSidebarView } from "@/project-sidebar/view-preference.js";
import { countProjectTreeUnreadTasks, selectProjectRows } from "@/project-sidebar/view.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const mocks = vi.hoisted(() => ({
  rowProps: [] as Array<Record<string, unknown>>,
  state: { workspaces: {} as Record<string, { activeTaskId?: string }> },
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ windowControllerService: {}, zcodeTaskService: {} }),
}));
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => null,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: (state: typeof mocks.state) => unknown) => select(mocks.state),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: { openSettingsTab(): void }) => unknown) =>
    select({ openSettingsTab: vi.fn() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/TaskListItem.js", () => ({
  MemoTaskItem: (props: { task: { title: string } }) => {
    mocks.rowProps.push(props);
    return createElement("li", { "data-testid": "row" }, props.task.title);
  },
  TaskListItemContextMenuContent: () => null,
}));
vi.mock("@/NewTaskButtonGroup.js", () => ({ NewTaskButtonGroup: () => null }));
vi.mock("@/TaskRenameDialog.js", () => ({ TaskRenameDialog: () => null }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  title: id,
  traceId: id,
  workspacePath: "/one",
  hostId: "local",
  projectId: "p1",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  mode: "default",
  unreadAt: 100,
  ...extra,
});
const project = (id: string, hostId = "local", deleted = false): VirtualProject => ({
  id,
  hostId,
  name: id,
  roots: [],
  position: 0,
  pinned: false,
  deleted,
  nameOverridden: false,
  createdAt: 1,
  updatedAt: 1,
});
const refresh = vi.fn(async () => {});
const storage = (current: unknown, legacy: unknown = null) => ({
  getItem: (key: string) =>
    JSON.stringify(key === "nibi-project-sidebar-preferences" ? current : legacy),
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.rowProps.length = 0;
});

describe("按未读视图", () => {
  it("偏好接受 unread，非法值回落 projects，旧 organizeBy 迁移不变", () => {
    expect(readProjectSidebarView(storage({ view: "unread" }, { organizeBy: "grouped" }))).toBe(
      "unread",
    );
    expect(readProjectSidebarView(storage({ view: "invalid" }))).toBe("projects");
    expect(readProjectSidebarView(storage({ view: "timeline" }, { organizeBy: "grouped" }))).toBe(
      "timeline",
    );
    expect(readProjectSidebarView(storage(null, { organizeBy: "grouped" }))).toBe("grouped");
    expect(readProjectSidebarView(storage(null, { organizeBy: "chronological" }))).toBe("timeline");
  });

  it("视图菜单在最近更新之后提供 Bell 未读项并回传 unread", async () => {
    const onViewChange = vi.fn();
    render(
      createElement(
        TooltipProvider,
        {},
        createElement(ProjectSidebarListHeader, {
          onOpenCommandCenter: vi.fn(),
          view: "timeline",
          onViewChange,
        }),
      ),
    );
    fireEvent.keyDown(screen.getByTestId("sidebar-view-menu"), { key: "ArrowDown" });
    const choices = await screen.findAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.getAttribute("data-testid"))).toEqual([
      "sidebar-view-projects",
      "sidebar-view-grouped",
      "sidebar-view-timeline",
      "sidebar-view-unread",
    ]);
    expect(screen.getByTestId("sidebar-view-unread").textContent).toContain("project.viewUnread");
    expect(screen.getByTestId("sidebar-view-unread").querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-view-unread"));
    expect(onViewChange).toHaveBeenCalledWith("unread");
  });

  it("只保留可见的未读任务：含跨项目置顶与本地未归类，排除归档/已删项目并去重", () => {
    const tree: ProjectTree = {
      projects: [
        project("p1"),
        project("gone", "local", true),
        project("remote-p", "remote:server"),
      ],
      tasks: [
        task("active", { unreadAt: 300, updatedAt: 30 }),
        task("read", { unreadAt: undefined, updatedAt: 40 }),
        task("archived", { archived: true, unreadAt: 500, updatedAt: 50 }),
        task("pinned-deleted", { pinned: true, projectId: "gone", unreadAt: 400, updatedAt: 20 }),
        task("local-unclassified", { projectId: null, unreadAt: 200, updatedAt: 10 }),
        task("remote-unclassified", {
          projectId: null,
          hostId: "remote:server",
          unreadAt: 600,
          updatedAt: 60,
        }),
        task("orphan", { projectId: "ghost", unreadAt: 700, updatedAt: 70 }),
        task("deleted-project", { projectId: "gone", unreadAt: 800, updatedAt: 80 }),
        task("active", {
          hostId: "remote:server",
          projectId: "remote-p",
          unreadAt: 250,
          updatedAt: 25,
        }),
        // 同一 host + workspace + taskId 的重复行只保留一次。
        task("active", { unreadAt: 999, updatedAt: 1 }),
      ],
    };
    const rows = selectProjectRows(tree, { kind: "unread" });
    expect(rows.map((row) => `${row.hostId}:${row.taskId}`)).toEqual([
      "local:active",
      "remote:server:active",
      "local:pinned-deleted",
      "local:local-unclassified",
    ]);
    // 角标与列表共用选择器：数量必须等于去重后的可见行数。
    expect(countProjectTreeUnreadTasks(tree)).toBe(rows.length);
  });

  it("按 lastActivityAt（updatedAt）倒序，置顶与运行层都不重排", () => {
    const running = attachTaskListRowActivity(task("running", { updatedAt: 1 }), {
      phase: "running",
      lastActivityAt: 999,
      hasBackgroundWork: false,
    });
    const tree: ProjectTree = {
      projects: [project("p1")],
      tasks: [
        running,
        task("pinned", { pinned: true, updatedAt: 5 }),
        task("newest", { updatedAt: 30 }),
        task("middle", { updatedAt: 20 }),
      ],
    };
    expect(selectProjectRows(tree, { kind: "unread" }).map((row) => row.taskId)).toEqual([
      "newest",
      "middle",
      "pinned",
      "running",
    ]);
    // 刷新只推进某个任务的 CLI 更新时间，顺序跟着时间走，不按 unreadAt 重排。
    const refreshed: ProjectTree = {
      ...tree,
      tasks: tree.tasks.map((row) =>
        row.taskId === "pinned" ? { ...row, updatedAt: 40, unreadAt: 999 } : row,
      ),
    };
    expect(selectProjectRows(refreshed, { kind: "unread" }).map((row) => row.taskId)).toEqual([
      "pinned",
      "newest",
      "middle",
      "running",
    ]);
  });

  it("空态显示暂无未读任务，列表沿用 20/+20 分页与日期标题", () => {
    const props = { tasks: [] as ProjectTask[], kind: "unread" as const, onSelect: vi.fn(), refresh };
    const { rerender } = render(createElement(ProjectTaskRows, props));
    expect(screen.getByTestId("project-no-unread-tasks").textContent).toBe(
      "taskList.noUnreadTasks",
    );
    const tasks = Array.from({ length: 25 }, (_, index) =>
      task(`item-${index}`, { updatedAt: 1_000 + index }),
    );
    rerender(createElement(ProjectTaskRows, { ...props, tasks }));
    expect(screen.getAllByTestId("row")).toHaveLength(20);
    expect(screen.getAllByTestId("row")[0]?.textContent).toContain("item-24");
    expect(screen.getByTestId("project-unread-tasks").querySelector("[data-timeline-date-heading]"))
      .not.toBeNull();
    fireEvent.click(screen.getByText("taskList.showMore"));
    expect(screen.getAllByTestId("row")).toHaveLength(25);
  });

  it("切换视图持久化 unread 且保留项目折叠状态", () => {
    const projects = [project("p1"), project("p2", "remote:server")];
    const { result, unmount } = renderHook(() => useProjectSidebarPreferences(projects, false));
    act(() => result.current.setExpanded(projects[0]!, false));
    act(() => result.current.setView("unread"));
    expect(result.current.view).toBe("unread");
    expect(result.current.isExpanded(projects[0]!)).toBe(false);
    expect(result.current.isExpanded(projects[1]!)).toBe(true);
    act(() => result.current.setView("timeline"));
    expect(result.current.isExpanded(projects[0]!)).toBe(false);
    act(() => result.current.setView("unread"));
    unmount();
    const restored = renderHook(() => useProjectSidebarPreferences(projects, false)).result;
    expect(restored.current.view).toBe("unread");
    expect(restored.current.isExpanded(projects[0]!)).toBe(false);
  });
});