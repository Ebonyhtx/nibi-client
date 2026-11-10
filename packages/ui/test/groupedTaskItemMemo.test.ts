// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rowRenders = vi.hoisted(() => [] as Array<{ taskId: string; active: boolean }>);

vi.mock("@/project-sidebar/grouped/task-row.js", async () => {
  const React = await import("react");
  return {
    GroupedTaskRow: (props: { task: { taskId: string }; active: boolean }) => {
      rowRenders.push({ taskId: props.task.taskId, active: props.active });
      return React.createElement("div", null, props.task.taskId);
    },
  };
});

const { GroupedTaskItem } = await import("@/project-sidebar/grouped/task-item.js");

const task = {
  taskId: "t1",
  workspacePath: "/workspace",
  title: "Task",
  updatedAt: 1,
} as unknown as Parameters<typeof GroupedTaskItem>[0]["task"];

const callbacks = {
  getTaskWorkspaceLabel: () => "workspace",
  onSelectTask: () => {},
  onCloseTask: () => {},
  onMoveTaskToGroup: () => {},
  onMoveTaskToTop: () => {},
  onStartRenameTask: () => {},
  onArchiveTask: () => {},
  onMarkTaskAsUnread: () => {},
};

const emptyGroups: Parameters<typeof GroupedTaskItem>[0]["groups"] = [];

function itemElement(active: boolean) {
  return createElement(GroupedTaskItem, {
    task,
    groups: emptyGroups,
    activeWorkspacePath: "/workspace",
    workspaceLabel: "workspace",
    active,
    ...callbacks,
  });
}

afterEach(() => {
  rowRenders.length = 0;
});

describe("grouped task item memo boundary", () => {
  it("等值 props 复用 memo；只有 active 变化的那一行重新渲染", () => {
    const view = render(itemElement(false));
    expect(rowRenders).toEqual([{ taskId: "t1", active: false }]);

    rowRenders.length = 0;
    view.rerender(itemElement(false));
    expect(rowRenders).toEqual([]);

    rowRenders.length = 0;
    view.rerender(itemElement(true));
    expect(rowRenders).toEqual([{ taskId: "t1", active: true }]);
  });
});
