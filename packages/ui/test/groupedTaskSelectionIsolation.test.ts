// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const renderedRows = vi.hoisted(() => [] as Array<{ taskId: string; active: boolean }>);

vi.mock("@/project-sidebar/grouped/task-item.js", async () => {
  const React = await import("react");
  return {
    GroupedTaskItem: React.memo(function MockGroupedTaskItem(props: {
      task: { taskId: string };
      active: boolean;
    }) {
      renderedRows.push({ taskId: props.task.taskId, active: props.active });
      return React.createElement("div", {
        "data-task-id": props.task.taskId,
        "data-active": String(props.active),
      });
    }),
  };
});

const { VirtualizedGroupedTaskList } = await import(
  "@/project-sidebar/grouped/virtualized-group-task-list.js"
);

const tasks = ["t1", "t2", "t3", "t4", "t5"].map((taskId) => ({
  taskId,
  workspacePath: "/workspace",
  title: taskId,
  updatedAt: 1,
})) as unknown as Parameters<typeof VirtualizedGroupedTaskList>[0]["tasks"];

const stableCallbacks = {
  getTaskRemoteSessionId: () => undefined,
  getTaskWorkspaceLabel: () => "workspace",
  onSelectTask: () => {},
  onCloseTask: () => {},
  onOpenFileTree: () => {},
  onMoveTaskToGroup: () => {},
  onMoveTaskToTop: () => {},
  onStartRenameTask: () => {},
  onArchiveTask: () => {},
  onMarkTaskAsUnread: () => {},
};

const emptyGroups: Parameters<typeof VirtualizedGroupedTaskList>[0]["groups"] = [];

function listElement(activeTaskId: string | null) {
  return createElement(VirtualizedGroupedTaskList, {
    tasks,
    groupId: "group-1",
    groups: emptyGroups,
    activeWorkspacePath: "/workspace",
    activeTaskId,
    ...stableCallbacks,
  });
}

afterEach(() => {
  renderedRows.length = 0;
});

describe("grouped task selection isolation", () => {
  it("选中切换只让旧/新两行拿到不同的 active，其余行不重渲染", () => {
    const view = render(listElement("t1"));
    expect(renderedRows.map((row) => row.taskId).sort()).toEqual(tasks.map((t) => t.taskId));
    expect(renderedRows.filter((row) => row.active).map((row) => row.taskId)).toEqual(["t1"]);

    renderedRows.length = 0;
    view.rerender(listElement("t2"));
    expect(renderedRows).toEqual([
      { taskId: "t1", active: false },
      { taskId: "t2", active: true },
    ]);

    // 同样的选中态再次渲染：所有行的 props 都不变，memo 全部跳过。
    renderedRows.length = 0;
    view.rerender(listElement("t2"));
    expect(renderedRows).toEqual([]);
  });
});
