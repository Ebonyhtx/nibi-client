import { createElement } from "react";
import { expect, it } from "vitest";
import type { NibiTaskMeta } from "@nibi/shared";
import { exampleTaskRowHoverProps } from "./contract.example.js";
import { formatTaskRowChangeParts, resolveTaskRowWorkspaceLabel } from "./presentation.js";

function task(overrides: Partial<NibiTaskMeta> = {}): NibiTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Task",
    workspacePath: "/workspace/project",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    ...overrides,
  };
}

it("标准示例从 workspacePath 派生行名并原样传递任务与行元素", () => {
  const row = createElement("button", { type: "button" }, "row");
  const props = exampleTaskRowHoverProps(task({ workspacePath: "C:\\workspace\\project" }), row);
  expect(props.workspaceLabel).toBe("project");
  expect(props.task.workspacePath).toBe("C:\\workspace\\project");
  expect(props.children).toBe(row);
});

it("标题优先使用行内工作区名，为空时回退到路径叶子且不伪造 worktree 标签", () => {
  expect(resolveTaskRowWorkspaceLabel(task(), "Workspace label")).toBe("Workspace label");
  expect(resolveTaskRowWorkspaceLabel(task(), "   ")).toBe("project");
  expect(
    resolveTaskRowWorkspaceLabel(task({ workspacePath: "C:\\nibi\\worktrees\\787b\\project" }), ""),
  ).toBe("project");
});

it("变更统计只输出非零的 +N/-N，与行内口径一致", () => {
  expect(formatTaskRowChangeParts(null)).toEqual([]);
  expect(
    formatTaskRowChangeParts({
      fileCount: 2,
      added: 12,
      removed: 0,
      files: [],
    }),
  ).toEqual(["+12"]);
  expect(
    formatTaskRowChangeParts({
      fileCount: 2,
      added: 0,
      removed: 3,
      files: [],
    }),
  ).toEqual(["-3"]);
  expect(
    formatTaskRowChangeParts({
      fileCount: 2,
      added: 12,
      removed: 3,
      files: [],
    }),
  ).toEqual(["+12", "-3"]);
});
